import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect } from '@playwright/test';
import type { Cliente, OpcionesPedido, Respuesta } from '../../comun/http.ts';
import { entornoDe, inspeccionar } from '../../fase-2/lib/docker.ts';
import { cursoListo, ejecutarSql } from '../../fase-2/lib/cursos.ts';
import type { NucleoAgente } from '../fixtures.ts';
import { PRECIOS } from '../fixtures.ts';
import type { PasoGuion } from './modelo-falso.ts';

export const ESPERA_ESPACIO_MS = 1_200_000;
export const ESPERA_AGENTE_MS = 600_000;
export const ESPERA_PUBLICACION_MS = 1_500_000;
export const ESPERA_RECARGA_MS = 180_000;

export function nombreEspacio(n: { prefijo: string }, id: string) {
  return `${n.prefijo}-espacio-${id}`;
}

export function entornoEspacio(n: { prefijo: string }, id: string): Record<string, string> {
  return entornoDe(nombreEspacio(n, id));
}

export function tokenModelo(n: { prefijo: string }, id: string): string {
  return entornoEspacio(n, id).ANTHROPIC_AUTH_TOKEN ?? '';
}

export function urlModelo(n: { prefijo: string }, id: string): string {
  return entornoEspacio(n, id).ANTHROPIC_BASE_URL ?? '';
}

function registro(n: NucleoAgente) {
  return fs.existsSync(n.archivoRegistro) ? fs.readFileSync(n.archivoRegistro, 'utf8').slice(-5000) : '';
}

export async function espacioListo(c: Cliente, id: string, ms = ESPERA_ESPACIO_MS): Promise<void> {
  const r = await c.post(`/api/cursos/${id}/espacio`, {});
  expect([200, 202], `encender el espacio de ${id}: ${r.texto}`).toContain(r.status);
  const limite = Date.now() + ms;
  let ultimo: any = null;
  while (Date.now() < limite) {
    const e = await c.get(`/api/cursos/${id}/espacio`);
    ultimo = e.json;
    if (e.status === 200 && e.json?.espacio === 'encendido') return;
    if (e.status === 200 && e.json?.espacio === 'error') {
      throw new Error(`El espacio de ${id} quedó en error: ${e.json?.error}\n${registro(c.nucleo as NucleoAgente)}`);
    }
    if (e.status !== 200) throw new Error(`GET /api/cursos/${id}/espacio respondió ${e.status}: ${e.texto}`);
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error(`El espacio de ${id} no se encendió a tiempo (último: ${JSON.stringify(ultimo)})\n${registro(c.nucleo as NucleoAgente)}`);
}

export async function cursoConEspacio(c: Cliente, datos: { id?: string; nombre?: string } = {}): Promise<string> {
  const id = await cursoListo(c, datos);
  await espacioListo(c, id);
  return id;
}

export interface EventoSse {
  evento: string;
  datos: any;
}

export interface RespuestaAgente {
  status: number;
  tipo: string;
  eventos: EventoSse[];
  json: any;
  texto: string;
  primerEventoMs: number | null;
  duracionMs: number;
}

export function interpretarSse(texto: string): EventoSse[] {
  const eventos: EventoSse[] = [];
  for (const bloque of texto.split(/\r?\n\r?\n/)) {
    let evento = 'message';
    const datos: string[] = [];
    for (const linea of bloque.split(/\r?\n/)) {
      if (linea.startsWith(':') || linea === '') continue;
      if (linea.startsWith('event:')) evento = linea.slice(6).trim();
      else if (linea.startsWith('data:')) datos.push(linea.slice(5).replace(/^ /, ''));
    }
    if (!datos.length) continue;
    let d: any = datos.join('\n');
    try {
      d = JSON.parse(d);
    } catch {}
    eventos.push({ evento, datos: d });
  }
  return eventos;
}

export function pedirAlAgente(c: Cliente, id: string, pedido: unknown, op: OpcionesPedido & { cortarAlInicio?: boolean } = {}): Promise<RespuestaAgente> {
  const cuerpo = JSON.stringify(typeof pedido === 'string' ? { pedido } : pedido);
  const host = op.host ?? c.nucleo.host(op.sub);
  const encabezados: Record<string, string> = {
    host,
    'cf-connecting-ip': c.ip,
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'content-length': String(Buffer.byteLength(cuerpo)),
  };
  const origen = op.origen === undefined ? `${c.nucleo.esquema()}://${host}` : op.origen;
  if (origen !== null) encabezados.origin = origen;
  if (!op.sinEncabezadoPropio) encabezados['x-campusia'] = '1';
  const cookies = op.cookie ?? (op.sinCookies ? '' : [...c.cookies].map(([k, v]) => `${k}=${v}`).join('; '));
  if (cookies) encabezados.cookie = cookies;
  const bearer = op.bearer ?? c.bearer;
  if (bearer) encabezados.authorization = `Bearer ${bearer}`;
  Object.assign(encabezados, op.encabezados ?? {});
  const inicio = Date.now();
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: c.nucleo.puerto, path: `/api/cursos/${id}/agente`, method: 'POST', headers: encabezados, timeout: ESPERA_AGENTE_MS },
      (res) => {
        const partes: Buffer[] = [];
        let primerEventoMs: number | null = null;
        res.on('data', (p: Buffer) => {
          if (primerEventoMs === null && p.toString('utf8').includes('event:')) primerEventoMs = Date.now() - inicio;
          partes.push(p);
          if (op.cortarAlInicio && Buffer.concat(partes).toString('utf8').includes('event: inicio')) {
            req.destroy();
            const texto = Buffer.concat(partes).toString('utf8');
            resolve({ status: res.statusCode ?? 0, tipo: String(res.headers['content-type'] ?? ''), eventos: interpretarSse(texto), json: null, texto, primerEventoMs, duracionMs: Date.now() - inicio });
          }
        });
        res.on('end', () => {
          const texto = Buffer.concat(partes).toString('utf8');
          const tipo = String(res.headers['content-type'] ?? '');
          let json: any = null;
          if (!tipo.includes('event-stream')) {
            try {
              json = JSON.parse(texto);
            } catch {}
          }
          resolve({ status: res.statusCode ?? 0, tipo, eventos: tipo.includes('event-stream') ? interpretarSse(texto) : [], json, texto, primerEventoMs, duracionMs: Date.now() - inicio });
        });
        res.on('error', () => {});
      },
    );
    req.on('error', (e) => {
      if (op.cortarAlInicio) return;
      reject(e);
    });
    req.on('timeout', () => req.destroy(new Error('El agente no terminó a tiempo')));
    req.write(cuerpo);
    req.end();
  });
}

export function finDe(r: RespuestaAgente): any {
  const fin = r.eventos.find((e) => e.evento === 'fin');
  return fin?.datos?.respuesta ?? null;
}

export async function pedidoOk(c: Cliente, id: string, pedido: string): Promise<{ respuesta: any; r: RespuestaAgente }> {
  const r = await pedirAlAgente(c, id, pedido);
  expect(r.status, `pedido al agente en ${id}: ${r.texto.slice(0, 2000)}`).toBe(200);
  expect(r.tipo).toContain('text/event-stream');
  const respuesta = finDe(r);
  expect(respuesta, `el stream terminó sin evento fin: ${r.texto.slice(-2000)}`).toBeTruthy();
  expect(respuesta.estado, `la ejecución del agente terminó con error: ${JSON.stringify(respuesta)}\n${registro(c.nucleo as NucleoAgente)}`).toBe('ok');
  return { respuesta, r };
}

export function guion(n: NucleoAgente, nombre: string, pasos: PasoGuion[]) {
  n.modelo.guiones.set(nombre, pasos);
}

export async function esperarPublicacion(c: Cliente, id: string, pid: number | string, ms = ESPERA_PUBLICACION_MS): Promise<any> {
  const limite = Date.now() + ms;
  let ultimo: any = null;
  while (Date.now() < limite) {
    const r = await c.get(`/api/cursos/${id}/publicaciones/${pid}`);
    expect(r.status, `GET publicación ${pid}: ${r.texto}`).toBe(200);
    ultimo = r.json;
    if (r.json.estado !== 'en_curso') return r.json;
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error(`La publicación ${pid} de ${id} no terminó a tiempo (última: ${JSON.stringify(ultimo)?.slice(0, 3000)})`);
}

export async function publicar(c: Cliente, id: string, cuerpo: Record<string, unknown> = {}): Promise<any> {
  const r = await c.post(`/api/cursos/${id}/publicar`, cuerpo);
  expect(r.status, `publicar ${id}: ${r.texto}`).toBe(202);
  expect(r.json.estado).toBe('en_curso');
  return esperarPublicacion(c, id, r.json.id);
}

export async function publicarOk(c: Cliente, id: string, cuerpo: Record<string, unknown> = {}): Promise<any> {
  const p = await publicar(c, id, cuerpo);
  expect(p.estado, `la publicación falló en ${p.etapa}: ${p.error}\n${String(p.registro ?? '').slice(-3000)}`).toBe('ok');
  return p;
}

export async function volver(c: Cliente, id: string, n: number): Promise<any> {
  const r = await c.post(`/api/cursos/${id}/versiones/${n}/volver`, {});
  expect(r.status, `volver a la v${n} en ${id}: ${r.texto}`).toBe(202);
  return esperarPublicacion(c, id, r.json.id);
}

export function git(n: { raizCursos: string }, id: string, args: string[]): { estado: number | null; salida: string; error: string } {
  const r = spawnSync('git', ['-C', path.join(n.raizCursos, id), ...args], { encoding: 'utf8', timeout: 60_000 });
  return { estado: r.status, salida: (r.stdout ?? '').trim(), error: (r.stderr ?? '').trim() };
}

export function archivoEnRama(n: { raizCursos: string }, id: string, rama: string, ruta: string): string | null {
  const r = git(n, id, ['show', `${rama}:${ruta}`]);
  return r.estado === 0 ? r.salida : null;
}

export async function esperarRespuesta(
  pedir: () => Promise<Respuesta>,
  cumple: (r: Respuesta) => boolean,
  ms: number,
  descripcion: string,
): Promise<Respuesta> {
  const limite = Date.now() + ms;
  let ultima: Respuesta | null = null;
  while (Date.now() < limite) {
    try {
      ultima = await pedir();
      if (cumple(ultima)) return ultima;
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`No se cumplió a tiempo: ${descripcion} (última: ${ultima?.status} ${ultima?.texto.slice(0, 500)})`);
}

export function enPrueba(c: Cliente, id: string, ruta: string, op: OpcionesPedido = {}) {
  return c.get(ruta, { sub: `${id}-prueba`, ...op });
}

export function enPublicado(c: Cliente, id: string, ruta: string, op: OpcionesPedido = {}) {
  return c.get(ruta, { sub: `${id}-curso`, ...op });
}

export const LINEA_SALUD = "  app.get('/salud', (c) => c.json({ estado: 'ok' }));";

export function lineaRuta(ruta: string, valor: string) {
  return `  app.get('${ruta}', (c) => c.json({ valor: '${valor}' }));`;
}

export function guionAgregarRuta(ruta: string, valor: string, texto = 'Agregué la ruta.'): PasoGuion[] {
  return [
    { texto: 'Miro el servidor.', herramientas: [{ nombre: 'Read', entrada: { file_path: '/repo/servidor/app.ts' } }] },
    {
      herramientas: [
        { nombre: 'Edit', entrada: { file_path: '/repo/servidor/app.ts', old_string: LINEA_SALUD, new_string: `${LINEA_SALUD}\n${lineaRuta(ruta, valor)}` } },
      ],
    },
    { texto },
  ];
}

export function guionCambiarValor(ruta: string, viejo: string, nuevo: string, texto = 'Cambié el valor.'): PasoGuion[] {
  return [
    { herramientas: [{ nombre: 'Read', entrada: { file_path: '/repo/servidor/app.ts' } }] },
    { herramientas: [{ nombre: 'Edit', entrada: { file_path: '/repo/servidor/app.ts', old_string: lineaRuta(ruta, viejo), new_string: lineaRuta(ruta, nuevo) } }] },
    { texto },
  ];
}

export function guionEscribir(archivos: Record<string, string>, texto = 'Listo.'): PasoGuion[] {
  return [
    ...Object.entries(archivos).map(([ruta, contenido]) => ({ herramientas: [{ nombre: 'Write', entrada: { file_path: `/repo/${ruta}`, content: contenido } }] })),
    { texto },
  ];
}

export function guionBash(comandos: string[], texto = 'Listo.'): PasoGuion[] {
  return [...comandos.map((command) => ({ herramientas: [{ nombre: 'Bash', entrada: { command, description: 'Comando' } }] })), { texto }];
}

export function precioDe(modelo: string | null) {
  const m = modelo ?? '';
  const tabla = PRECIOS as Record<string, { entrada: number; salida: number; cache_creacion: number; cache_lectura: number }>;
  if (tabla[m]) return tabla[m]!;
  const prefijos = Object.keys(tabla)
    .filter((k) => k !== '*' && m.startsWith(k))
    .sort((a, b) => b.length - a.length);
  return tabla[prefijos[0] ?? '*']!;
}

export function costoEsperado(modelo: string | null, uso: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number }) {
  const p = precioDe(modelo);
  return (
    (uso.input_tokens * p.entrada + uso.output_tokens * p.salida + uso.cache_creation_input_tokens * p.cache_creacion + uso.cache_read_input_tokens * p.cache_lectura) /
    1_000_000
  );
}

export function mesActual() {
  return new Date().toISOString().slice(0, 7);
}

export function usoAgente(n: NucleoAgente, id: string): number {
  const f = n.consultar('SELECT usd FROM uso_agente WHERE curso_id = ? AND mes = ?', id, mesActual())[0];
  return f ? Number(f.usd) : 0;
}

export function filasUso(n: NucleoAgente, id?: string): any[] {
  return id ? n.consultar('SELECT * FROM uso_modelo WHERE curso_id = ? ORDER BY id', id) : n.consultar('SELECT * FROM uso_modelo ORDER BY id');
}

export function limiteUniversidad(n: NucleoAgente, nombre: string, usd: number) {
  ejecutarSql(n, 'UPDATE universidades SET limite_usd = ? WHERE nombre = ?', usd, nombre);
}

export async function llamarModelo(
  url: string,
  ruta: string,
  op: { metodo?: string; token?: string | null; xApiKey?: string; cuerpo?: any; crudo?: string; encabezados?: Record<string, string>; host?: string } = {},
): Promise<{ status: number; encabezados: http.IncomingHttpHeaders; texto: string; json: any; trozos: Array<{ ms: number; texto: string }> }> {
  const u = new URL(url);
  const datos = op.crudo ?? (op.cuerpo !== undefined ? JSON.stringify(op.cuerpo) : undefined);
  const enc: Record<string, string> = { 'anthropic-version': '2023-06-01', 'content-type': 'application/json', ...(op.encabezados ?? {}) };
  if (op.token) enc.authorization = `Bearer ${op.token}`;
  if (op.xApiKey) enc['x-api-key'] = op.xApiKey;
  if (op.host) enc.host = op.host;
  if (datos !== undefined) enc['content-length'] = String(Buffer.byteLength(datos));
  const inicio = Date.now();
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: u.hostname, port: Number(u.port || 80), path: ruta, method: op.metodo ?? 'POST', headers: enc, timeout: 60_000 },
      (res) => {
        const trozos: Array<{ ms: number; texto: string }> = [];
        res.on('data', (p: Buffer) => trozos.push({ ms: Date.now() - inicio, texto: p.toString('utf8') }));
        res.on('end', () => {
          const texto = trozos.map((t) => t.texto).join('');
          let json: any = null;
          try {
            json = JSON.parse(texto);
          } catch {}
          resolve({ status: res.statusCode ?? 0, encabezados: res.headers, texto, json, trozos });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`Tiempo agotado en ${ruta}`)));
    if (datos !== undefined) req.write(datos);
    req.end();
  });
}

export function cuerpoMensaje(texto: string, extra: Record<string, unknown> = {}) {
  return { model: 'claude-haiku-5-5', max_tokens: 64, messages: [{ role: 'user', content: texto }], ...extra };
}

export function cuerposDesdeAgente(n: NucleoAgente, desde = 0): string {
  return n.modelo.pedidos
    .slice(desde)
    .map((p) => p.cuerpo)
    .join('\n');
}

export function contenedorIdDe(nombre: string): string | null {
  return inspeccionar(nombre)?.Id ?? null;
}

export function textoArchivos(dir: string, limiteBytes = 50 * 1024 * 1024): string {
  const partes: string[] = [];
  let total = 0;
  const recorrer = (d: string) => {
    let entradas: fs.Dirent[] = [];
    try {
      entradas = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entradas) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (e.name === 'node_modules') continue;
        recorrer(p);
      } else if (e.isFile()) {
        try {
          const st = fs.statSync(p);
          if (st.size > 5 * 1024 * 1024 || total > limiteBytes) continue;
          total += st.size;
          partes.push(fs.readFileSync(p).toString('latin1'));
        } catch {}
      }
    }
  };
  recorrer(dir);
  return partes.join('\n');
}
