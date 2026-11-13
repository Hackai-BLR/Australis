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
import { dockerDisponible, limpiarPrefijo, registrarPrefijo } from './lib/docker.ts';
import { PLANTILLA, SDK, prepararPlantillaEspia } from './lib/plantilla.ts';

export const SEMILLA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'datos.json');

export const OWNER = 'equipo@campusia.prueba';
export const ADMIN_AUSTRAL = 'ana.morales@austral.edu.ar';
export const PROFE_AUSTRAL = 'lfernandez@austral.edu.ar';
export const PROFE2_AUSTRAL = 'dherrera@austral.edu.ar';
export const PROFE3_AUSTRAL = 'mruiz@austral.edu.ar';
export const ALUMNO_AUSTRAL = 'tgarcia@mail.austral.edu.ar';
export const ALUMNA2_AUSTRAL = 'slopez@mail.austral.edu.ar';
export const SIN_MARCA_AUSTRAL = 'psinmarca@austral.edu.ar';
export const PENDIENTE_AUSTRAL = 'cpendiente@austral.edu.ar';
export const ADMIN_DEMO = 'admin@demo.edu.ar';
export const PROFE_DEMO = 'profe@demo.edu.ar';
export const ALUMNO_DEMO = 'alumno@demo.edu.ar';

export interface OpcionesCursos {
  espia?: boolean;
  inactividadSeg?: number;
  entorno?: Record<string, string>;
}

export interface NucleoCursos extends Nucleo {
  prefijo: string;
  raizCursos: string;
  puertoApiCursos: number;
  plantilla: string;
}

type FixturesDePrueba = {
  cliente: () => Cliente;
  contextoNuevo: (ip?: string) => Promise<BrowserContext>;
  paginaComo: (cliente: Cliente | null) => Promise<Page>;
};

type FixturesDeWorker = {
  opcionesCursos: OpcionesCursos;
  nucleo: NucleoCursos;
};

export async function levantarNucleoCursos(op: OpcionesCursos): Promise<NucleoCursos> {
  if (!dockerDisponible()) throw new Error('Docker no está disponible: las pruebas de la fase 2 lo necesitan');
  const prefijo = `cia${crypto.randomBytes(4).toString('hex')}`;
  registrarPrefijo(prefijo);
  const raizCursos = fs.mkdtempSync(path.join(os.tmpdir(), 'campusia-cursos-'));
  const plantilla = op.espia ? prepararPlantillaEspia() : PLANTILLA;
  const puertoApiCursos = await puertoLibre();
  const entorno: Record<string, string> = {
    PROVEEDOR_CONTENEDORES: 'docker',
    CONTENEDORES_CLI: 'docker',
    PREFIJO_CONTENEDORES: prefijo,
    RAIZ_CURSOS: raizCursos,
    PLANTILLA_CURSO_DIR: plantilla,
    SDK_DIR: SDK,
    PUERTO_API_CURSOS: String(puertoApiCursos),
    REVISION_INACTIVIDAD_SEG: '1',
    ARRANQUE_CURSO_SEG: '60',
    ...(op.inactividadSeg ? { INACTIVIDAD_SEG: String(op.inactividadSeg) } : {}),
    ...(op.entorno ?? {}),
  };
  let n: Nucleo;
  try {
    n = await levantarNucleo({ semilla: SEMILLA, owner: OWNER, entorno });
  } catch (e) {
    limpiarPrefijo(prefijo);
    throw e;
  }
  return Object.assign(n, { prefijo, raizCursos, puertoApiCursos, plantilla });
}

export function crearTestCursos(porDefecto: OpcionesCursos = {}) {
  return base.extend<FixturesDePrueba, FixturesDeWorker>({
    opcionesCursos: [porDefecto, { scope: 'worker', option: true }],
    nucleo: [
      async ({ opcionesCursos }, use) => {
        const n = await levantarNucleoCursos(opcionesCursos);
        try {
          await use(n);
        } finally {
          await n.cerrar();
          limpiarPrefijo(n.prefijo);
          fs.rmSync(n.raizCursos, { recursive: true, force: true });
          if (n.plantilla !== PLANTILLA) fs.rmSync(n.plantilla, { recursive: true, force: true });
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
