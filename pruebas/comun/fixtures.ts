import { test as base, type Page, type BrowserContext } from '@playwright/test';
import { Cliente, ipAleatoria } from './http.ts';
import { levantarNucleo, type Nucleo, type OpcionesNucleo } from './nucleo.ts';
import { COOKIE_SESION, DOMINIO } from './entorno.ts';
import { TURNSTILE_TOKEN_VALIDO } from './servicios-falsos.ts';

export const SCRIPT_TURNSTILE_FALSO = `
(function(){
  var src = (document.currentScript && document.currentScript.src) || '';
  var onload = null;
  try { onload = new URL(src).searchParams.get('onload'); } catch (e) {}
  window.__turnstileRenderizado = 0;
  window.turnstile = {
    render: function(el, op){
      window.__turnstileRenderizado++;
      var nodo = typeof el === 'string' ? document.querySelector(el) : el;
      if (nodo) { nodo.setAttribute('data-turnstile-falso', '1'); }
      setTimeout(function(){ if (op && op.callback) op.callback('${TURNSTILE_TOKEN_VALIDO}'); }, 50);
      return 'widget-falso';
    },
    reset: function(){}, remove: function(){}, getResponse: function(){ return '${TURNSTILE_TOKEN_VALIDO}'; },
    ready: function(f){ f(); }, execute: function(){}
  };
  if (onload && typeof window[onload] === 'function') { window[onload](); }
})();
`;

type FixturesDePrueba = {
  cliente: () => Cliente;
  contextoNuevo: (ip?: string) => Promise<BrowserContext>;
  paginaComo: (cliente: Cliente | null) => Promise<Page>;
};

type FixturesDeWorker = {
  opcionesNucleo: OpcionesNucleo;
  nucleo: Nucleo;
};

export function crearTest(porDefecto: OpcionesNucleo) {
  return base.extend<FixturesDePrueba, FixturesDeWorker>({
  opcionesNucleo: [porDefecto, { scope: 'worker', option: true }],
  nucleo: [
    async ({ opcionesNucleo }, use) => {
      const n = await levantarNucleo(opcionesNucleo);
      await use(n);
      await n.cerrar();
    },
    { scope: 'worker', timeout: 120_000 },
  ],
  cliente: async ({ nucleo }, use) => {
    await use(() => new Cliente(nucleo));
  },
  contextoNuevo: async ({ browser }, use) => {
    const contextos: BrowserContext[] = [];
    await use(async (ip?: string) => {
      const ctx = await browser.newContext({ extraHTTPHeaders: { 'CF-Connecting-IP': ip ?? ipAleatoria() } });
      await ctx.route('https://challenges.cloudflare.com/turnstile/**', (route) =>
        route.fulfill({ status: 200, contentType: 'application/javascript', body: SCRIPT_TURNSTILE_FALSO }),
      );
      contextos.push(ctx);
      return ctx;
    });
    for (const c of contextos) await c.close();
  },
  paginaComo: async ({ contextoNuevo }, use) => {
    await use(async (cliente) => {
      const ctx = await contextoNuevo();
      if (cliente?.sesion) {
        await ctx.addCookies([{ name: COOKIE_SESION, value: cliente.sesion, domain: `.${DOMINIO}`, path: '/', httpOnly: true, sameSite: 'Lax' }]);
      }
      return ctx.newPage();
    });
  },
  });
}

export { expect } from '@playwright/test';
