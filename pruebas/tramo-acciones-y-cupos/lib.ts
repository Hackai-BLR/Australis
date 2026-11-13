import crypto from 'node:crypto';
import { expect } from '@playwright/test';
import { Cliente, type Respuesta } from '../comun/http.ts';
import type { Nucleo } from '../comun/nucleo.ts';
import { aleatorio } from '../comun/sesion.ts';
import { resultadosDeHerramientas } from '../fase-3/lib/modelo-falso.ts';
import { ESPERA_AGENTE_MS, finDe, guion, pedirAlAgente, type RespuestaAgente } from '../fase-3/lib/agente.ts';
import type { NucleoAgente } from '../fase-3/fixtures.ts';
import {
  ejecutarSql,
  fila,
  idUniversidad,
  idUsuario,
  profesorNuevo,
  sesion,
  sesionReautenticada,
  tokenPersonal,
  universidadNueva,
  type CuentaNueva,
  type UniversidadNueva,
} from '../tramo-inhabilitar/lib.ts';

export {
  AUSTRAL,
  DEMO,
  cuentaNueva,
  cursoDePrueba,
  ejecutarSql,
  esperarOk,
  fila,
  idUniversidad,
  idUsuario,
  mailNuevo,
  profesorNuevo,
  sesion,
  sesionReautenticada,
  suspender,
  archivar,
  universidadNueva,
} from '../tramo-inhabilitar/lib.ts';

export const tokenViejo = tokenPersonal;

export function mesActual() {
  return new Date().toISOString().slice(0, 7);
}

export function auditoriaDe(n: Nucleo, accion: string, contiene = ''): any[] {
  return n.consultar('SELECT * FROM auditoria WHERE accion = ? ORDER BY id', accion).filter((e: any) => String(e.detalle).includes(contiene));
}

export function inscriptosEnBase(n: Nucleo, curso: string): Array<{ email: string; rol: string; id: number; pendiente: number }> {
  return n.consultar(
    'SELECT u.id AS id, u.email AS email, i.rol AS rol, u.pendiente AS pendiente FROM inscripciones i JOIN usuarios u ON u.id = i.usuario_id WHERE i.curso_id = ? ORDER BY u.email',
    curso,
  );
}

export function rolEnCurso(n: Nucleo, curso: string, email: string): string | null {
  const f = n.consultar('SELECT i.rol AS rol FROM inscripciones i JOIN usuarios u ON u.id = i.usuario_id WHERE i.curso_id = ? AND u.email = ?', curso, email)[0];
  return f ? String(f.rol) : null;
}

export function tokensUsados(n: Nucleo, filtro: { usuario?: number; universidad?: number; curso?: string } = {}): number {
  const condiciones = ['mes = ?'];
  const params: any[] = [mesActual()];
  if (filtro.usuario !== undefined) {
    condiciones.push('usuario_id = ?');
    params.push(filtro.usuario);
  }
  if (filtro.universidad !== undefined) {
    condiciones.push('universidad_id = ?');
    params.push(filtro.universidad);
  }
  if (filtro.curso !== undefined) {
    condiciones.push('curso_id = ?');
    params.push(filtro.curso);
  }
  const f = n.consultar(`SELECT COALESCE(SUM(tokens), 0) AS t FROM uso_modelo WHERE ${condiciones.join(' AND ')}`, ...params)[0];
  return Number(f.t);
}

export function filasUsoDesde(n: Nucleo, desdeId: number): any[] {
  return n.consultar('SELECT * FROM uso_modelo WHERE id > ? ORDER BY id', desdeId);
}

export function ultimoIdUso(n: Nucleo): number {
  return Number(n.consultar('SELECT COALESCE(MAX(id), 0) AS m FROM uso_modelo')[0].m);
}

export function ok(r: Respuesta, que: string, estado = 200) {
  expect(r.status, `${que}: ${r.texto}`).toBe(estado);
  return r.json;
}

export async function ponerCupoUniversidad(owner: Cliente, uni: number, tokens: number) {
  return ok(await owner.put(`/api/owner/universidades/${uni}/cupo`, { tokens }), `cupo de la universidad ${uni}`);
}

export async function ponerPredeterminado(admin: Cliente, tokens: number | null, consulta = '') {
  return ok(await admin.put(`/api/admin/cupos/predeterminado${consulta}`, { tokens }), 'cupo predeterminado');
}

export async function ponerCupoProfesor(admin: Cliente, usuario: number, tokens: number | null, consulta = '') {
  return ok(await admin.put(`/api/admin/cupos/profesores/${usuario}${consulta}`, { tokens }), `cupo del profesor ${usuario}`);
}

export async function cuposAdmin(admin: Cliente, consulta = '') {
  return ok(await admin.get(`/api/admin/cupos${consulta}`), 'cupos del administrador');
}

export async function cupoDelCurso(c: Cliente, curso: string) {
  return ok(await c.get(`/api/cursos/${curso}/cupo`), `cupo en ${curso}`);
}

export function profesorEn(cupos: any, id: number) {
  const p = (cupos.profesores as any[]).find((x) => Number(x.id) === id);
  expect(p, `el profesor ${id} no está en los cupos`).toBeTruthy();
  return p;
}

export interface UniversidadConProfesores {
  uni: UniversidadNueva;
  owner: Cliente;
  admin: Cliente;
  profesores: CuentaNueva[];
}

export async function universidadConProfesores(n: Nucleo, ownerEmail: string, cantidad: number): Promise<UniversidadConProfesores> {
  const owner = await sesionReautenticada(n, ownerEmail);
  const uni = await universidadNueva(owner);
  const admin = await sesionReautenticada(n, uni.admin);
  const profesores: CuentaNueva[] = [];
  for (let i = 0; i < cantidad; i++) profesores.push(await profesorNuevo(n, admin, uni.dominio));
  return { uni, owner, admin, profesores };
}

export function tokenAgenteFalso() {
  return `cat_${crypto.randomBytes(32).toString('base64url')}`;
}

export const PRELUDIO_SCRIPT = String.raw`import { clienteDesdeEntorno } from '@campusia/sdk';
const API = String(process.env.CAMPUSIA_API ?? '').replace(/\/+$/, '');
const TOKEN = process.env.CAMPUSIA_TOKEN_AGENTE ?? '';
const c = clienteDesdeEntorno();
const salida = (clave, valor) => console.log('RESULTADO ' + JSON.stringify({ clave, valor }));
const intentar = async (clave, f) => {
  try {
    salida(clave, { ok: true, valor: await f() });
  } catch (e) {
    salida(clave, { ok: false, codigo: e?.codigo ?? null, estado: e?.estado ?? null, emails: e?.emails ?? null, mensaje: String(e?.message ?? e).slice(0, 300) });
  }
};
const pedir = async (clave, metodo, ruta, cuerpo, op = {}) => {
  const enc = { accept: 'application/json', ...(op.encabezados ?? {}) };
  const token = op.token === undefined ? TOKEN : op.token;
  if (token) enc.authorization = 'Bearer ' + token;
  if (cuerpo !== undefined) enc['content-type'] = 'application/json';
  try {
    const r = await fetch((op.base ?? API) + ruta, { method: metodo, headers: enc, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo), redirect: 'manual', signal: AbortSignal.timeout(15000) });
    const texto = await r.text();
    let json = null;
    try { json = JSON.parse(texto); } catch {}
    salida(clave, { estado: r.status, json, texto: texto.slice(0, 400) });
  } catch (e) {
    salida(clave, { estado: 0, error: String(e).slice(0, 300) });
  }
};
`;

export interface ResultadoScript {
  r: RespuestaAgente;
  respuesta: any;
  salida: string;
  resultados: Record<string, any>;
}

export async function correrScript(
  n: NucleoAgente,
  c: Cliente,
  curso: string,
  cuerpo: string,
  op: { pedido?: string; pasosDespues?: any[]; alIniciar?: () => void } = {},
): Promise<ResultadoScript> {
  const nombre = aleatorio('acc').toLowerCase().replace(/[^a-z0-9]/g, '');
  const archivo = `acciones-prueba/${nombre}.mjs`;
  guion(n, nombre, [
    { herramientas: [{ nombre: 'Write', entrada: { file_path: `/repo/${archivo}`, content: `${PRELUDIO_SCRIPT}\n${cuerpo}\n` } }] },
    { herramientas: [{ nombre: 'Bash', entrada: { command: `node ${archivo}`, description: 'Corre las acciones' } }] },
    ...(op.pasosDespues ?? []),
    { texto: 'Listo.' },
  ]);
  const desde = n.modelo.pedidos.length;
  const r = await pedirAlAgente(c, curso, `${op.pedido ?? 'Hacé lo que te pido con las acciones del curso'} [guion:${nombre}]`);
  expect(r.status, `pedido al agente en ${curso}: ${r.texto.slice(0, 2000)}`).toBe(200);
  const respuesta = finDe(r);
  expect(respuesta, `el stream terminó sin evento fin: ${r.texto.slice(-2000)}`).toBeTruthy();
  const salida = resultadosDeHerramientas(n.modelo, desde)
    .filter((x) => x.nombre === 'Bash' && String(x.entrada?.command ?? '').includes(archivo))
    .map((x) => x.contenido)
    .join('\n');
  const resultados: Record<string, any> = {};
  for (const linea of salida.split('\n')) {
    const i = linea.indexOf('RESULTADO ');
    if (i < 0) continue;
    try {
      const { clave, valor } = JSON.parse(linea.slice(i + 'RESULTADO '.length));
      resultados[clave] = valor;
    } catch {}
  }
  return { r, respuesta, salida, resultados };
}

export function resultado(res: ResultadoScript, clave: string): any {
  expect(res.resultados[clave], `el script no informó ${clave}. Salida:\n${res.salida.slice(0, 4000)}`).toBeDefined();
  return res.resultados[clave];
}

export function tokensEnPedidosDesde(n: NucleoAgente, desde: number): string[] {
  const todo = n.modelo.pedidos
    .slice(desde)
    .map((p) => p.cuerpo)
    .join('\n');
  return [...new Set(todo.match(/cat_[A-Za-z0-9_-]{43}/g) ?? [])];
}

export async function esperarTokenAgente(n: NucleoAgente, desde: number, ms = ESPERA_AGENTE_MS): Promise<string> {
  const limite = Date.now() + ms;
  while (Date.now() < limite) {
    const t = tokensEnPedidosDesde(n, desde);
    if (t.length) return t[0]!;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('El token del agente no apareció en la salida del script');
}

export async function pedirInterna(url: string, token: string | null, metodo = 'GET', cuerpo?: unknown, encabezados: Record<string, string> = {}) {
  const h: Record<string, string> = { accept: 'application/json', ...encabezados };
  if (token) h.authorization = `Bearer ${token}`;
  if (cuerpo !== undefined) h['content-type'] = 'application/json';
  const r = await fetch(url, { method: metodo, headers: h, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo), redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  const texto = await r.text();
  let json: any = null;
  try {
    json = texto ? JSON.parse(texto) : null;
  } catch {
    json = null;
  }
  return { status: r.status, texto, json, encabezados: r.headers };
}

export function idDe(n: Nucleo, email: string) {
  return idUsuario(n, email);
}

export function universidadDe(n: Nucleo, nombre: string) {
  return idUniversidad(n, nombre);
}

export function cupoEnBase(n: Nucleo, uni: number): number {
  return Number(fila(n, 'SELECT cupo_tokens FROM universidades WHERE id = ?', uni).cupo_tokens);
}

export function ponerCupoEnBase(n: Nucleo, uni: number, tokens: number) {
  ejecutarSql(n, 'UPDATE universidades SET cupo_tokens = ? WHERE id = ?', tokens, uni);
}

export async function login(n: Nucleo, email: string, agente?: string): Promise<Cliente> {
  const c = new Cliente(n);
  const desde = n.cantidadMails();
  const op = agente ? { encabezados: { 'user-agent': agente } } : {};
  const r = await c.post('/api/login/codigo', { email }, op);
  expect(r.status, `pedir código: ${r.texto}`).toBe(200);
  const { esperarCodigo } = await import('../comun/sesion.ts');
  const codigo = await esperarCodigo(n, email, desde);
  const v = await c.post('/api/login/verificar', { email, codigo }, op);
  expect(v.status, `verificar: ${v.texto}`).toBe(200);
  c.email = email;
  return c;
}

export { sesion as sesionDe };

export function consumir(n: Nucleo, d: { curso: string; universidad: number; usuario: number; tokens: number }) {
  const ahora = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  ejecutarSql(
    n,
    `INSERT INTO uso_modelo (curso_id, universidad_id, mes, fecha, ruta, estado, modelo, tokens_entrada, tokens_salida, tokens_cache_creacion, tokens_cache_lectura, usd, usuario_id, tokens)
     VALUES (?, ?, ?, ?, '/v1/messages', 200, 'claude-haiku-5-5', ?, 0, 0, 0, 0, ?, ?)`,
    d.curso,
    d.universidad,
    mesActual(),
    ahora,
    d.tokens,
    d.usuario,
    d.tokens,
  );
}
