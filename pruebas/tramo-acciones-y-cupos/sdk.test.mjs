import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, '..', '..');
const sdk = await import(path.join(RAIZ, 'sdk', 'dist', 'index.js'));
const { ClienteCampus, ErrorApi, clienteDesdeEntorno } = sdk;

const API = 'http://10.0.0.1:8082';
const TOKEN = `cat_${'a'.repeat(43)}`;

function fetchFalso(respuestas = []) {
  const pedidos = [];
  const f = async (entrada, init = {}) => {
    const url = typeof entrada === 'string' ? entrada : entrada instanceof URL ? entrada.href : entrada.url;
    const encabezados = new Headers(init.headers ?? (typeof entrada === 'object' && 'headers' in entrada ? entrada.headers : undefined));
    let cuerpo = init.body;
    if (cuerpo instanceof Uint8Array) cuerpo = Buffer.from(cuerpo).toString('utf8');
    pedidos.push({ url, metodo: (init.method ?? 'GET').toUpperCase(), encabezados, cuerpo: cuerpo ?? null, redirect: init.redirect });
    const r = respuestas.length ? respuestas.shift() : { estado: 200, json: {} };
    const cuerpoRespuesta = r.texto ?? (r.json === undefined ? '' : JSON.stringify(r.json));
    return new Response(r.estado === 204 ? null : cuerpoRespuesta, {
      status: r.estado,
      headers: { 'content-type': r.tipo ?? 'application/json', ...(r.encabezados ?? {}) },
    });
  };
  return { f, pedidos };
}

function cliente(respuestas) {
  const falso = fetchFalso(respuestas);
  return { c: new ClienteCampus({ api: API, token: TOKEN, fetch: falso.f }), pedidos: falso.pedidos };
}

function cuerpoJson(p) {
  assert.equal(p.encabezados.get('content-type')?.split(';')[0].trim(), 'application/json', `content-type de ${p.metodo} ${p.url}`);
  return JSON.parse(p.cuerpo);
}

function comun(p, metodo, ruta) {
  assert.equal(p.metodo, metodo);
  assert.equal(p.url, `${API}${ruta}`);
  assert.equal(p.encabezados.get('authorization'), `Bearer ${TOKEN}`);
  assert.match(p.encabezados.get('accept') ?? '', /application\/json/);
  assert.ok(p.redirect === 'manual' || p.redirect === 'error', 'el SDK no sigue redirecciones');
  assert.equal(p.encabezados.get('x-campus-identidad'), null);
  assert.equal(p.encabezados.get('cookie'), null);
}

const CONFIRMACION = {
  id: 7,
  tipo: 'quitar',
  persona: { id: '12', nombre: 'Tomás García', email: 'tgarcia@mail.austral.edu.ar' },
  rol: null,
  estado: 'pendiente',
  pedida_por: { id: '3', nombre: 'Lucía Fernández' },
  creada: '2026-11-10T12:00:00Z',
  resuelta: null,
  error: null,
};

const CODIGO = { codigo: 'RED-4K7P9X', activo: true, vence: '2026-12-10T12:00:00Z' };

describe('SDK 0.3.0: acciones del profesor', () => {
  test('el paquete es la versión 0.3.0 y la plantilla la usa fija', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(RAIZ, 'sdk', 'package.json'), 'utf8'));
    assert.equal(pkg.version, '0.3.0');
    const plantilla = JSON.parse(fs.readFileSync(path.join(RAIZ, 'plantilla-curso', 'package.json'), 'utf8'));
    assert.equal(plantilla.dependencies['@campusia/sdk'], 'file:vendor/campusia-sdk-0.3.0.tgz');
    const lock = fs.readFileSync(path.join(RAIZ, 'plantilla-curso', 'pnpm-lock.yaml'), 'utf8');
    assert.match(lock, /campusia-sdk-0\.3\.0\.tgz/);
    assert.doesNotMatch(lock, /campusia-sdk-0\.2\.0\.tgz/);
  });

  test('listarInscriptos lee la lista completa de las acciones', async () => {
    const lista = {
      inscriptos: [
        { id: '3', nombre: 'Lucía Fernández', email: 'lfernandez@austral.edu.ar', rol: 'dueño', pendiente: false, suspendida: false },
        { id: '12', nombre: 'Tomás García', email: 'tgarcia@mail.austral.edu.ar', rol: 'alumno', pendiente: false, suspendida: false },
      ],
      alumnos: 1,
      profesores: 1,
    };
    const { c, pedidos } = cliente([{ estado: 200, json: lista }]);
    const r = await c.listarInscriptos();
    assert.deepEqual(r, lista);
    comun(pedidos[0], 'GET', '/api/curso/acciones/inscriptos');
  });

  test('inscribir manda los mails y el rol, con alumno por defecto', async () => {
    const resultado = { agregados: ['a@mail.austral.edu.ar'], ya_estaban: [], creados: ['a@mail.austral.edu.ar'] };
    const { c, pedidos } = cliente([
      { estado: 200, json: resultado },
      { estado: 200, json: { agregados: [], ya_estaban: ['p@austral.edu.ar'], creados: [] } },
    ]);
    assert.deepEqual(await c.inscribir(['a@mail.austral.edu.ar']), resultado);
    comun(pedidos[0], 'POST', '/api/curso/acciones/inscriptos');
    assert.deepEqual(cuerpoJson(pedidos[0]), { emails: ['a@mail.austral.edu.ar'], rol: 'alumno' });
    const r2 = await c.inscribir(['p@austral.edu.ar'], 'profesor');
    assert.deepEqual(r2.ya_estaban, ['p@austral.edu.ar']);
    assert.deepEqual(cuerpoJson(pedidos[1]), { emails: ['p@austral.edu.ar'], rol: 'profesor' });
  });

  test('importarSiu manda el archivo en base64 desde Uint8Array, ArrayBuffer o Buffer', async () => {
    const csv = 'Apellido y nombre;Correo\nPérez, Juana;jperez@mail.austral.edu.ar\n';
    const bytes = new TextEncoder().encode(csv);
    const esperado = Buffer.from(csv, 'utf8').toString('base64');
    const respuesta = { agregados: ['jperez@mail.austral.edu.ar'], ya_estaban: [], creados: ['jperez@mail.austral.edu.ar'], rechazados: [{ fila: 3, email: 'x', motivo: 'email_invalido' }] };
    const { c, pedidos } = cliente([
      { estado: 200, json: respuesta },
      { estado: 200, json: respuesta },
      { estado: 200, json: respuesta },
    ]);
    assert.deepEqual(await c.importarSiu('listado.csv', bytes), respuesta);
    await c.importarSiu('listado.csv', bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    await c.importarSiu('listado.csv', Buffer.from(csv, 'utf8'));
    for (const p of pedidos) {
      comun(p, 'POST', '/api/curso/acciones/inscriptos/siu');
      assert.deepEqual(cuerpoJson(p), { archivo: 'listado.csv', contenido: esperado });
    }
  });

  test('el código de inscripción se lee, se genera y se activa', async () => {
    const { c, pedidos } = cliente([
      { estado: 200, json: CODIGO },
      { estado: 200, json: CODIGO },
      { estado: 200, json: CODIGO },
      { estado: 200, json: { ...CODIGO, activo: false } },
    ]);
    assert.deepEqual(await c.codigoInscripcion(), CODIGO);
    comun(pedidos[0], 'GET', '/api/curso/acciones/codigo');
    await c.generarCodigo(10);
    comun(pedidos[1], 'POST', '/api/curso/acciones/codigo');
    assert.deepEqual(cuerpoJson(pedidos[1]), { dias: 10 });
    await c.generarCodigo();
    assert.deepEqual(cuerpoJson(pedidos[2]), {});
    const r = await c.activarCodigo(false);
    assert.equal(r.activo, false);
    comun(pedidos[3], 'POST', '/api/curso/acciones/codigo/activo');
    assert.deepEqual(cuerpoJson(pedidos[3]), { activo: false });
  });

  test('pedirQuitar y pedirCambioDeRol devuelven la confirmación pendiente (202)', async () => {
    const { c, pedidos } = cliente([
      { estado: 202, json: CONFIRMACION },
      { estado: 202, json: { ...CONFIRMACION, id: 8, tipo: 'rol', rol: 'profesor' } },
    ]);
    const q = await c.pedirQuitar(12);
    assert.deepEqual(q, CONFIRMACION);
    comun(pedidos[0], 'POST', '/api/curso/acciones/quitar');
    assert.deepEqual(cuerpoJson(pedidos[0]), { usuario_id: '12' });
    const r = await c.pedirCambioDeRol('12', 'profesor');
    assert.equal(r.tipo, 'rol');
    assert.equal(r.rol, 'profesor');
    comun(pedidos[1], 'POST', '/api/curso/acciones/rol');
    assert.deepEqual(cuerpoJson(pedidos[1]), { usuario_id: '12', rol: 'profesor' });
  });

  test('confirmaciones devuelve el arreglo de pendientes', async () => {
    const { c, pedidos } = cliente([{ estado: 200, json: { confirmaciones: [CONFIRMACION] } }]);
    assert.deepEqual(await c.confirmaciones(), [CONFIRMACION]);
    comun(pedidos[0], 'GET', '/api/curso/acciones/confirmaciones');
  });

  test('los errores de la plataforma llegan con su código y los mails rechazados', async () => {
    const casos = [
      [400, { error: 'dominio_no_habilitado', mensaje: 'x', emails: ['a@gmail.com'] }, 'dominio_no_habilitado', ['a@gmail.com']],
      [400, { error: 'email_invalido', mensaje: 'x', emails: ['no-es-mail'] }, 'email_invalido', ['no-es-mail']],
      [400, { error: 'no_es_profesor', mensaje: 'x', emails: ['tgarcia@mail.austral.edu.ar'] }, 'no_es_profesor', ['tgarcia@mail.austral.edu.ar']],
      [409, { error: 'es_dueno', mensaje: 'x' }, 'es_dueno', undefined],
      [400, { error: 'archivo_invalido', mensaje: 'x' }, 'archivo_invalido', undefined],
      [400, { error: 'datos_invalidos', mensaje: 'x' }, 'datos_invalidos', undefined],
      [403, { error: 'prohibido', mensaje: 'x' }, 'prohibido', undefined],
      [401, { error: 'no_autenticado' }, 'no_autorizado', undefined],
      [404, { error: 'no_encontrado' }, 'no_encontrado', undefined],
      [429, { error: 'demasiados_intentos' }, 'demasiados_intentos', undefined],
    ];
    for (const [estado, json, codigo, emails] of casos) {
      const { c } = cliente([{ estado, json }]);
      await assert.rejects(
        () => c.inscribir(['a@gmail.com']),
        (e) => {
          assert.ok(e instanceof ErrorApi, `${estado} ${json.error}`);
          assert.equal(e.codigo, codigo, `${estado} ${json.error}`);
          if (emails) assert.deepEqual(e.emails, emails);
          return true;
        },
      );
    }
  });

  test('una redirección no se sigue y es una respuesta inválida', async () => {
    const { c, pedidos } = cliente([{ estado: 302, texto: '', encabezados: { location: 'http://evil.example/robar' } }]);
    await assert.rejects(() => c.pedirQuitar('12'), (e) => e instanceof ErrorApi && e.codigo === 'respuesta_invalida');
    assert.equal(pedidos.length, 1);
  });

  test('clienteDesdeEntorno usa el token del agente si está y si no el del curso', async () => {
    const original = globalThis.fetch;
    const falso = fetchFalso([
      { estado: 200, json: { confirmaciones: [] } },
      { estado: 200, json: { confirmaciones: [] } },
      { estado: 200, json: { confirmaciones: [] } },
    ]);
    globalThis.fetch = falso.f;
    try {
      const cct = `cct_${'c'.repeat(43)}`;
      await clienteDesdeEntorno({ CAMPUSIA_API: API, CAMPUSIA_TOKEN_CURSO: cct, CAMPUSIA_TOKEN_AGENTE: TOKEN }).confirmaciones();
      await clienteDesdeEntorno({ CAMPUSIA_API: `${API}/`, CAMPUSIA_TOKEN_CURSO: cct, CAMPUSIA_TOKEN_AGENTE: '' }).confirmaciones();
      await clienteDesdeEntorno({ CAMPUSIA_API: API, CAMPUSIA_TOKEN_AGENTE: TOKEN }).confirmaciones();
    } finally {
      globalThis.fetch = original;
    }
    assert.equal(falso.pedidos[0].encabezados.get('authorization'), `Bearer ${TOKEN}`);
    assert.equal(falso.pedidos[1].encabezados.get('authorization'), `Bearer cct_${'c'.repeat(43)}`);
    assert.equal(falso.pedidos[1].url, `${API}/api/curso/acciones/confirmaciones`);
    assert.equal(falso.pedidos[2].encabezados.get('authorization'), `Bearer ${TOKEN}`);
    assert.throws(() => clienteDesdeEntorno({ CAMPUSIA_API: API }), (e) => e instanceof ErrorApi && e.codigo === 'configuracion');
  });

  test('lo que ya existía sigue igual', async () => {
    const { c, pedidos } = cliente([{ estado: 200, json: [{ id: '3', nombre: 'Lucía', email: 'l@austral.edu.ar', rol: 'dueño' }] }]);
    const r = await c.inscriptos();
    assert.equal(r[0].rol, 'dueño');
    comun(pedidos[0], 'GET', '/api/curso/inscriptos');
  });
});

describe('instrucciones y entorno del agente', () => {
  const METODOS = ['listarInscriptos', 'inscribir', 'importarSiu', 'codigoInscripcion', 'generarCodigo', 'activarCodigo', 'pedirQuitar', 'pedirCambioDeRol', 'confirmaciones'];

  test('el CLAUDE.md de la plantilla describe las acciones y cómo usarlas con el SDK', () => {
    const texto = fs.readFileSync(path.join(RAIZ, 'plantilla-curso', 'CLAUDE.md'), 'utf8');
    assert.match(texto, /Acciones del profesor/);
    for (const m of METODOS) assert.ok(texto.includes(m), `falta ${m} en plantilla-curso/CLAUDE.md`);
    assert.ok(texto.includes('clienteDesdeEntorno'));
    assert.match(texto, /panel Editar/);
    assert.match(texto, /confirm/i);
  });

  test('la imagen del espacio instala las mismas instrucciones como memoria gestionada', () => {
    const dir = path.join(RAIZ, 'despliegue', 'espacio-trabajo');
    const containerfile = fs.readFileSync(path.join(dir, 'Containerfile'), 'utf8');
    assert.match(containerfile, /\/etc\/claude-code\/CLAUDE\.md/);
    const candidatos = fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => /CLAUDE\.md$/.test(f));
    assert.ok(candidatos.length > 0, 'no hay un CLAUDE.md en despliegue/espacio-trabajo');
    const texto = candidatos.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
    for (const m of METODOS) assert.ok(texto.includes(m), `falta ${m} en el CLAUDE.md del espacio`);
  });

  test('el agente y su shell conservan el token del agente y siguen borrando los demás', () => {
    const dir = path.join(RAIZ, 'despliegue', 'espacio-trabajo');
    for (const archivo of ['bin/campusia-agente', 'lib/bash']) {
      const texto = fs.readFileSync(path.join(dir, archivo), 'utf8');
      const borrados = texto
        .split('\n')
        .filter((l) => /^\s*unset\b/.test(l))
        .join(' ');
      assert.ok(!borrados.includes('CAMPUSIA_TOKEN_AGENTE'), `${archivo} borra CAMPUSIA_TOKEN_AGENTE`);
      assert.ok(!/\bCAMPUSIA_API\b/.test(borrados), `${archivo} borra CAMPUSIA_API`);
      for (const v of ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CAMPUSIA_TOKEN_CURSO']) {
        assert.ok(borrados.includes(v), `${archivo} tiene que seguir borrando ${v}`);
      }
    }
  });

  test('el ejemplo de entorno trae las variables nuevas sin secretos', () => {
    const texto = fs.readFileSync(path.join(RAIZ, 'despliegue', 'campusia.env.ejemplo'), 'utf8');
    assert.match(texto, /^RESERVA_TOKENS_PEDIDO=\d*$/m);
    assert.match(texto, /^ESPERA_SIN_USO_SEG=\d*$/m);
    assert.doesNotMatch(texto, /sk-ant-/);
    assert.doesNotMatch(texto, /cat_[A-Za-z0-9_-]{43}/);
  });
});
