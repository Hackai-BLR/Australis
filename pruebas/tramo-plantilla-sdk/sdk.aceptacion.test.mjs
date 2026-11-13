import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { nuevoParDeClaves, firmar, cargaBase, ahoraSeg, PERSONAS, encabezadoDe } from './lib/identidad.mjs';
import { levantarPlataforma, TOKEN, CURSO, INSCRIPTOS } from './lib/plataforma-falsa.mjs';
import { cargarSdk, cargarSdkHono, urlSdk } from './lib/sdk.mjs';

let sdk, sdkHono, par, plataforma;

before(async () => {
  sdk = await cargarSdk();
  sdkHono = await cargarSdkHono();
  par = nuevoParDeClaves();
  plataforma = await levantarPlataforma({ host: '127.0.0.1' });
});

after(async () => {
  await plataforma?.cerrar();
});

test('el paquete se llama @campusia/sdk, es ESM y exporta . y ./hono', () => {
  const pkg = JSON.parse(readFileSync(new URL('package.json', urlSdk), 'utf8'));
  assert.equal(pkg.name, '@campusia/sdk');
  assert.equal(pkg.type, 'module');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.ok(pkg.exports['.'], 'falta la exportación "."');
  assert.ok(pkg.exports['./hono'], 'falta la exportación "./hono"');
  assert.deepEqual(Object.keys(pkg.dependencies || {}), [], 'el SDK no debe tener dependencias de ejecución');
});

test('verificarIdentidad devuelve la identidad completa de un encabezado válido', async () => {
  const t = ahoraSeg();
  const carga = cargaBase({ ...PERSONAS.duenio, emitido: t, vence: t + 120 });
  const id = await sdk.verificarIdentidad(firmar(carga, par.privada), { clavePublica: par.publica, curso: 'redes' });
  assert.deepEqual(
    { v: id.v, curso: id.curso, usuario: id.usuario, email: id.email, nombre: id.nombre, rol: id.rol, emitido: id.emitido, vence: id.vence },
    carga,
  );
});

test('verificarIdentidad acepta nombres y roles con caracteres no ASCII', async () => {
  const id = await sdk.verificarIdentidad(encabezadoDe('duenio', par.privada, { nombre: 'Íñigo Peña Güemes' }), { clavePublica: par.publica, curso: 'redes' });
  assert.equal(id.rol, 'dueño');
  assert.equal(id.nombre, 'Íñigo Peña Güemes');
});

test('verificarIdentidad respeta el reloj inyectado con ahora', async () => {
  const carga = cargaBase({ emitido: 1000, vence: 1100 });
  const enc = firmar(carga, par.privada);
  const id = await sdk.verificarIdentidad(enc, { clavePublica: par.publica, curso: 'redes', ahora: 1050 });
  assert.equal(id.usuario, carga.usuario);
});

test('verificarIdentidad tolera hasta 30 segundos de reloj adelantado', async () => {
  const t = 5000;
  const enc = firmar(cargaBase({ emitido: t + 29, vence: t + 89 }), par.privada);
  const id = await sdk.verificarIdentidad(enc, { clavePublica: par.publica, curso: 'redes', ahora: t });
  assert.equal(id.emitido, t + 29);
});

test('los roles válidos son dueño, profesor y alumno', async () => {
  for (const p of ['duenio', 'profesor', 'alumno']) {
    const id = await sdk.verificarIdentidad(encabezadoDe(p, par.privada), { clavePublica: par.publica, curso: 'redes' });
    assert.equal(id.rol, PERSONAS[p].rol);
  }
});

function appConMiddleware(opciones) {
  const app = new Hono();
  app.use('*', sdkHono.identidadCampus(opciones));
  app.get('/yo', (c) => c.json(sdkHono.obtenerIdentidad(c)));
  app.get('/ctx', (c) => c.json(c.get('identidad')));
  app.get('/docentes', sdkHono.requiereRol('profesor'), (c) => c.json({ ok: true }));
  app.get('/solo-duenio', sdkHono.requiereRol('dueño'), (c) => c.json({ ok: true }));
  app.get('/alumnos', sdkHono.requiereRol('alumno'), (c) => c.json({ ok: true }));
  app.get('/cualquiera', sdkHono.requiereRol('alumno', 'profesor'), (c) => c.json({ ok: true }));
  return app;
}

test('el middleware deja la identidad en el contexto', async () => {
  const app = appConMiddleware({ clavePublica: par.publica, curso: 'redes' });
  const enc = encabezadoDe('profesor', par.privada);
  for (const ruta of ['/yo', '/ctx']) {
    const r = await app.request(ruta, { headers: { 'X-Campus-Identidad': enc } });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.usuario, PERSONAS.profesor.usuario);
    assert.equal(j.rol, 'profesor');
  }
});

test('el middleware lee la clave y el curso del entorno cuando no se pasan', async () => {
  const antes = { c: process.env.CAMPUSIA_CLAVE_PUBLICA, k: process.env.CAMPUSIA_CURSO };
  process.env.CAMPUSIA_CLAVE_PUBLICA = par.publica;
  process.env.CAMPUSIA_CURSO = 'redes';
  try {
    const app = appConMiddleware();
    const r = await app.request('/yo', { headers: { 'X-Campus-Identidad': encabezadoDe('alumno', par.privada) } });
    assert.equal(r.status, 200);
  } finally {
    if (antes.c === undefined) delete process.env.CAMPUSIA_CLAVE_PUBLICA; else process.env.CAMPUSIA_CLAVE_PUBLICA = antes.c;
    if (antes.k === undefined) delete process.env.CAMPUSIA_CURSO; else process.env.CAMPUSIA_CURSO = antes.k;
  }
});

test('requiereRol deja pasar los roles indicados y el dueño cuenta como profesor', async () => {
  const app = appConMiddleware({ clavePublica: par.publica, curso: 'redes' });
  const casos = [
    ['/docentes', 'profesor', 200],
    ['/docentes', 'duenio', 200],
    ['/solo-duenio', 'duenio', 200],
    ['/alumnos', 'alumno', 200],
    ['/cualquiera', 'alumno', 200],
    ['/cualquiera', 'profesor', 200],
    ['/cualquiera', 'duenio', 200],
  ];
  for (const [ruta, p, esperado] of casos) {
    const r = await app.request(ruta, { headers: { 'X-Campus-Identidad': encabezadoDe(p, par.privada) } });
    assert.equal(r.status, esperado, `${ruta} con ${p}`);
  }
});

test('el cliente obtiene los datos del curso con yo()', async () => {
  const cliente = new sdk.ClienteCampus({ api: plataforma.url, token: TOKEN });
  assert.deepEqual(await cliente.yo(), CURSO);
  const ultimo = plataforma.pedidos.at(-1);
  assert.equal(ultimo.url, '/api/curso/yo');
  assert.equal(ultimo.encabezados.authorization, `Bearer ${TOKEN}`);
});

test('el cliente obtiene la lista de inscriptos con inscriptos()', async () => {
  const cliente = new sdk.ClienteCampus({ api: plataforma.url, token: TOKEN });
  assert.deepEqual(await cliente.inscriptos(), INSCRIPTOS);
});

test('el cliente acepta una URL base con barra final y con prefijo', async () => {
  const p = await levantarPlataforma({ host: '127.0.0.1', prefijo: '/plataforma' });
  try {
    const cliente = new sdk.ClienteCampus({ api: `${p.url}/`, token: TOKEN });
    assert.deepEqual(await cliente.yo(), CURSO);
    assert.equal(p.pedidos.at(-1).url, '/plataforma/api/curso/yo');
  } finally {
    await p.cerrar();
  }
});

test('clienteDesdeEntorno usa CAMPUSIA_API y CAMPUSIA_TOKEN_CURSO', async () => {
  const cliente = sdk.clienteDesdeEntorno({ CAMPUSIA_API: plataforma.url, CAMPUSIA_TOKEN_CURSO: TOKEN });
  assert.deepEqual(await cliente.yo(), CURSO);
});
