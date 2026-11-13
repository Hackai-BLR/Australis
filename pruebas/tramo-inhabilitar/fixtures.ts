import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, type BrowserContext, type Page } from '@playwright/test';
import { Cliente, ipAleatoria } from '../comun/http.ts';
import { levantarNucleo, type Nucleo } from '../comun/nucleo.ts';
import { COOKIE_SESION, DOMINIO } from '../comun/entorno.ts';
import { SCRIPT_TURNSTILE_FALSO } from '../comun/fixtures.ts';
import { puertoLibre } from '../comun/servicios-falsos.ts';
import { dockerDisponible, limpiarPrefijo, registrarPrefijo } from '../fase-2/lib/docker.ts';
import { PLANTILLA, SDK } from '../fase-2/lib/plantilla.ts';

export const SEMILLA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'datos.json');

export const OWNER = 'equipo@campusia.prueba';
export const OWNER_AUSTRAL = 'rectora@austral.edu.ar';
export const ADMIN_AUSTRAL = 'ana.morales@austral.edu.ar';
export const ADMIN2_AUSTRAL = 'radmin@austral.edu.ar';
export const PROFE_AUSTRAL = 'lfernandez@austral.edu.ar';
export const PROFE2_AUSTRAL = 'dherrera@austral.edu.ar';
export const PROFE3_AUSTRAL = 'mruiz@austral.edu.ar';
export const ALUMNO_AUSTRAL = 'tgarcia@mail.austral.edu.ar';
export const SIN_MARCA_AUSTRAL = 'psinmarca@austral.edu.ar';
export const PENDIENTE_AUSTRAL = 'cpendiente@austral.edu.ar';
export const ADMIN_DEMO = 'admin@demo.edu.ar';
export const PROFE_DEMO = 'profe@demo.edu.ar';
export const ALUMNO_DEMO = 'alumno@demo.edu.ar';

export interface OpcionesTramo {
  docker?: boolean;
  entorno?: Record<string, string>;
}

export interface NucleoTramo extends Nucleo {
  prefijo: string | null;
  raizCursos: string | null;
}

type FixturesDePrueba = {
  cliente: () => Cliente;
  contextoNuevo: (ip?: string) => Promise<BrowserContext>;
  paginaComo: (cliente: Cliente | null) => Promise<Page>;
};

type FixturesDeWorker = {
  opcionesTramo: OpcionesTramo;
  nucleo: NucleoTramo;
};

export async function levantarNucleoTramo(op: OpcionesTramo): Promise<NucleoTramo> {
  if (!op.docker) {
    const n = await levantarNucleo({ semilla: SEMILLA, owner: OWNER, entorno: op.entorno });
    return Object.assign(n, { prefijo: null, raizCursos: null });
  }
  if (!dockerDisponible()) throw new Error('Docker no está disponible: estas pruebas lo necesitan');
  const prefijo = `cia${crypto.randomBytes(4).toString('hex')}`;
  registrarPrefijo(prefijo);
  const raizCursos = fs.mkdtempSync(path.join(os.tmpdir(), 'campusia-cursos-'));
  const puertoApiCursos = await puertoLibre();
  const entorno: Record<string, string> = {
    PROVEEDOR_CONTENEDORES: 'docker',
    CONTENEDORES_CLI: 'docker',
    PREFIJO_CONTENEDORES: prefijo,
    RAIZ_CURSOS: raizCursos,
    PLANTILLA_CURSO_DIR: PLANTILLA,
    SDK_DIR: SDK,
    PUERTO_API_CURSOS: String(puertoApiCursos),
    REVISION_INACTIVIDAD_SEG: '1',
    ARRANQUE_CURSO_SEG: '60',
    ...(op.entorno ?? {}),
  };
  let n: Nucleo;
  try {
    n = await levantarNucleo({ semilla: SEMILLA, owner: OWNER, entorno });
  } catch (e) {
    limpiarPrefijo(prefijo);
    throw e;
  }
  return Object.assign(n, { prefijo, raizCursos });
}

export function crearTestTramo(porDefecto: OpcionesTramo = {}) {
  return base.extend<FixturesDePrueba, FixturesDeWorker>({
    opcionesTramo: [porDefecto, { scope: 'worker', option: true }],
    nucleo: [
      async ({ opcionesTramo }, use) => {
        const n = await levantarNucleoTramo(opcionesTramo);
        try {
          await use(n);
        } finally {
          await n.cerrar();
          if (n.prefijo) limpiarPrefijo(n.prefijo);
          if (n.raizCursos) fs.rmSync(n.raizCursos, { recursive: true, force: true });
        }
      },
      { scope: 'worker', timeout: 300_000 },
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
