import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  apiDelete,
  apiGet,
  apiPost,
  apiUpload,
  filenameFromDisposition,
  openEventStream,
  setUnauthorizedHandler,
} from "./api";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;
let onUnauthorized: ReturnType<typeof vi.fn>;
let restoreHandler: () => void;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  onUnauthorized = vi.fn();
  restoreHandler = setUnauthorizedHandler(onUnauthorized);
});

afterEach(() => restoreHandler());

async function caught(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    return e as ApiError;
  }
  throw new Error("expected the request to fail");
}

describe("api errors", () => {
  it("reads the message from {error}", async () => {
    fetchMock.mockResolvedValue(jsonResponse(409, { error: "El estudiante ya existe" }));
    const err = await caught(apiPost("/roster", { email: "a@b.c" }));
    expect(err.status).toBe(409);
    expect(err.message).toBe("El estudiante ya existe");
  });

  it("falls back to a Spanish message when the body is not JSON", async () => {
    fetchMock.mockResolvedValue(new Response("<html>Bad Gateway</html>", { status: 502 }));
    const err = await caught(apiGet("/health"));
    expect(err.status).toBe(502);
    expect(err.message).toBe("Error del servidor (502).");
  });

  it("falls back per status when {error} is missing", async () => {
    fetchMock.mockResolvedValue(jsonResponse(429, { detail: "quota" }));
    const err = await caught(apiPost("/ai/shape"));
    expect(err.status).toBe(429);
    expect(err.message).toMatch(/límite de uso/);
  });

  it("maps a network failure to status 0", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const err = await caught(apiGet("/health"));
    expect(err.status).toBe(0);
    expect(err.message).toBe("No se pudo conectar con el servidor.");
  });
});

describe("api success", () => {
  it("returns undefined for 204 No Content", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(apiDelete("/grades/items/3")).resolves.toBeUndefined();
  });

  it("parses JSON and sends JSON bodies under /api", async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { id: 7 }));
    await expect(apiPost<{ id: number }>("/campuses", { name: "Big Data" })).resolves.toEqual({
      id: 7,
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/campuses");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ name: "Big Data" }));
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.credentials).toBe("same-origin");
  });

  it("uploads FormData without forcing a content type", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { imported: 2 }));
    const form = new FormData();
    form.append("file", new Blob(["a,b"]), "alumnos.csv");
    await expect(apiUpload("/roster/import", form)).resolves.toEqual({ imported: 2 });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.body).toBe(form);
    expect(init.headers["Content-Type"]).toBeUndefined();
  });
});

describe("401 handling", () => {
  it("runs the unauthorized handler", async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { error: "unauthorized" }));
    const err = await caught(apiGet("/campuses"));
    expect(err.status).toBe(401);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("skips the handler when asked", async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { error: "unauthorized" }));
    await caught(apiGet("/auth/me", { skipAuthRedirect: true }));
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("does not run it for other errors", async () => {
    fetchMock.mockResolvedValue(jsonResponse(403, { error: "forbidden" }));
    await caught(apiGet("/campuses/1"));
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});

describe("filenameFromDisposition", () => {
  it("reads plain and encoded names", () => {
    expect(filenameFromDisposition('attachment; filename="notas.xlsx"')).toBe("notas.xlsx");
    expect(filenameFromDisposition("attachment; filename*=UTF-8''planilla%20a%C3%B1o.xlsx")).toBe(
      "planilla año.xlsx",
    );
    expect(filenameFromDisposition(null)).toBeNull();
  });
});

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = FakeEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  listeners: Record<string, (e: { data: string }) => void> = {};
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(name: string, fn: (e: { data: string }) => void) {
    this.listeners[name] = fn;
  }
  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }
}

describe("openEventStream", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("parses messages and named events, and reconnects after the browser gives up", () => {
    const onMessage = vi.fn();
    const onSlide = vi.fn();
    const stream = openEventStream("/slides/1/events", {
      onMessage,
      onEvent: { slide: onSlide },
    });
    const first = FakeEventSource.instances[0];
    expect(first.url).toBe("/api/slides/1/events");

    first.onmessage?.({ data: '{"page":3}' });
    first.listeners.slide({ data: "plain" });
    expect(onMessage).toHaveBeenCalledWith({ page: 3 });
    expect(onSlide).toHaveBeenCalledWith("plain");

    // A transient error while the browser retries on its own: no new connection.
    first.readyState = FakeEventSource.CONNECTING;
    first.onerror?.();
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances).toHaveLength(1);

    // The browser gave up: reopen after the backoff.
    first.readyState = FakeEventSource.CLOSED;
    first.onerror?.();
    vi.advanceTimersByTime(999);
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(2);

    stream.close();
    expect(FakeEventSource.instances[1].closed).toBe(true);
    FakeEventSource.instances[1].onerror?.();
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances).toHaveLength(2);
  });
});
