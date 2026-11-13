import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClienteCampus, ErrorApi, clienteDesdeEntorno, type CodigoErrorApi } from '../dist/index.js';

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

function nuevo(responder: (url: string) => Response | Promise<Response>) {
  const { f, pedidos } = falso(responder);
  return { cliente: new ClienteCampus({ api: 'http://nucleo:8082', token: 'cat_prueba', fetch: f }), pedidos };
}

function cuerpo(p: Pedido): unknown {
  const h = new Headers(p.init?.headers);
  assert.equal(h.get('content-type'), 'application/json');
  return JSON.parse(String(p.init?.body));
}

async function errorDe(fn: () => unknown): Promise<ErrorApi> {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof ErrorApi, String(error));
    return error;
  }
  assert.fail('se esperaba ErrorApi');
}

const CONFIRMACION = {
  id: 4,
  tipo: 'rol',
  persona: { id: '9', nombre: 'Ana Gómez', email: 'ana.gomez@austral.edu.ar' },
  rol: 'profesor',
  estado: 'pendiente',
  pedida_por: { id: '3', nombre: 'Lucía Fernández' },
  creada: '2026-11-10T12:00:00Z',
  resuelta: null,
  error: null,
};

test('listarInscriptos valida la lista y acepta ids numéricos', async () => {
  const { cliente, pedidos } = nuevo(() =>
    json(200, {
      inscriptos: [{ id: 3, nombre: 'Lucía', email: 'l@austral.edu.ar', rol: 'dueño', pendiente: false, suspendida: false }],
      alumnos: 0,
      profesores: 1,
    }),
  );
  const r = await cliente.listarInscriptos();
  assert.equal(r.inscriptos[0]!.id, '3');
  assert.equal(r.profesores, 1);
  assert.equal(pedidos[0]!.url, 'http://nucleo:8082/api/curso/acciones/inscriptos');
  assert.equal(pedidos[0]!.init?.method, 'GET');
});

test('una lista mal formada es una respuesta inválida', async () => {
  const { cliente } = nuevo(() => json(200, { inscriptos: [{ id: '3', rol: 'admin' }], alumnos: 0, profesores: 0 }));
  assert.equal((await errorDe(() => cliente.listarInscriptos())).codigo, 'respuesta_invalida');
});

test('inscribir rechaza algo que no es un arreglo sin pedir nada', async () => {
  const { cliente, pedidos } = nuevo(() => json(200, {}));
  await assert.rejects(() => cliente.inscribir('a@austral.edu.ar' as unknown as string[]), TypeError);
  assert.equal(pedidos.length, 0);
});

test('importarSiu codifica en base64 estándar, también desde un Blob', async () => {
  const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x41, 0x3e, 0x3f]);
  const respuesta = { agregados: [], ya_estaban: [], creados: [], rechazados: [] };
  const { cliente, pedidos } = nuevo(() => json(200, respuesta));
  assert.deepEqual(await cliente.importarSiu('siu.xlsx', bytes), respuesta);
  await cliente.importarSiu('siu.xlsx', new Blob([bytes]));
  for (const p of pedidos) {
    assert.equal(p.url, 'http://nucleo:8082/api/curso/acciones/inscriptos/siu');
    assert.deepEqual(cuerpo(p), { archivo: 'siu.xlsx', contenido: '//4AQT4/' });
  }
});

test('el código acepta un curso sin código', async () => {
  const { cliente } = nuevo(() => json(200, { codigo: null, activo: false, vence: null }));
  assert.deepEqual(await cliente.codigoInscripcion(), { codigo: null, activo: false, vence: null });
});

test('activarCodigo exige un booleano', async () => {
  const { cliente, pedidos } = nuevo(() => json(200, {}));
  await assert.rejects(() => cliente.activarCodigo('no' as unknown as boolean), TypeError);
  assert.equal(pedidos.length, 0);
});

test('pedirCambioDeRol devuelve la confirmación del 202', async () => {
  const { cliente, pedidos } = nuevo(() => json(202, CONFIRMACION));
  assert.deepEqual(await cliente.pedirCambioDeRol(9, 'profesor'), CONFIRMACION);
  assert.deepEqual(cuerpo(pedidos[0]!), { usuario_id: '9', rol: 'profesor' });
  assert.equal(pedidos[0]!.init?.method, 'POST');
  assert.equal(pedidos[0]!.init?.redirect, 'manual');
});

test('una confirmación con un estado desconocido es una respuesta inválida', async () => {
  const { cliente } = nuevo(() => json(200, { confirmaciones: [{ ...CONFIRMACION, estado: 'ejecutada' }] }));
  assert.equal((await errorDe(() => cliente.confirmaciones())).codigo, 'respuesta_invalida');
});

test('los errores nuevos conservan el código y los mails', async () => {
  const casos: Array<[number, Record<string, unknown>, CodigoErrorApi]> = [
    [400, { error: 'dominio_no_habilitado', emails: ['x@gmail.com'] }, 'dominio_no_habilitado'],
    [409, { error: 'es_dueno' }, 'es_dueno'],
    [400, { error: 'no_es_profesor', emails: ['a@austral.edu.ar'] }, 'no_es_profesor'],
    [400, { error: 'archivo_invalido' }, 'archivo_invalido'],
    [400, { error: 'email_invalido', emails: ['@'] }, 'email_invalido'],
    [409, { error: 'otra_cosa' }, 'respuesta_invalida'],
    [403, { error: 'prohibido' }, 'prohibido'],
  ];
  for (const [estado, datos, codigo] of casos) {
    const { cliente } = nuevo(() => json(estado, datos));
    const e = await errorDe(() => cliente.pedirQuitar('9'));
    assert.equal(e.codigo, codigo);
    assert.equal(e.estado, estado);
    assert.deepEqual(e.emails, datos.emails);
  }
});

test('clienteDesdeEntorno prefiere el token del agente', async () => {
  const original = globalThis.fetch;
  const { f, pedidos } = falso(() => json(200, { confirmaciones: [] }));
  globalThis.fetch = f;
  try {
    await clienteDesdeEntorno({ CAMPUSIA_API: 'http://x', CAMPUSIA_TOKEN_AGENTE: 'cat_a', CAMPUSIA_TOKEN_CURSO: 'cct_c' }).confirmaciones();
    await clienteDesdeEntorno({ CAMPUSIA_API: 'http://x', CAMPUSIA_TOKEN_AGENTE: '', CAMPUSIA_TOKEN_CURSO: 'cct_c' }).confirmaciones();
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(new Headers(pedidos[0]!.init?.headers).get('authorization'), 'Bearer cat_a');
  assert.equal(new Headers(pedidos[1]!.init?.headers).get('authorization'), 'Bearer cct_c');
  assert.equal((await errorDe(() => clienteDesdeEntorno({ CAMPUSIA_API: 'http://x', CAMPUSIA_TOKEN_AGENTE: '' }))).codigo, 'configuracion');
});
