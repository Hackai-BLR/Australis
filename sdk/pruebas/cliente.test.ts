import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClienteCampus, ErrorApi, clienteDesdeEntorno, type CodigoErrorApi } from '../dist/index.js';

const CURSO = { id: 'redes', nombre: 'Redes de Computadoras', periodo: '2.º cuatrimestre 2026' };
const INSCRIPTOS = [
  { id: 'u-duenio', nombre: 'Lucía Fernández', email: 'lucia.fernandez@austral.edu.ar', rol: 'dueño' },
  { id: 'u-alumno-1', nombre: 'Ana Gómez', email: 'ana.gomez@austral.edu.ar', rol: 'alumno' },
];

interface Pedido {
  url: string;
  init: RequestInit | undefined;
}

function falso(responder: (url: string) => Response | Promise<Response>) {
  const pedidos: Pedido[] = [];
  const f = (async (entrada: string | URL | Request, init?: RequestInit) => {
    const url = String(entrada);
    pedidos.push({ url, init });
    return responder(url);
  }) as typeof fetch;
  return { f, pedidos };
}

function json(estado: number, cuerpo: unknown): Response {
  return new Response(JSON.stringify(cuerpo), { status: estado, headers: { 'content-type': 'application/json' } });
}

async function codigoDe(fn: () => unknown): Promise<{ codigo: CodigoErrorApi; estado: number | undefined }> {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof ErrorApi, String(error));
    assert.equal(error.name, 'ErrorApi');
    return { codigo: error.codigo, estado: error.estado };
  }
  assert.fail('se esperaba ErrorApi');
}

test('yo() pide con Bearer, Accept y sin seguir redirecciones', async () => {
  const { f, pedidos } = falso(() => json(200, { ...CURSO, extra: 1 }));
  const cliente = new ClienteCampus({ api: 'http://nucleo:8080', token: 'tok', fetch: f });
  assert.deepEqual(await cliente.yo(), CURSO);
  const p = pedidos[0]!;
  assert.equal(p.url, 'http://nucleo:8080/api/curso/yo');
  const h = new Headers(p.init?.headers);
  assert.equal(h.get('authorization'), 'Bearer tok');
  assert.equal(h.get('accept'), 'application/json');
  assert.equal(h.get('cookie'), null);
  assert.equal(h.get('x-campus-identidad'), null);
  assert.equal(p.init?.redirect, 'manual');
});

test('inscriptos() devuelve el arreglo', async () => {
  const { f, pedidos } = falso(() => json(200, INSCRIPTOS));
  const cliente = new ClienteCampus({ api: 'http://host/plataforma//', token: 'tok', fetch: f });
  assert.deepEqual(await cliente.inscriptos(), INSCRIPTOS);
  assert.equal(pedidos[0]!.url, 'http://host/plataforma/api/curso/inscriptos');
});

test('mapea los estados HTTP', async () => {
  const casos: [number, CodigoErrorApi][] = [
    [401, 'no_autorizado'], [403, 'prohibido'], [404, 'no_encontrado'], [500, 'servidor'], [503, 'servidor'],
    [302, 'respuesta_invalida'], [301, 'respuesta_invalida'], [400, 'respuesta_invalida'],
  ];
  for (const [estado, codigo] of casos) {
    const { f } = falso(() => new Response(null, { status: estado, headers: estado < 400 ? { location: 'http://otro/' } : {} }));
    const e = await codigoDe(() => new ClienteCampus({ api: 'http://x', token: 't', fetch: f }).yo());
    assert.equal(e.codigo, codigo, String(estado));
    assert.equal(e.estado, estado);
  }
});

test('respuestas inválidas', async () => {
  const cuerpos: [string, () => Promise<unknown>][] = [];
  for (const cuerpo of ['<html>', '', '{"id":1}', 'null']) {
    const { f } = falso(() => new Response(cuerpo, { status: 200 }));
    cuerpos.push([cuerpo, () => new ClienteCampus({ api: 'http://x', token: 't', fetch: f }).yo()]);
  }
  for (const cuerpo of ['{}', '[{"id":"a","nombre":"b","email":"c","rol":"admin"}]', '[1]']) {
    const { f } = falso(() => new Response(cuerpo, { status: 200 }));
    cuerpos.push([cuerpo, () => new ClienteCampus({ api: 'http://x', token: 't', fetch: f }).inscriptos()]);
  }
  for (const [cuerpo, fn] of cuerpos) {
    assert.equal((await codigoDe(fn)).codigo, 'respuesta_invalida', cuerpo);
  }
});

test('fallo de conexión es red', async () => {
  const f = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
  assert.equal((await codigoDe(() => new ClienteCampus({ api: 'http://x', token: 't', fetch: f }).yo())).codigo, 'red');
});

test('configuración', async () => {
  for (const op of [
    { api: '', token: 't' },
    { api: 'http://x', token: '' },
    { api: 'no es url', token: 't' },
    { api: 'ftp://x', token: 't' },
    { api: 'http://x', token: 'con espacio' },
    { api: 'http://x', token: 'a\r\nb' },
  ]) {
    assert.equal((await codigoDe(() => new ClienteCampus(op))).codigo, 'configuracion', JSON.stringify(op));
  }
  assert.equal((await codigoDe(() => clienteDesdeEntorno({}))).codigo, 'configuracion');
  assert.equal((await codigoDe(() => clienteDesdeEntorno({ CAMPUSIA_API: 'http://x' }))).codigo, 'configuracion');
  assert.equal((await codigoDe(() => clienteDesdeEntorno({ CAMPUSIA_TOKEN_CURSO: 't' }))).codigo, 'configuracion');
  assert.ok(clienteDesdeEntorno({ CAMPUSIA_API: 'http://x', CAMPUSIA_TOKEN_CURSO: 't' }) instanceof ClienteCampus);
});

test('clienteDesdeEntorno usa process.env por defecto', async () => {
  const antes = { a: process.env.CAMPUSIA_API, t: process.env.CAMPUSIA_TOKEN_CURSO };
  process.env.CAMPUSIA_API = 'http://desde-entorno';
  process.env.CAMPUSIA_TOKEN_CURSO = 't';
  try {
    assert.ok(clienteDesdeEntorno() instanceof ClienteCampus);
  } finally {
    if (antes.a === undefined) delete process.env.CAMPUSIA_API; else process.env.CAMPUSIA_API = antes.a;
    if (antes.t === undefined) delete process.env.CAMPUSIA_TOKEN_CURSO; else process.env.CAMPUSIA_TOKEN_CURSO = antes.t;
  }
});

test('el token no aparece en los mensajes de error', async () => {
  const { f } = falso(() => json(401, {}));
  try {
    await new ClienteCampus({ api: 'http://x', token: 'secreto-de-prueba', fetch: f }).yo();
  } catch (error) {
    assert.ok(!String((error as Error).message).includes('secreto-de-prueba'));
    assert.ok(!JSON.stringify(error).includes('secreto-de-prueba'));
  }
});
