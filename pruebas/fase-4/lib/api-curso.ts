import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type crypto from 'node:crypto';
import { RAIZ_REPO } from '../../comun/entorno.ts';
import type { Nucleo } from '../../comun/nucleo.ts';
import { firmar, type CargaIdentidad } from '../../fase-2/lib/identidad.ts';

export interface RespuestaApiCurso {
  status: number;
  encabezados: Headers;
  cuerpo: Buffer;
  texto: string;
  json: any;
}

export interface PedidoApiCurso {
  token?: string | null;
  identidad?: string | null;
  cuerpo?: Buffer | string | object;
  tipo?: string;
  encabezados?: Record<string, string>;
}

export async function apiCurso(base: string, metodo: string, ruta: string, p: PedidoApiCurso = {}): Promise<RespuestaApiCurso> {
  const h: Record<string, string> = { accept: 'application/json', ...(p.encabezados ?? {}) };
  if (p.token) h.authorization = `Bearer ${p.token}`;
  if (p.identidad) h['x-campus-identidad'] = p.identidad;
  let body: Uint8Array | string | undefined;
  if (p.cuerpo !== undefined) {
    if (Buffer.isBuffer(p.cuerpo)) {
      body = new Uint8Array(p.cuerpo);
      h['content-type'] = p.tipo ?? 'application/octet-stream';
    } else if (typeof p.cuerpo === 'string') {
      body = p.cuerpo;
      h['content-type'] = p.tipo ?? 'text/plain';
    } else {
      body = JSON.stringify(p.cuerpo);
      h['content-type'] = 'application/json';
    }
  }
  const r = await fetch(`${base}${ruta}`, { method: metodo, headers: h, body: body as any, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  const cuerpo = Buffer.from(await r.arrayBuffer());
  const texto = cuerpo.toString('utf8');
  let json: any = null;
  try {
    json = texto ? JSON.parse(texto) : null;
  } catch {
    json = null;
  }
  return { status: r.status, encabezados: r.headers, cuerpo, texto, json };
}

export interface AjustesIdentidad {
  curso?: string;
  rol?: string;
  usuario?: string;
  emitido?: number;
  vence?: number;
  v?: number;
}

export function identidad(
  nucleo: Nucleo,
  privada: crypto.KeyObject,
  curso: string,
  email: string,
  rol: string,
  ajustes: AjustesIdentidad = {},
): string {
  const f = nucleo.consultar('SELECT id, nombre FROM usuarios WHERE email = ?', email)[0];
  if (!f) throw new Error(`No existe la cuenta ${email}`);
  const ahora = Math.floor(Date.now() / 1000);
  const emitido = ajustes.emitido ?? ahora;
  const carga: CargaIdentidad = {
    v: ajustes.v ?? 1,
    curso: ajustes.curso ?? curso,
    usuario: ajustes.usuario ?? String(f.id),
    email,
    nombre: String(f.nombre),
    rol: ajustes.rol ?? rol,
    emitido,
    vence: ajustes.vence ?? emitido + 60,
  };
  return firmar(carga, privada);
}

export async function cargarSdk(): Promise<any> {
  return import(pathToFileURL(path.join(RAIZ_REPO, 'sdk', 'dist', 'index.js')).href);
}

export function rutaSubidaCurso(nombre: string, material = false) {
  return `/api/curso/archivos?nombre=${encodeURIComponent(nombre)}${material ? '&material=1' : ''}`;
}
