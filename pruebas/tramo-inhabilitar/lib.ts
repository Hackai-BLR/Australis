import crypto from 'node:crypto';
import { expect } from '@playwright/test';
import { Cliente, type Respuesta } from '../comun/http.ts';
import type { Nucleo } from '../comun/nucleo.ts';
import { aleatorio, entrar, reautenticar } from '../comun/sesion.ts';

export async function sesion(nucleo: Nucleo, email: string): Promise<Cliente> {
  const c = new Cliente(nucleo);
  await entrar(c, email);
  return c;
}

export async function sesionReautenticada(nucleo: Nucleo, email: string): Promise<Cliente> {
  const c = await sesion(nucleo, email);
  await reautenticar(c);
  return c;
}

export function idUsuario(nucleo: Nucleo, email: string): number {
  const f = nucleo.consultar('SELECT id FROM usuarios WHERE email = ?', email)[0];
  if (!f) throw new Error(`No existe la cuenta ${email}`);
  return Number(f.id);
}

export function idUniversidad(nucleo: Nucleo, nombre: string): number {
  const f = nucleo.consultar('SELECT id FROM universidades WHERE nombre = ?', nombre)[0];
  if (!f) throw new Error(`No existe la universidad ${nombre}`);
  return Number(f.id);
}

export const AUSTRAL = 'Universidad Austral';
export const DEMO = 'Universidad de Prueba';

export function ejecutarSql(nucleo: Nucleo, sql: string, ...params: any[]) {
  const db = nucleo.base();
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

export function fila(nucleo: Nucleo, sql: string, ...params: any[]): any {
  return nucleo.consultar(sql, ...params)[0];
}

export function mailNuevo(dominio = 'austral.edu.ar', prefijo = 'p') {
  return `${aleatorio(prefijo)}@${dominio}`;
}

export interface CuentaNueva {
  cliente: Cliente;
  email: string;
  id: number;
}

export async function cuentaNueva(nucleo: Nucleo, dominio = 'austral.edu.ar', prefijo = 'p'): Promise<CuentaNueva> {
  const email = mailNuevo(dominio, prefijo);
  const cliente = await sesion(nucleo, email);
  return { cliente, email, id: idUsuario(nucleo, email) };
}

export async function profesorNuevo(nucleo: Nucleo, admin: Cliente, dominio = 'austral.edu.ar'): Promise<CuentaNueva> {
  const cuenta = await cuentaNueva(nucleo, dominio, 'prof');
  const r = await admin.put(`/api/admin/personas/${cuenta.id}/profesor`, { profesor: true });
  expect(r.status, `marcar profesor a ${cuenta.email}: ${r.texto}`).toBe(200);
  return cuenta;
}

export interface CursoDePrueba {
  universidad: number;
  dueno: string;
  profesores?: string[];
  alumnos?: string[];
  id?: string;
}

export function cursoDePrueba(nucleo: Nucleo, datos: CursoDePrueba): string {
  const id = datos.id ?? `t-${crypto.randomBytes(4).toString('hex')}`;
  const ahora = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const db = nucleo.base();
  try {
    db.prepare(
      'INSERT INTO cursos (id, nombre, periodo, color, universidad_id, version_publicada, creado_en) VALUES (?, ?, ?, ?, ?, NULL, ?)',
    ).run(id, `Curso de prueba ${id}`, '2.º cuatrimestre 2026', '#1F7A4D', datos.universidad, ahora);
    const inscribir = db.prepare('INSERT INTO inscripciones (curso_id, usuario_id, rol, creada_en) VALUES (?, ?, ?, ?)');
    const idDe = (email: string) => {
      const f = db.prepare('SELECT id FROM usuarios WHERE email = ?').get(email) as any;
      if (!f) throw new Error(`No existe la cuenta ${email}`);
      return Number(f.id);
    };
    inscribir.run(id, idDe(datos.dueno), 'dueño', ahora);
    for (const p of datos.profesores ?? []) inscribir.run(id, idDe(p), 'profesor', ahora);
    for (const a of datos.alumnos ?? []) inscribir.run(id, idDe(a), 'alumno', ahora);
  } finally {
    db.close();
  }
  return id;
}

export function paginaCurso(c: Cliente, id: string, op: Record<string, any> = {}) {
  return c.get('/', { sub: `${id}-curso`, ...op });
}

export interface UniversidadNueva {
  id: number;
  nombre: string;
  dominio: string;
  admin: string;
}

export async function universidadNueva(owner: Cliente): Promise<UniversidadNueva> {
  const sufijo = crypto.randomBytes(4).toString('hex');
  const dominio = `u${sufijo}.edu.ar`;
  const nombre = `Universidad ${sufijo}`;
  const admin = `admin@${dominio}`;
  const r = await owner.post('/api/owner/universidades', { nombre, dominio, email_administrador: admin });
  expect(r.status, `crear universidad: ${r.texto}`).toBe(201);
  return { id: Number(r.json.id), nombre, dominio, admin };
}

export async function tokenPersonal(c: Cliente, permisos: string[]): Promise<string> {
  if (!c.email) throw new Error('El cliente no tiene mail');
  const valor = `cia_${crypto.randomBytes(32).toString('base64url')}`;
  const huella = crypto.createHmac('sha256', c.nucleo.entorno.SESSION_SECRET!).update(valor).digest('hex');
  const ahora = new Date();
  const vence = new Date(ahora.getTime() + 90 * 86_400_000);
  const sinMs = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  ejecutarSql(
    c.nucleo,
    'INSERT INTO tokens_api (usuario_id, nombre, huella, permisos, creado_en, vence_en, revocado) VALUES (?, ?, ?, ?, ?, ?, 0)',
    idUsuario(c.nucleo, c.email),
    aleatorio('t'),
    huella,
    JSON.stringify(permisos),
    sinMs(ahora),
    sinMs(vence),
  );
  return valor;
}

export function revivirSesiones(nucleo: Nucleo, email: string) {
  ejecutarSql(nucleo, 'UPDATE sesiones SET revocada = 0 WHERE usuario_id = ?', idUsuario(nucleo, email));
}

export function auditoria(nucleo: Nucleo, accion: string): any[] {
  return nucleo.consultar('SELECT * FROM auditoria WHERE accion = ? ORDER BY id', accion);
}

export function ultimaAuditoria(nucleo: Nucleo, accion: string, contiene: string): any {
  return auditoria(nucleo, accion).filter((e) => String(e.detalle).includes(contiene)).pop();
}

export function estadoCuenta(nucleo: Nucleo, id: number) {
  return fila(nucleo, 'SELECT suspendida_en, baja_en, pendiente FROM usuarios WHERE id = ?', id);
}

export function esperarOk(r: Respuesta, que: string, estado = 200) {
  expect(r.status, `${que}: ${r.texto}`).toBe(estado);
}

export async function esperarHasta(cond: () => boolean | Promise<boolean>, ms: number, descripcion: string) {
  const limite = Date.now() + ms;
  while (Date.now() < limite) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`No se cumplió a tiempo: ${descripcion}`);
}

export function suspender(c: Cliente, id: number, como: 'admin' | 'owner' = 'admin') {
  return c.post(`/api/${como}/personas/${id}/suspender`, {});
}

export function reactivar(c: Cliente, id: number, como: 'admin' | 'owner' = 'admin') {
  return c.post(`/api/${como}/personas/${id}/reactivar`, {});
}

export function darDeBaja(c: Cliente, id: number, como: 'admin' | 'owner' = 'admin', cuerpo: any = { confirmar: true }) {
  return c.post(`/api/${como}/personas/${id}/baja`, cuerpo);
}

export function archivar(c: Cliente, curso: string, como: 'dueno' | 'admin' = 'dueno') {
  return c.post(como === 'admin' ? `/api/admin/cursos/${curso}/archivar` : `/api/cursos/${curso}/archivar`, {});
}

export function desarchivar(c: Cliente, curso: string, como: 'dueno' | 'admin' = 'dueno') {
  return c.post(como === 'admin' ? `/api/admin/cursos/${curso}/desarchivar` : `/api/cursos/${curso}/desarchivar`, {});
}

export function deshabilitar(c: Cliente, uni: number) {
  return c.post(`/api/owner/universidades/${uni}/deshabilitar`, {});
}

export function rehabilitar(c: Cliente, uni: number) {
  return c.post(`/api/owner/universidades/${uni}/rehabilitar`, {});
}
