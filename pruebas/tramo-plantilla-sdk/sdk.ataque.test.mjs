import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Hono } from 'hono';
import { nuevoParDeClaves, firmar, firmarCadena, cargaBase, b64url, partes, encabezadoDe, ahoraSeg } from './lib/identidad.mjs';
import { levantarPlataforma, TOKEN } from './lib/plataforma-falsa.mjs';
import { intentar } from './lib/http.mjs';
import { cargarSdk, cargarSdkHono } from './lib/sdk.mjs';

let sdk, sdkHono, par, otroPar;

before(async () => {
  sdk = await cargarSdk();
  sdkHono = await cargarSdkHono();
  par = nuevoParDeClaves();
  otroPar = nuevoParDeClaves();
});

async function rechaza(encabezado, codigos, opciones = {}) {
  const r = await intentar(() => sdk.verificarIdentidad(encabezado, { clavePublica: par.publica, curso: 'redes', ...opciones }));
  assert.equal(r.ok, false, `se aceptó un encabezado que debía rechazarse: ${String(encabezado).slice(0, 80)}`);
  assert.ok(r.error instanceof sdk.ErrorIdentidad, `el error no es ErrorIdentidad: ${r.error}`);
  if (codigos) {
    const lista = Array.isArray(codigos) ? codigos : [codigos];
    assert.ok(lista.includes(r.error.codigo), `código ${r.error.codigo}, se esperaba ${lista.join(' o ')}`);
  }
  return r.error;
}

test('encabezado ausente o vacío', async () => {
  await rechaza(undefined, 'ausente');
  await rechaza(null, 'ausente');
  await rechaza('', 'ausente');
});

test('firma hecha con otra clave', async () => {
  await rechaza(encabezadoDe('profesor', otroPar.privada), 'firma');
});

test('clave pública equivocada', async () => {
  await rechaza(encabezadoDe('profesor', par.privada), 'firma', { clavePublica: otroPar.publica });
});

test('carga alterada conservando la firma original', async () => {
  const original = encabezadoDe('alumno', par.privada);
  const { f } = partes(original);
  const alterada = b64url(Buffer.from(JSON.stringify(cargaBase({ rol: 'profesor' })), 'utf8'));
  await rechaza(`${alterada}.${f}`, 'firma');
});

test('firma truncada, vacía o de otro largo', async () => {
  const { c, f } = partes(encabezadoDe('alumno', par.privada));
  await rechaza(`${c}.${f.slice(0, -4)}`, ['firma', 'formato']);
  await rechaza(`${c}.`, ['firma', 'formato']);
  await rechaza(`${c}.${b64url(Buffer.alloc(64))}`, 'firma');
});

test('firma sobre el JSON en lugar de la cadena base64url', async () => {
  const carga = cargaBase();
  const c = b64url(Buffer.from(JSON.stringify(carga), 'utf8'));
  await rechaza(`${c}.${firmarCadena(JSON.stringify(carga), par.privada)}`, 'firma');
});

test('formatos rotos', async () => {
  const { c, f } = partes(encabezadoDe('alumno', par.privada));
  await rechaza('sin-punto', 'formato');
  await rechaza(`${c}.${f}.extra`, 'formato');
  await rechaza(`Bearer ${c}.${f}`, ['formato', 'firma']);
  await rechaza(`${c}!.${f}`, ['formato', 'firma']);
  await rechaza(`${'A'.repeat(5000)}.${f}`, ['formato', 'firma']);
});

test('carga firmada que no es JSON o le faltan campos', async () => {
  const noJson = b64url(Buffer.from('esto no es json', 'utf8'));
  await rechaza(`${noJson}.${firmarCadena(noJson, par.privada)}`, 'formato');
  const base = cargaBase();
  for (const campo of ['curso', 'usuario', 'email', 'nombre', 'rol', 'emitido', 'vence']) {
    const sinCampo = { ...base };
    delete sinCampo[campo];
    await rechaza(firmar(sinCampo, par.privada), ['formato', 'curso', 'version'], {});
  }
  await rechaza(firmar({ ...base, emitido: String(base.emitido) }, par.privada), 'formato');
  await rechaza(firmar({ ...base, vence: base.vence + 0.5 }, par.privada), 'formato');
  await rechaza(firmar([base], par.privada), 'formato');
});

test('rol desconocido aunque esté firmado', async () => {
  for (const rol of ['admin', 'owner', 'administrador', 'Profesor', 'duenio', '']) {
    await rechaza(firmar(cargaBase({ rol }), par.privada), 'formato');
  }
});

test('versión distinta de 1', async () => {
  await rechaza(firmar(cargaBase({ v: 2 }), par.privada), 'version');
  await rechaza(firmar(cargaBase({ v: '1' }), par.privada), ['version', 'formato']);
});

test('identidad emitida para otro curso', async () => {
  await rechaza(encabezadoDe('duenio', par.privada, { curso: 'otro' }), 'curso');
  await rechaza(encabezadoDe('duenio', par.privada, { curso: 'Redes' }), 'curso');
  await rechaza(encabezadoDe('duenio', par.privada, { curso: 'redes ' }), 'curso');
});

test('identidad vencida', async () => {
  const t = 10000;
  await rechaza(firmar(cargaBase({ emitido: t - 100, vence: t - 1 }), par.privada), 'vencido', { ahora: t });
  await rechaza(firmar(cargaBase({ emitido: t - 60, vence: t }), par.privada), 'vencido', { ahora: t });
  const real = ahoraSeg();
  await rechaza(firmar(cargaBase({ emitido: real - 200, vence: real - 90 }), par.privada), 'vencido');
});

test('identidad emitida en el futuro más allá de la tolerancia', async () => {
  const t = 10000;
  await rechaza(firmar(cargaBase({ emitido: t + 31, vence: t + 91 }), par.privada), 'futuro', { ahora: t });
  const real = ahoraSeg();
  await rechaza(firmar(cargaBase({ emitido: real + 300, vence: real + 400 }), par.privada), 'futuro');
});

test('vigencia mayor a 120 segundos o vence antes de emitirse', async () => {
  const t = 10000;
  await rechaza(firmar(cargaBase({ emitido: t, vence: t + 121 }), par.privada), 'vigencia', { ahora: t });
  await rechaza(firmar(cargaBase({ emitido: t, vence: t + 86400 }), par.privada), 'vigencia', { ahora: t });
  await rechaza(firmar(cargaBase({ emitido: t + 5, vence: t + 1 }), par.privada), ['vigencia', 'formato'], { ahora: t });
});

test('clave pública de configuración inválida niega el acceso', async () => {
  const enc = encabezadoDe('alumno', par.privada);
  for (const clave of ['', 'corta', b64url(Buffer.alloc(31)), b64url(Buffer.alloc(33))]) {
    await rechaza(enc, 'configuracion', { clavePublica: clave });
  }
});

function app() {
  const a = new Hono();
  a.use('*', sdkHono.identidadCampus({ clavePublica: par.publica, curso: 'redes' }));
  a.get('/x', (c) => c.json({ ok: true }));
  a.get('/docentes', sdkHono.requiereRol('profesor'), (c) => c.json({ ok: true }));
  a.get('/solo-duenio', sdkHono.requiereRol('dueño'), (c) => c.json({ ok: true }));
  return a;
}

test('el middleware responde 401 en JSON ante identidad ausente o inválida', async () => {
  const a = app();
  const casos = [
    {},
    { 'X-Campus-Identidad': 'basura' },
    { 'X-Campus-Identidad': encabezadoDe('alumno', otroPar.privada) },
    { 'X-Campus-Identidad': encabezadoDe('alumno', par.privada, { curso: 'otro' }) },
    { Cookie: `X-Campus-Identidad=${encabezadoDe('alumno', par.privada)}` },
    { Authorization: `Bearer ${encabezadoDe('alumno', par.privada)}` },
  ];
  for (const h of casos) {
    const r = await a.request('/x', { headers: h });
    assert.equal(r.status, 401, JSON.stringify(Object.keys(h)));
    const j = await r.json();
    assert.equal(j.error, 'identidad_invalida');
    assert.equal(typeof j.codigo, 'string');
  }
});

test('el middleware no acepta la identidad por parámetro de consulta', async () => {
  const r = await app().request(`/x?X-Campus-Identidad=${encabezadoDe('alumno', par.privada)}&identidad=${encabezadoDe('alumno', par.privada)}`);
  assert.equal(r.status, 401);
});

test('requiereRol responde 403 al rol que no corresponde', async () => {
  const a = app();
  const casos = [['/docentes', 'alumno'], ['/solo-duenio', 'profesor'], ['/solo-duenio', 'alumno']];
  for (const [ruta, p] of casos) {
    const r = await a.request(ruta, { headers: { 'X-Campus-Identidad': encabezadoDe(p, par.privada) } });
    assert.equal(r.status, 403, `${ruta} con ${p}`);
    assert.equal((await r.json()).error, 'prohibido');
  }
});

test('requiereRol sin identidad verificada responde 401', async () => {
  const a = new Hono();
  a.get('/docentes', sdkHono.requiereRol('profesor'), (c) => c.json({ ok: true }));
  const r = await a.request('/docentes', { headers: { 'X-Campus-Rol': 'profesor' } });
  assert.equal(r.status, 401);
});

async function errorDeCliente(fn) {
  const r = await intentar(fn);
  assert.equal(r.ok, false, 'se esperaba un error');
  assert.ok(r.error instanceof sdk.ErrorApi, `el error no es ErrorApi: ${r.error}`);
  return r.error;
}

test('el cliente tipa los errores de la plataforma', async () => {
  const estados = { 401: 'no_autorizado', 403: 'prohibido', 404: 'no_encontrado', 500: 'servidor', 503: 'servidor' };
  for (const [estado, codigo] of Object.entries(estados)) {
    const p = await levantarPlataforma({
      host: '127.0.0.1',
      manejador: (_q, res) => { res.writeHead(Number(estado), { 'content-type': 'application/json' }); res.end('{"error":"x"}'); },
    });
    try {
      const e = await errorDeCliente(() => new sdk.ClienteCampus({ api: p.url, token: TOKEN }).yo());
      assert.equal(e.estado, Number(estado));
      assert.equal(e.codigo, codigo);
    } finally {
      await p.cerrar();
    }
  }
});

test('el cliente con token equivocado recibe no_autorizado', async () => {
  const p = await levantarPlataforma({ host: '127.0.0.1' });
  try {
    const e = await errorDeCliente(() => new sdk.ClienteCampus({ api: p.url, token: 'token-de-otro-curso' }).inscriptos());
    assert.equal(e.codigo, 'no_autorizado');
  } finally {
    await p.cerrar();
  }
});

test('el cliente rechaza respuestas que no son JSON válido', async () => {
  const p = await levantarPlataforma({
    host: '127.0.0.1',
    manejador: (_q, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>hola</html>'); },
  });
  try {
    const e = await errorDeCliente(() => new sdk.ClienteCampus({ api: p.url, token: TOKEN }).yo());
    assert.equal(e.codigo, 'respuesta_invalida');
  } finally {
    await p.cerrar();
  }
});

test('el cliente informa error de red si la plataforma no responde', async () => {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const puerto = s.address().port;
  await new Promise((r) => s.close(r));
  const e = await errorDeCliente(() => new sdk.ClienteCampus({ api: `http://127.0.0.1:${puerto}`, token: TOKEN }).yo());
  assert.equal(e.codigo, 'red');
});

test('el cliente no sigue redirecciones ni filtra el token a otro servidor', async () => {
  const ajena = await levantarPlataforma({ host: '127.0.0.1' });
  const p = await levantarPlataforma({
    host: '127.0.0.1',
    manejador: (_q, res) => { res.writeHead(302, { location: `${ajena.url}/api/curso/yo` }); res.end(); },
  });
  try {
    const e = await errorDeCliente(() => new sdk.ClienteCampus({ api: p.url, token: TOKEN }).yo());
    assert.equal(e.codigo, 'respuesta_invalida');
    assert.equal(ajena.pedidos.filter((x) => x.encabezados.authorization).length, 0);
  } finally {
    await p.cerrar();
    await ajena.cerrar();
  }
});

test('el cliente sin token o sin URL falla con error de configuración', async () => {
  let e = await errorDeCliente(() => new sdk.ClienteCampus({ api: 'http://127.0.0.1:1', token: '' }));
  assert.equal(e.codigo, 'configuracion');
  e = await errorDeCliente(() => sdk.clienteDesdeEntorno({ CAMPUSIA_TOKEN_CURSO: TOKEN }));
  assert.equal(e.codigo, 'configuracion');
  e = await errorDeCliente(() => sdk.clienteDesdeEntorno({ CAMPUSIA_API: 'http://127.0.0.1:1' }));
  assert.equal(e.codigo, 'configuracion');
});
