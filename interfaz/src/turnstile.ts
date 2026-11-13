declare global {
  interface Window {
    turnstile?: {
      render: (el: string | HTMLElement, op: Record<string, unknown>) => string;
      reset: (id?: string) => void;
      remove: (id?: string) => void;
      getResponse?: (id?: string) => string | undefined;
    };
  }
}

const URL_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

let carga: Promise<void> | null = null;

function api() {
  const t = window.turnstile;
  return t && typeof t.render === 'function' ? t : null;
}
let widget: string | null = null;
let nodoWidget: HTMLElement | null = null;
let token: string | null = null;
let esperando: ((t: string) => void)[] = [];

function cargarScript(): Promise<void> {
  if (api()) return Promise.resolve();
  if (carga) return carga;
  carga = new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = URL_SCRIPT;
    s.async = true;
    s.onload = () => {
      const limite = Date.now() + 10000;
      const mirar = () => {
        if (api()) resolve();
        else if (Date.now() > limite) reject(new Error('turnstile'));
        else setTimeout(mirar, 50);
      };
      mirar();
    };
    s.onerror = () => {
      carga = null;
      s.remove();
      reject(new Error('turnstile'));
    };
    document.head.appendChild(s);
  });
  return carga;
}

function recibir(t: string) {
  token = t;
  const pendientes = esperando;
  esperando = [];
  pendientes.forEach((f) => f(t));
}

function consumir(t: string): string {
  token = null;
  const ts = api();
  if (widget !== null && ts) {
    try {
      ts.reset(widget);
    } catch {
      widget = null;
    }
  }
  return t;
}

function respuestaActual(): string | null {
  if (token) return token;
  const t = api();
  if (widget === null || !t?.getResponse) return null;
  try {
    return t.getResponse(widget) || null;
  } catch {
    return null;
  }
}

function widgetVigente() {
  return widget !== null && nodoWidget !== null && nodoWidget.isConnected;
}

export function hayWidget() {
  return widgetVigente() && nodoWidget === document.getElementById('turnstile');
}

export function tomarToken(): string | undefined {
  if (!widgetVigente()) return undefined;
  const t = respuestaActual();
  return t ? consumir(t) : undefined;
}

export async function mostrarWidget(siteKey: string): Promise<void> {
  await cargarScript();
  const nodo = document.getElementById('turnstile');
  const t = api();
  if (!nodo || !t) throw new Error('turnstile');
  if (!widgetVigente() || nodoWidget !== nodo) {
    token = null;
    nodoWidget = nodo;
    widget = t.render('#turnstile', {
      sitekey: siteKey,
      callback: recibir,
      'expired-callback': () => {
        token = null;
      },
      language: 'es',
    });
  }
}

export async function esperarToken(siteKey: string): Promise<string> {
  await mostrarWidget(siteKey);
  const actual = respuestaActual();
  if (actual) return consumir(actual);
  return new Promise<string>((resolve) => {
    esperando.push((r) => resolve(consumir(r)));
  });
}
