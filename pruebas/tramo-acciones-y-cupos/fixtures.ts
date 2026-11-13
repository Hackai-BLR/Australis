import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test as base, type BrowserContext, type Page } from '@playwright/test';
import { Cliente, ipAleatoria } from '../comun/http.ts';
import { COOKIE_SESION, DOMINIO } from '../comun/entorno.ts';
import { SCRIPT_TURNSTILE_FALSO } from '../comun/fixtures.ts';
import { limpiarPrefijo } from '../fase-2/lib/docker.ts';
import { PLANTILLA } from '../fase-2/lib/plantilla.ts';
import { crearTestAgente, levantarNucleoAgente, TIEMPO_FASE3, type NucleoAgente, type OpcionesAgente } from '../fase-3/fixtures.ts';
import { crearTestTramo } from '../tramo-inhabilitar/fixtures.ts';

export { crearTestAgente, TIEMPO_FASE3, type NucleoAgente };
export { crearTestTramo as crearTestSinDocker };
export {
  OWNER,
  ADMIN_AUSTRAL,
  PROFE_AUSTRAL,
  PROFE2_AUSTRAL,
  PROFE3_AUSTRAL,
  ALUMNO_AUSTRAL,
  ALUMNA2_AUSTRAL,
  SIN_MARCA_AUSTRAL,
  ADMIN_DEMO,
  PROFE_DEMO,
  ALUMNO_DEMO,
} from '../fase-2/fixtures.ts';
export { OWNER_AUSTRAL, ADMIN2_AUSTRAL, PENDIENTE_AUSTRAL } from '../tramo-inhabilitar/fixtures.ts';

export const TOKENS_POR_RESPUESTA = 1000 + 2000 + 400 + 2000;

export const ENTORNO_TRAMO: Record<string, string> = {
  RESERVA_TOKENS_PEDIDO: String(TOKENS_POR_RESPUESTA),
  ESPERA_SIN_USO_SEG: '600',
};

export function crearTestAcciones(op: OpcionesAgente = {}) {
  return crearTestAgente({ ...op, entorno: { ...ENTORNO_TRAMO, ...(op.entorno ?? {}) } });
}

export interface DestinoConmutable {
  url: string;
  destino: string;
  agotado: boolean;
  retryAfter: number | null;
  rechazados: number;
  cerrar(): Promise<void>;
}

export async function levantarDestinoConmutable(): Promise<DestinoConmutable> {
  const d: DestinoConmutable = { url: '', destino: '', agotado: false, retryAfter: null, rechazados: 0, cerrar: async () => {} };
  const servidor = http.createServer((req, res) => {
    const partes: Buffer[] = [];
    req.on('data', (p) => partes.push(p));
    req.on('end', () => {
      if (d.agotado) {
        d.rechazados++;
        const enc: Record<string, string> = { 'content-type': 'application/json', 'anthropic-ratelimit-unified-status': 'rejected' };
        if (d.retryAfter !== null) enc['retry-after'] = String(d.retryAfter);
        res.writeHead(429, enc);
        res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Usage limit reached for this subscription' } }));
        return;
      }
      const u = new URL(d.destino);
      const encabezados = { ...req.headers, host: u.host };
      const salida = http.request(
        { host: u.hostname, port: Number(u.port), path: req.url, method: req.method, headers: encabezados },
        (r) => {
          res.writeHead(r.statusCode ?? 502, r.headers);
          r.pipe(res);
        },
      );
      salida.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      salida.end(Buffer.concat(partes));
    });
  });
  await new Promise<void>((resolve) => servidor.listen(0, '127.0.0.1', () => resolve()));
  d.url = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
  d.cerrar = () =>
    new Promise<void>((resolve) => {
      servidor.closeAllConnections?.();
      servidor.close(() => resolve());
    });
  return d;
}

export interface NucleoConDestino extends NucleoAgente {
  conmutable: DestinoConmutable;
}

type FixturesDePrueba = {
  cliente: () => Cliente;
  contextoNuevo: (ip?: string) => Promise<BrowserContext>;
  paginaComo: (cliente: Cliente | null) => Promise<Page>;
};

type FixturesDeWorker = {
  nucleo: NucleoConDestino;
};

function borrar(dir: string) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

export function crearTestConDestino(op: OpcionesAgente = {}) {
  return base.extend<FixturesDePrueba, FixturesDeWorker>({
    nucleo: [
      async ({}, use) => {
        const conmutable = await levantarDestinoConmutable();
        let n: NucleoAgente;
        try {
          n = await levantarNucleoAgente({ ...op, entorno: { ...ENTORNO_TRAMO, ...(op.entorno ?? {}), MODELO_DESTINO: conmutable.url } });
        } catch (e) {
          await conmutable.cerrar();
          throw e;
        }
        conmutable.destino = n.modelo.url;
        try {
          await use(Object.assign(n, { conmutable }));
        } finally {
          await n.cerrar();
          limpiarPrefijo(n.prefijo);
          await n.modelo.cerrar();
          await conmutable.cerrar();
          borrar(n.raizCursos);
          borrar(n.raizEspacios);
          fs.rmSync((n as any).archivoPrecios, { force: true });
          if (n.plantilla !== PLANTILLA) borrar(n.plantilla);
        }
      },
      { scope: 'worker', timeout: 1_800_000 },
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
