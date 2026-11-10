// Thin fetch wrapper over the backend at /api.
//
// Every helper takes a path relative to /api (e.g. "/campuses/3"). Errors from the backend have the
// shape {"error": "<message>"} and are thrown as ApiError. A 401 on any call (except those that opt
// out with skipAuthRedirect) runs the unauthorized handler, which by default sends the browser to
// /login; AuthProvider replaces it with an in-app redirect.

export const API_BASE = "/api";

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export type RequestOptions = {
  /** Do not run the unauthorized handler on 401 (used by the auth bootstrap and login). */
  skipAuthRedirect?: boolean;
  signal?: AbortSignal;
  headers?: Record<string, string>;
};

type UnauthorizedHandler = () => void;

function defaultUnauthorizedHandler() {
  const { pathname, search } = window.location;
  if (pathname === "/login") return;
  const next = encodeURIComponent(pathname + search);
  window.location.assign(`/login?next=${next}`);
}

let onUnauthorized: UnauthorizedHandler = defaultUnauthorizedHandler;

/** Replaces the 401 handler; returns a function that restores the default. */
export function setUnauthorizedHandler(handler: UnauthorizedHandler): () => void {
  onUnauthorized = handler;
  return () => {
    if (onUnauthorized === handler) onUnauthorized = defaultUnauthorizedHandler;
  };
}

const FALLBACK_MESSAGES: Record<number, string> = {
  0: "No se pudo conectar con el servidor.",
  400: "La solicitud no es válida.",
  401: "Tu sesión expiró. Volvé a iniciar sesión.",
  403: "No tenés permiso para hacer esto.",
  404: "No se encontró lo que buscabas.",
  409: "La operación entra en conflicto con datos existentes.",
  413: "El archivo es demasiado grande.",
  422: "Los datos enviados no son válidos.",
  429: "Alcanzaste el límite de uso. Probá más tarde.",
};

function fallbackMessage(status: number): string {
  return FALLBACK_MESSAGES[status] ?? `Error del servidor (${status}).`;
}

/** Builds an ApiError from a failed response, reading {"error": "..."} when present. */
export async function parseError(res: Response): Promise<ApiError> {
  let message = "";
  try {
    const text = await res.text();
    if (text) {
      try {
        const body: unknown = JSON.parse(text);
        if (body && typeof body === "object" && "error" in body) {
          const error = (body as { error: unknown }).error;
          if (typeof error === "string") message = error;
        }
      } catch {
        // Not JSON (e.g. an nginx error page): fall back to the status message.
      }
    }
  } catch {
    // Body could not be read.
  }
  return new ApiError(res.status, message || fallbackMessage(res.status));
}

async function send(
  method: string,
  path: string,
  body: BodyInit | undefined,
  contentType: string | undefined,
  options: RequestOptions,
): Promise<Response> {
  const headers: Record<string, string> = { Accept: "application/json", ...options.headers };
  if (contentType) headers["Content-Type"] = contentType;

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      body,
      headers,
      credentials: "same-origin",
      signal: options.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError(0, fallbackMessage(0));
  }

  if (!res.ok) {
    const error = await parseError(res);
    if (res.status === 401 && !options.skipAuthRedirect) onUnauthorized();
    throw error;
  }
  return res;
}

async function readBody<T>(res: Response): Promise<T> {
  if (res.status === 204 || res.status === 205) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  const type = res.headers.get("Content-Type") ?? "";
  if (type.includes("json")) return JSON.parse(text) as T;
  return text as T;
}

function jsonRequest<T>(method: string, path: string, data: unknown, options: RequestOptions) {
  const hasBody = data !== undefined;
  return send(
    method,
    path,
    hasBody ? JSON.stringify(data) : undefined,
    hasBody ? "application/json" : undefined,
    options,
  ).then((res) => readBody<T>(res));
}

export function apiGet<T>(path: string, options: RequestOptions = {}): Promise<T> {
  return jsonRequest<T>("GET", path, undefined, options);
}

export function apiPost<T = void>(path: string, data?: unknown, options: RequestOptions = {}) {
  return jsonRequest<T>("POST", path, data, options);
}

export function apiPut<T = void>(path: string, data?: unknown, options: RequestOptions = {}) {
  return jsonRequest<T>("PUT", path, data, options);
}

export function apiPatch<T = void>(path: string, data?: unknown, options: RequestOptions = {}) {
  return jsonRequest<T>("PATCH", path, data, options);
}

export function apiDelete<T = void>(path: string, options: RequestOptions = {}) {
  return jsonRequest<T>("DELETE", path, undefined, options);
}

/** Sends multipart form data (files). The browser sets the multipart boundary itself. */
export function apiUpload<T>(path: string, form: FormData, options: RequestOptions = {}) {
  return send("POST", path, form, undefined, options).then((res) => readBody<T>(res));
}

/** Reads the file name from a Content-Disposition header, if any. */
export function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
    } catch {
      // Malformed encoding: try the plain filename.
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain ? plain[1].trim() : null;
}

/** Downloads a file (e.g. an Excel export) and asks the browser to save it. */
export async function apiDownload(
  path: string,
  fallbackName = "descarga",
  options: RequestOptions = {},
): Promise<void> {
  const res = await send("GET", path, undefined, undefined, {
    ...options,
    headers: { Accept: "*/*", ...options.headers },
  });
  const blob = await res.blob();
  const name = filenameFromDisposition(res.headers.get("Content-Disposition")) ?? fallbackName;
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

export type EventStreamHandlers = {
  /** Called for unnamed ("message") events with the parsed JSON data (or raw text). */
  onMessage?: (data: unknown) => void;
  /** Called for named events (the SSE "event:" field). */
  onEvent?: Record<string, (data: unknown) => void>;
  onOpen?: () => void;
  /** Called on every connection error; the stream keeps reconnecting until closed. */
  onError?: () => void;
};

export type EventStream = { close: () => void };

function parseData(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Opens a server-sent event stream at /api<path>. EventSource retries on its own while the
 * connection is merely interrupted; when the browser gives up (readyState CLOSED, e.g. after an
 * HTTP error), this reopens it with exponential backoff (1 s up to 30 s) until close() is called.
 */
export function openEventStream(path: string, handlers: EventStreamHandlers): EventStream {
  let source: EventSource | null = null;
  let closed = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let delay = 1000;

  const connect = () => {
    if (closed) return;
    const es = new EventSource(`${API_BASE}${path}`);
    source = es;
    es.onopen = () => {
      delay = 1000;
      handlers.onOpen?.();
    };
    es.onmessage = (e: MessageEvent<string>) => handlers.onMessage?.(parseData(e.data));
    for (const [name, handler] of Object.entries(handlers.onEvent ?? {})) {
      es.addEventListener(name, (e) => handler(parseData((e as MessageEvent<string>).data)));
    }
    es.onerror = () => {
      handlers.onError?.();
      if (closed || es.readyState !== EventSource.CLOSED) return;
      es.close();
      retryTimer = setTimeout(connect, delay);
      delay = Math.min(delay * 2, 30_000);
    };
  };

  connect();

  return {
    close: () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      source?.close();
    },
  };
}
