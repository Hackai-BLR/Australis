import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { expect } from '@playwright/test';
import { Cliente, type OpcionesPedido, type Respuesta } from '../../comun/http.ts';
import type { Nucleo } from '../../comun/nucleo.ts';
import { entrar } from '../../comun/sesion.ts';

export interface RespuestaBinaria {
  status: number;
  encabezados: http.IncomingHttpHeaders;
  cuerpo: Buffer;
  texto: string;
  json: any;
}

export function sha256(datos: Buffer | string): string {
  return crypto.createHash('sha256').update(datos).digest('hex');
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

export function nombreUsuario(nucleo: Nucleo, email: string): string {
  const f = nucleo.consultar('SELECT nombre FROM usuarios WHERE email = ?', email)[0];
  if (!f) throw new Error(`No existe la cuenta ${email}`);
  return String(f.nombre);
}

export function pedirCrudo(
  c: Cliente,
  metodo: string,
  ruta: string,
  cuerpo?: Buffer | string,
  op: OpcionesPedido = {},
): Promise<RespuestaBinaria> {
  const host = op.host ?? c.nucleo.host(op.sub);
  const encabezados: Record<string, string> = { host, 'cf-connecting-ip': c.ip };
  const modifica = !['GET', 'HEAD', 'OPTIONS'].includes(metodo);
  if (modifica) {
    const origen = op.origen === undefined ? `${c.nucleo.esquema()}://${host}` : op.origen;
    if (origen !== null) encabezados.origin = origen;
    if (!op.sinEncabezadoPropio) encabezados['x-campusia'] = '1';
  }
  const cookies = op.cookie ?? (op.sinCookies ? '' : [...c.cookies].map(([k, v]) => `${k}=${v}`).join('; '));
  if (cookies) encabezados.cookie = cookies;
  const bearer = op.bearer ?? c.bearer;
  if (bearer) encabezados.authorization = `Bearer ${bearer}`;
  const datos = cuerpo === undefined ? undefined : Buffer.isBuffer(cuerpo) ? cuerpo : Buffer.from(cuerpo, 'utf8');
  if (datos !== undefined) {
    encabezados['content-type'] = op.tipo ?? 'application/octet-stream';
    encabezados['content-length'] = String(datos.length);
  }
  Object.assign(encabezados, op.encabezados ?? {});
  for (const k of Object.keys(encabezados)) if (encabezados[k] === '') delete encabezados[k];
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: c.nucleo.puerto, path: ruta, method: metodo, headers: encabezados, timeout: 60_000 },
      (res) => {
        const partes: Buffer[] = [];
        res.on('data', (p) => partes.push(p));
        res.on('end', () => {
          const b = Buffer.concat(partes);
          const texto = b.toString('utf8');
          let json: any = null;
          try {
            json = texto ? JSON.parse(texto) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, encabezados: res.headers, cuerpo: b, texto, json });
        });
        res.on('error', reject);
      },
    );
    req.on('error', (e: any) => {
      if (e?.code === 'EPIPE' || e?.code === 'ECONNRESET') resolve({ status: 0, encabezados: {}, cuerpo: Buffer.alloc(0), texto: String(e.code), json: null });
      else reject(e);
    });
    req.on('timeout', () => req.destroy(new Error(`Tiempo agotado en ${metodo} ${ruta}`)));
    if (datos !== undefined) req.write(datos);
    req.end();
  });
}

export interface OpcionesSubida extends OpcionesPedido {
  material?: boolean;
}

export function rutaSubida(curso: string, nombre: string, material = false) {
  return `/api/cursos/${curso}/archivos?nombre=${encodeURIComponent(nombre)}${material ? '&material=1' : ''}`;
}

export function subir(c: Cliente, curso: string, nombre: string, contenido: Buffer | string, op: OpcionesSubida = {}) {
  return pedirCrudo(c, 'POST', rutaSubida(curso, nombre, op.material), contenido, op);
}

export async function subirOk(c: Cliente, curso: string, nombre: string, contenido: Buffer | string, op: OpcionesSubida = {}) {
  const r = await subir(c, curso, nombre, contenido, op);
  expect(r.status, `subir ${nombre} a ${curso}: ${r.texto}`).toBe(201);
  return r.json;
}

export function bajar(c: Cliente, curso: string, id: string, op: OpcionesPedido = {}) {
  return pedirCrudo(c, 'GET', `/api/cursos/${curso}/archivos/${id}`, undefined, op);
}

export function listarArchivos(c: Cliente, curso: string, op: OpcionesPedido = {}) {
  return c.get(`/api/cursos/${curso}/archivos`, op);
}

export function entregar(c: Cliente, curso: string, cuerpo: any, op: OpcionesPedido = {}): Promise<Respuesta> {
  return c.post(`/api/cursos/${curso}/entregas`, cuerpo, op);
}

export async function entregarOk(c: Cliente, curso: string, cuerpo: any) {
  const r = await entregar(c, curso, cuerpo);
  expect(r.status, `entregar en ${curso}: ${r.texto}`).toBe(201);
  return r.json;
}

function consulta(q: Record<string, string | number | undefined> = {}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

export function verEntregas(c: Cliente, curso: string, q: Record<string, string | number | undefined> = {}, op: OpcionesPedido = {}) {
  return c.get(`/api/cursos/${curso}/entregas${consulta(q)}`, op);
}

export function ponerNota(c: Cliente, curso: string, cuerpo: any, op: OpcionesPedido = {}) {
  return c.post(`/api/cursos/${curso}/notas`, cuerpo, op);
}

export async function ponerNotaOk(c: Cliente, curso: string, cuerpo: any) {
  const r = await ponerNota(c, curso, cuerpo);
  expect(r.status, `poner nota en ${curso}: ${r.texto}`).toBe(201);
  return r.json;
}

export function verNotas(c: Cliente, curso: string, q: Record<string, string | number | undefined> = {}, op: OpcionesPedido = {}) {
  return c.get(`/api/cursos/${curso}/notas${consulta(q)}`, op);
}

export function verHistorial(c: Cliente, curso: string, q: Record<string, string | number | undefined> = {}, op: OpcionesPedido = {}) {
  return c.get(`/api/cursos/${curso}/notas/historial${consulta(q)}`, op);
}

export function archivosEnDisco(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const salida: string[] = [];
  const recorrer = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) recorrer(p);
      else salida.push(p);
    }
  };
  recorrer(dir);
  return salida;
}

export function raizArchivos(nucleo: Nucleo): string {
  return nucleo.entorno.RAIZ_ARCHIVOS;
}

export function rutaArchivo(nucleo: Nucleo, curso: string, id: string): string {
  return path.join(raizArchivos(nucleo), curso, id);
}

export function ejecutarSql(nucleo: Nucleo, sql: string, ...params: any[]) {
  const db = nucleo.base();
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

export function fechaEnRango(fecha: string, antes: number, despues: number) {
  const t = Date.parse(fecha);
  expect(Number.isNaN(t), `fecha inválida: ${fecha}`).toBe(false);
  expect(t).toBeGreaterThanOrEqual(Math.floor(antes / 1000) * 1000 - 2000);
  expect(t).toBeLessThanOrEqual(despues + 2000);
}

export const PATRON_ARCHIVO_ID = /^[0-9a-f]{32}$/;

export interface Miembros {
  dueno: string;
  profesores?: string[];
  alumnos?: string[];
}

export function cursoAislado(nucleo: Nucleo, prefijo: string, m: Miembros): string {
  const id = `${prefijo}-${crypto.randomBytes(4).toString('hex')}`;
  const uni = nucleo.consultar('SELECT universidad_id FROM usuarios WHERE email = ?', m.dueno)[0];
  if (!uni) throw new Error(`No existe la cuenta ${m.dueno}`);
  const ahora = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const db = nucleo.base();
  try {
    db.prepare('INSERT INTO cursos (id, nombre, periodo, color, universidad_id, version_publicada, creado_en) VALUES (?, ?, ?, ?, ?, NULL, ?)').run(
      id,
      `Curso ${id}`,
      '2.º cuatrimestre 2026',
      '#1F7A4D',
      uni.universidad_id,
      ahora,
    );
    const inscribir = db.prepare('INSERT INTO inscripciones (curso_id, usuario_id, rol, creada_en) VALUES (?, (SELECT id FROM usuarios WHERE email = ?), ?, ?)');
    inscribir.run(id, m.dueno, 'dueño', ahora);
    for (const p of m.profesores ?? []) inscribir.run(id, p, 'profesor', ahora);
    for (const a of m.alumnos ?? []) inscribir.run(id, a, 'alumno', ahora);
  } finally {
    db.close();
  }
  return id;
}
