import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClienteCampus, ErrorApi, type CodigoErrorApi } from '../dist/index.js';

const IDENTIDAD = 'carga.firma';

const ARCHIVO = {
  id: '0123456789abcdef0123456789abcdef',
  nombre: 'tp1.zip',
  tipo: 'application/zip',
  tamano: 3,
  sha256: 'ab'.repeat(32),
  material: false,
  usuario: { id: '7', nombre: 'Ana Gómez' },
  fecha: '2026-11-10T12:00:00Z',
};

const ENTREGA = {
  id: 4,
  actividad: 'tp1',
  texto: 'Mi entrega',
  archivo: ARCHIVO,
  usuario: { id: '7', nombre: 'Ana Gómez', email: 'ana.gomez@austral.edu.ar' },
  fecha: '2026-11-10T12:00:01Z',
  via: 'curso',
};

const NOTA = {
  id: 9,
  actividad: 'tp1',
  valor: '8',
  comentario: null,
  anterior: '6',
  usuario: { id: '7', nombre: 'Ana Gómez', email: 'ana.gomez@austral.edu.ar' },
  autor: { id: '3', nombre: 'Martín Sosa' },
  fecha: '2026-11-10T12:00:02Z',
  via: 'curso',
};

interface Pedido {
  url: string;
  init: RequestInit | undefined;
}

function falso(responder: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const pedidos: Pedido[] = [];
  const f = (async (entrada: string | URL | Request, init?: RequestInit) => {
    const url = String(entrada);
    pedidos.push({ url, init });
    return responder(url, init);
  }) as typeof fetch;
  return { f, pedidos, cliente: new ClienteCampus({ api: 'http://nucleo:8081', token: 'tok', fetch: f }) };
}

function json(estado: number, cuerpo: unknown): Response {
  return new Response(JSON.stringify(cuerpo), { status: estado, headers: { 'content-type': 'application/json' } });
}

function encabezados(p: Pedido): Headers {
  return new Headers(p.init?.headers);
}

function comun(p: Pedido, metodo = 'GET') {
  const h = encabezados(p);
  assert.equal(p.init?.method, metodo);
  assert.equal(h.get('authorization'), 'Bearer tok');
  assert.equal(h.get('x-campus-identidad'), IDENTIDAD);
  assert.equal(h.get('cookie'), null);
  assert.equal(p.init?.redirect, 'manual');
  assert.ok(p.init?.signal instanceof AbortSignal);
}

async function codigoDe(fn: () => unknown): Promise<{ codigo: CodigoErrorApi; estado: number | undefined }> {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof ErrorApi, String(error));
    return { codigo: error.codigo, estado: error.estado };
  }
  assert.fail('se esperaba ErrorApi');
}

test('subirArchivo manda el contenido crudo, el nombre y material', async () => {
  const { cliente, pedidos } = falso(() => json(201, { ...ARCHIVO, extra: 1 }));
  const archivo = await cliente.subirArchivo(IDENTIDAD, { nombre: 'tp 1/ñ.zip', contenido: new Uint8Array([1, 2, 3]) });
  assert.deepEqual(archivo, ARCHIVO);
  const p = pedidos[0]!;
  comun(p, 'POST');
  const url = new URL(p.url);
  assert.equal(url.pathname, '/api/curso/archivos');
  assert.equal(url.searchParams.get('nombre'), 'tp 1/ñ.zip');
  assert.equal(url.searchParams.get('material'), null);
  assert.equal(encabezados(p).get('content-type'), 'application/octet-stream');
  assert.deepEqual([...(p.init?.body as Uint8Array)], [1, 2, 3]);

  await cliente.subirArchivo(IDENTIDAD, { nombre: 'g.pdf', contenido: new Uint8Array([9]).buffer, material: true });
  assert.equal(new URL(pedidos[1]!.url).searchParams.get('material'), '1');
  await cliente.subirArchivo(IDENTIDAD, { nombre: 'b.txt', contenido: new Blob(['hola']) });
  assert.equal(Buffer.from(pedidos[2]!.init?.body as Uint8Array).toString(), 'hola');
});

test('archivos devuelve la lista, el uso y la cuota', async () => {
  const { cliente, pedidos } = falso(() => json(200, { archivos: [ARCHIVO, { ...ARCHIVO, material: true }], usado: 6, cuota: 100 }));
  const r = await cliente.archivos(IDENTIDAD);
  assert.equal(r.archivos.length, 2);
  assert.equal(r.archivos[1]!.material, true);
  assert.equal(r.usado, 6);
  assert.equal(r.cuota, 100);
  comun(pedidos[0]!);
  assert.equal(pedidos[0]!.url, 'http://nucleo:8081/api/curso/archivos');
});

test('bajarArchivo devuelve el nombre de filename*, el tipo y los bytes', async () => {
  const { cliente, pedidos } = falso(
    () =>
      new Response(new Uint8Array([0, 255, 7]), {
        status: 200,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'content-disposition': `attachment; filename="_rbol.txt"; filename*=UTF-8''%C3%A1rbol%20%22x%22.txt`,
        },
      }),
  );
  const r = await cliente.bajarArchivo(IDENTIDAD, ARCHIVO.id);
  assert.equal(r.nombre, 'árbol "x".txt');
  assert.equal(r.tipo, 'text/plain; charset=utf-8');
  assert.ok(r.contenido instanceof Uint8Array);
  assert.deepEqual([...r.contenido], [0, 255, 7]);
  comun(pedidos[0]!);
  assert.equal(pedidos[0]!.url, `http://nucleo:8081/api/curso/archivos/${ARCHIVO.id}`);
  await cliente.bajarArchivo(IDENTIDAD, '../yo');
  assert.equal(pedidos[1]!.url, 'http://nucleo:8081/api/curso/archivos/..%2Fyo');
});

test('entregar manda actividad, texto y archivo_id', async () => {
  const { cliente, pedidos } = falso(() => json(201, ENTREGA));
  assert.deepEqual(await cliente.entregar(IDENTIDAD, { actividad: 'tp1', texto: 'Mi entrega', archivoId: ARCHIVO.id }), ENTREGA);
  const p = pedidos[0]!;
  comun(p, 'POST');
  assert.equal(p.url, 'http://nucleo:8081/api/curso/entregas');
  assert.equal(encabezados(p).get('content-type'), 'application/json');
  assert.deepEqual(JSON.parse(String(p.init?.body)), { actividad: 'tp1', texto: 'Mi entrega', archivo_id: ARCHIVO.id });
  await cliente.entregar(IDENTIDAD, { actividad: 'tp2', texto: 'solo texto' });
  assert.deepEqual(JSON.parse(String(pedidos[1]!.init?.body)), { actividad: 'tp2', texto: 'solo texto' });
});

test('entregas acepta filtros y convierte ids numéricos de personas en cadenas', async () => {
  const { cliente, pedidos } = falso(() =>
    json(200, { entregas: [{ ...ENTREGA, archivo: null, texto: null, usuario: { ...ENTREGA.usuario, id: 7 } }] }),
  );
  const r = await cliente.entregas(IDENTIDAD, { actividad: 'tp 1', usuario: 7 });
  assert.equal(r[0]!.usuario.id, '7');
  assert.equal(r[0]!.archivo, null);
  assert.equal(r[0]!.texto, null);
  comun(pedidos[0]!);
  const url = new URL(pedidos[0]!.url);
  assert.equal(url.pathname, '/api/curso/entregas');
  assert.equal(url.searchParams.get('actividad'), 'tp 1');
  assert.equal(url.searchParams.get('usuario'), '7');
  await cliente.entregas(IDENTIDAD);
  assert.equal(pedidos[1]!.url, 'http://nucleo:8081/api/curso/entregas');
});

test('ponerNota manda usuario_id, actividad, valor y comentario', async () => {
  const { cliente, pedidos } = falso(() => json(201, NOTA));
  assert.deepEqual(await cliente.ponerNota(IDENTIDAD, { usuario: '7', actividad: 'tp1', valor: '8', comentario: 'Bien' }), NOTA);
  comun(pedidos[0]!, 'POST');
  assert.equal(pedidos[0]!.url, 'http://nucleo:8081/api/curso/notas');
  assert.deepEqual(JSON.parse(String(pedidos[0]!.init?.body)), { usuario_id: '7', actividad: 'tp1', valor: '8', comentario: 'Bien' });
  await cliente.ponerNota(IDENTIDAD, { usuario: 7, actividad: 'tp1', valor: '9' });
  assert.deepEqual(JSON.parse(String(pedidos[1]!.init?.body)), { usuario_id: 7, actividad: 'tp1', valor: '9' });
});

test('notas e historialNotas', async () => {
  const vigente: Record<string, unknown> = { ...NOTA };
  delete vigente.anterior;
  const { cliente, pedidos } = falso((url) => json(200, { notas: [url.includes('historial') ? NOTA : vigente] }));
  const notas = await cliente.notas(IDENTIDAD, { actividad: 'tp1' });
  assert.deepEqual(notas, [vigente]);
  assert.ok(!('anterior' in notas[0]!));
  const historial = await cliente.historialNotas(IDENTIDAD, { usuario: '7' });
  assert.deepEqual(historial, [NOTA]);
  comun(pedidos[0]!);
  comun(pedidos[1]!);
  assert.equal(pedidos[0]!.url, 'http://nucleo:8081/api/curso/notas?actividad=tp1');
  assert.equal(pedidos[1]!.url, 'http://nucleo:8081/api/curso/notas/historial?usuario=7');
});

test('los códigos de error de la plataforma llegan tipados', async () => {
  const casos: [number, string, CodigoErrorApi][] = [
    [400, 'datos_invalidos', 'datos_invalidos'],
    [400, 'nombre_invalido', 'nombre_invalido'],
    [400, 'tipo_no_permitido', 'tipo_no_permitido'],
    [400, 'no_es_alumno', 'no_es_alumno'],
    [409, 'cuota_excedida', 'cuota_excedida'],
    [413, 'archivo_demasiado_grande', 'archivo_demasiado_grande'],
    [401, 'identidad_invalida', 'identidad_invalida'],
    [429, 'demasiados_intentos', 'demasiados_intentos'],
    [401, 'no_autenticado', 'no_autorizado'],
    [403, 'prohibido', 'prohibido'],
    [404, 'no_encontrado', 'no_encontrado'],
    [500, 'archivo_alterado', 'servidor'],
    [400, 'otro_codigo', 'respuesta_invalida'],
  ];
  for (const [estado, error, codigo] of casos) {
    const { cliente } = falso(() => json(estado, { error, mensaje: 'x' }));
    const e = await codigoDe(() => cliente.entregas(IDENTIDAD));
    assert.equal(e.codigo, codigo, error);
    assert.equal(e.estado, estado);
  }
  const { cliente } = falso(() => new Response('<html>', { status: 403 }));
  assert.equal((await codigoDe(() => cliente.bajarArchivo(IDENTIDAD, 'x'))).codigo, 'prohibido');
  const sinCuerpo = falso(() => new Response(null, { status: 429 }));
  assert.equal((await codigoDe(() => sinCuerpo.cliente.notas(IDENTIDAD))).codigo, 'respuesta_invalida');
});

test('redirecciones, red y respuestas inválidas', async () => {
  const red = falso(() => {
    throw new TypeError('fetch failed');
  });
  assert.equal((await codigoDe(() => red.cliente.entregar(IDENTIDAD, { actividad: 'tp1', texto: 'x' }))).codigo, 'red');
  const redir = falso(() => new Response(null, { status: 302, headers: { location: 'http://otro/' } }));
  assert.equal((await codigoDe(() => redir.cliente.notas(IDENTIDAD))).codigo, 'respuesta_invalida');
  const malos: [string, (c: ClienteCampus) => Promise<unknown>][] = [
    ['{"entregas":{}}', (c) => c.entregas(IDENTIDAD)],
    ['{"entregas":[{"id":"x"}]}', (c) => c.entregas(IDENTIDAD)],
    ['{"notas":[{"id":1}]}', (c) => c.notas(IDENTIDAD)],
    ['{"archivos":[]}', (c) => c.archivos(IDENTIDAD)],
    ['[]', (c) => c.historialNotas(IDENTIDAD)],
    ['<html>', (c) => c.ponerNota(IDENTIDAD, { usuario: '1', actividad: 'a', valor: '1' })],
  ];
  for (const [cuerpo, fn] of malos) {
    const { cliente } = falso(() => new Response(cuerpo, { status: 200 }));
    assert.equal((await codigoDe(() => fn(cliente))).codigo, 'respuesta_invalida', cuerpo);
  }
});

test('una identidad inválida se manda igual y la rechaza la plataforma', async () => {
  for (const valor of ['', 'con espacio', 'a\r\nb', 'ñandú', undefined as unknown as string]) {
    const { cliente, pedidos } = falso((_url, init) => {
      const h = new Headers(init?.headers);
      return json(h.get('x-campus-identidad') === IDENTIDAD ? 200 : 401, { error: 'identidad_invalida' });
    });
    assert.equal((await codigoDe(() => cliente.entregas(valor))).codigo, 'identidad_invalida', String(valor));
    assert.ok(encabezados(pedidos[0]!).has('x-campus-identidad'));
  }
});

test('el token y la identidad no aparecen en los mensajes de error', async () => {
  const { f } = falso(() => json(401, { error: 'identidad_invalida' }));
  const cliente = new ClienteCampus({ api: 'http://x', token: 'secreto-de-prueba', fetch: f });
  try {
    await cliente.notas('identidad-secreta');
    assert.fail('se esperaba ErrorApi');
  } catch (error) {
    const texto = `${String((error as Error).message)} ${JSON.stringify(error)}`;
    assert.ok(!texto.includes('secreto-de-prueba'));
    assert.ok(!texto.includes('identidad-secreta'));
  }
});

test('yo e inscriptos siguen sin mandar identidad', async () => {
  const { cliente, pedidos } = falso(() => json(200, { id: 'redes', nombre: 'Redes', periodo: '2026' }));
  await cliente.yo();
  assert.equal(encabezados(pedidos[0]!).get('x-campus-identidad'), null);
});
