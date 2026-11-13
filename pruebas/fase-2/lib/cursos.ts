import crypto from 'node:crypto';
import fs from 'node:fs';
import { expect } from '@playwright/test';
import { Cliente, type OpcionesPedido, type Respuesta } from '../../comun/http.ts';
import type { Nucleo } from '../../comun/nucleo.ts';
import { entrar } from '../../comun/sesion.ts';
import { entornoDe, nombreContenedor } from './docker.ts';

export const ESPERA_LISTO_MS = 480_000;
export const TIEMPO_PRUEBA_DOCKER = 900_000;

export function idAleatorio(prefijo = 'c') {
  return `${prefijo}-${crypto.randomBytes(4).toString('hex')}`;
}

export async function sesion(nucleo: Nucleo, email: string): Promise<Cliente> {
  const c = new Cliente(nucleo);
  await entrar(c, email);
  return c;
}

export function idUsuario(nucleo: Nucleo, email: string): number {
  const f = nucleo.consultar('SELECT id FROM usuarios WHERE email = ?', email)[0];
  if (!f) throw new Error(`No existe la cuenta ${email}`);
  return Number(f.id);
}

export function ejecutarSql(nucleo: Nucleo, sql: string, ...params: any[]) {
  const db = nucleo.base();
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

export interface DatosCurso {
  id?: string;
  nombre?: string;
  periodo?: string;
}

export async function crearCurso(c: Cliente, datos: DatosCurso = {}, op?: OpcionesPedido): Promise<Respuesta> {
  const id = datos.id ?? idAleatorio();
  return c.post(
    '/api/cursos',
    { nombre: datos.nombre ?? `Curso ${id}`, subdominio: id, periodo: datos.periodo ?? '2.º cuatrimestre 2026' },
    op,
  );
}

function registro(nucleo: Nucleo) {
  return fs.existsSync(nucleo.archivoRegistro) ? fs.readFileSync(nucleo.archivoRegistro, 'utf8').slice(-4000) : '';
}

export async function esperarListo(c: Cliente, id: string, ms = ESPERA_LISTO_MS): Promise<any> {
  const limite = Date.now() + ms;
  let ultimo: any = null;
  while (Date.now() < limite) {
    const r = await c.get(`/api/cursos/${id}`);
    ultimo = r.json;
    if (r.status === 200 && r.json?.estado === 'listo') return r.json;
    if (r.status === 200 && r.json?.estado === 'error') {
      throw new Error(`El curso ${id} quedó en error.\n${registro(c.nucleo)}`);
    }
    if (r.status !== 200) throw new Error(`GET /api/cursos/${id} respondió ${r.status}: ${r.texto}`);
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error(`El curso ${id} no quedó listo a tiempo (último: ${JSON.stringify(ultimo)}).\n${registro(c.nucleo)}`);
}

export async function cursoListo(c: Cliente, datos: DatosCurso = {}): Promise<string> {
  const id = datos.id ?? idAleatorio();
  const r = await crearCurso(c, { ...datos, id });
  expect(r.status, `crear curso ${id}: ${r.texto}`).toBe(201);
  await esperarListo(c, id);
  return id;
}

export async function inscribir(c: Cliente, id: string, emails: string[], rol: 'alumno' | 'profesor' = 'alumno'): Promise<Respuesta> {
  return c.post(`/api/cursos/${id}/inscriptos`, { emails, rol });
}

export async function inscribirOk(c: Cliente, id: string, emails: string[], rol: 'alumno' | 'profesor' = 'alumno') {
  const r = await inscribir(c, id, emails, rol);
  expect(r.status, `inscribir ${emails.join(',')} como ${rol}: ${r.texto}`).toBe(200);
  return r.json;
}

export function enCurso(c: Cliente, id: string, metodo: string, ruta: string, cuerpo?: any, op: OpcionesPedido = {}) {
  return c.pedir(metodo, ruta, cuerpo, { sub: `${id}-curso`, ...op });
}

export async function getCurso(c: Cliente, id: string, ruta = '/', op: OpcionesPedido = {}) {
  return c.get(ruta, { sub: `${id}-curso`, ...op });
}

export function contenedorDe(nucleo: { prefijo: string }, id: string) {
  return nombreContenedor(nucleo.prefijo, id);
}

export function tokenDeCurso(nucleo: { prefijo: string }, id: string): string {
  return entornoDe(contenedorDe(nucleo, id)).CAMPUSIA_TOKEN_CURSO ?? '';
}

export function apiDeCurso(nucleo: { prefijo: string }, id: string): string {
  return entornoDe(contenedorDe(nucleo, id)).CAMPUSIA_API ?? '';
}

export async function pedirApiCursos(url: string, token: string | null, metodo = 'GET', encabezados: Record<string, string> = {}) {
  const h: Record<string, string> = { accept: 'application/json', ...encabezados };
  if (token) h.authorization = `Bearer ${token}`;
  const r = await fetch(url, { method: metodo, headers: h, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  const texto = await r.text();
  let json: any = null;
  try {
    json = texto ? JSON.parse(texto) : null;
  } catch {
    json = null;
  }
  return { status: r.status, texto, json };
}

export async function esperarHasta(cond: () => boolean | Promise<boolean>, ms: number, descripcion: string) {
  const limite = Date.now() + ms;
  while (Date.now() < limite) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`No se cumplió a tiempo: ${descripcion}`);
}

export function auditoria(nucleo: Nucleo, accion: string): any[] {
  return nucleo.consultar('SELECT * FROM auditoria WHERE accion = ? ORDER BY id', accion);
}
