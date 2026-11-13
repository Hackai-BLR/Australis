import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test as base, type BrowserContext, type Page } from '@playwright/test';
import { Cliente, ipAleatoria } from '../comun/http.ts';
import { COOKIE_SESION, DOMINIO } from '../comun/entorno.ts';
import { SCRIPT_TURNSTILE_FALSO } from '../comun/fixtures.ts';
import { puertoLibre } from '../comun/servicios-falsos.ts';
import { levantarNucleoCursos, type NucleoCursos } from '../fase-2/fixtures.ts';
import { dockerDisponible, limpiarPrefijo } from '../fase-2/lib/docker.ts';
import { PLANTILLA } from '../fase-2/lib/plantilla.ts';
import { ejecutarSql } from '../fase-2/lib/cursos.ts';
import { asegurarImagenEspacio } from './lib/imagen.ts';
import { levantarModeloFalso, type ModeloFalso } from './lib/modelo-falso.ts';

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

export const PRECIOS = {
  'claude-haiku-5-5': { entrada: 10, salida: 50, cache_creacion: 12.5, cache_lectura: 1 },
  'claude-haiku': { entrada: 7, salida: 7, cache_creacion: 7, cache_lectura: 7 },
  '*': { entrada: 3, salida: 15, cache_creacion: 3.75, cache_lectura: 0.3 },
};

export const LIMITE_AUSTRAL = 1000;

export interface OpcionesAgente {
  espia?: boolean;
  proveedor?: 'suscripcion' | 'api';
  inactividadEspacioSeg?: number;
  entorno?: Record<string, string>;
}

export interface NucleoAgente extends NucleoCursos {
  modelo: ModeloFalso;
  tokenReal: string;
  raizEspacios: string;
  imagenEspacio: string;
  puertoEspacios: number;
  puertoProxy: number;
  proveedor: 'suscripcion' | 'api';
}

function borrarCarpeta(dir: string) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    spawnSync('docker', ['run', '--rm', '-v', `${dir}:/borrar`, 'alpine:latest', 'sh', '-c', 'rm -rf /borrar/* /borrar/.[!.]* 2>/dev/null; true'], {
      timeout: 120_000,
    });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function levantarNucleoAgente(op: OpcionesAgente): Promise<NucleoAgente> {
  if (!dockerDisponible()) throw new Error('Docker no está disponible: las pruebas de la fase 3 lo necesitan');
  const imagenEspacio = await asegurarImagenEspacio();
  const proveedor = op.proveedor ?? 'suscripcion';
  const tokenReal =
    proveedor === 'suscripcion'
      ? `sk-ant-oat01-PRUEBA-${crypto.randomBytes(24).toString('base64url')}`
      : `sk-ant-api03-PRUEBA-${crypto.randomBytes(24).toString('base64url')}`;
  const modelo = await levantarModeloFalso(
    proveedor === 'suscripcion'
      ? { tipo: 'bearer', valor: tokenReal, beta: 'oauth-2025-04-20' }
      : { tipo: 'x-api-key', valor: tokenReal, beta: null },
  );
  const raizEspacios = fs.mkdtempSync(path.join(os.tmpdir(), 'campusia-espacios-'));
  const archivoPrecios = path.join(raizEspacios, '..', `campusia-precios-${crypto.randomBytes(4).toString('hex')}.json`);
  fs.writeFileSync(archivoPrecios, JSON.stringify(PRECIOS));
  const puertoEspacios = await puertoLibre();
  let puertoProxy = await puertoLibre();
  while (puertoProxy === puertoEspacios) puertoProxy = await puertoLibre();
  const entorno: Record<string, string> = {
    PROVEEDOR_MODELO: proveedor,
    MODELO_DESTINO: modelo.url,
    MODELO_AGENTE: 'haiku',
    PRECIOS_MODELO_ARCHIVO: archivoPrecios,
    ESPACIO_IMAGEN: imagenEspacio,
    RAIZ_ESPACIOS: raizEspacios,
    PUERTO_ESPACIOS: String(puertoEspacios),
    PUERTO_PROXY_SALIDA: String(puertoProxy),
    INACTIVIDAD_ESPACIO_SEG: String(op.inactividadEspacioSeg ?? 3600),
    ESPERA_PRUEBA_SEG: '5',
    ...(proveedor === 'suscripcion' ? { CLAUDE_CODE_OAUTH_TOKEN: tokenReal } : { ANTHROPIC_API_KEY: tokenReal }),
    ...(op.entorno ?? {}),
  };
  let n: NucleoCursos;
  try {
    n = await levantarNucleoCursos({ espia: op.espia, entorno });
  } catch (e) {
    await modelo.cerrar();
    borrarCarpeta(raizEspacios);
    fs.rmSync(archivoPrecios, { force: true });
    throw e;
  }
  ejecutarSql(n, "UPDATE universidades SET limite_usd = ? WHERE nombre = 'Universidad Austral'", LIMITE_AUSTRAL);
  return Object.assign(n, { modelo, tokenReal, raizEspacios, imagenEspacio, puertoEspacios, puertoProxy, proveedor, archivoPrecios });
}

type FixturesDePrueba = {
  cliente: () => Cliente;
  contextoNuevo: (ip?: string) => Promise<BrowserContext>;
  paginaComo: (cliente: Cliente | null) => Promise<Page>;
};

type FixturesDeWorker = {
  opcionesAgente: OpcionesAgente;
  nucleo: NucleoAgente;
};

export const TIEMPO_FASE3 = 2_400_000;

export function crearTestAgente(porDefecto: OpcionesAgente = {}) {
  return base.extend<FixturesDePrueba, FixturesDeWorker>({
    opcionesAgente: [porDefecto, { scope: 'worker', option: true }],
    nucleo: [
      async ({ opcionesAgente }, use) => {
        const n = await levantarNucleoAgente(opcionesAgente);
        try {
          await use(n);
        } finally {
          await n.cerrar();
          limpiarPrefijo(n.prefijo);
          await n.modelo.cerrar();
          borrarCarpeta(n.raizCursos);
          borrarCarpeta(n.raizEspacios);
          fs.rmSync((n as any).archivoPrecios, { force: true });
          if (n.plantilla !== PLANTILLA) fs.rmSync(n.plantilla, { recursive: true, force: true });
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
