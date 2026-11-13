import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { identidadCampus, requiereRol, obtenerIdentidad, encabezadoIdentidad } from '../dist/hono.js';
import { ErrorIdentidad } from '../dist/index.js';
import { carga, firmar, nuevoPar, T } from './ayudas.ts';

const par = nuevoPar();
const otro = nuevoPar();

function de(rol: string, extra: Record<string, unknown> = {}, privada = par.privada): string {
  return firmar(carga({ rol, ...extra }), privada);
}

function app(opciones: Parameters<typeof identidadCampus>[0] = { clavePublica: par.publica, curso: 'redes', ahora: () => T + 1 }) {
  const a = new Hono();
  a.use('*', identidadCampus(opciones));
  a.get('/yo', (c) => c.json(obtenerIdentidad(c)));
  a.get('/docentes', requiereRol('profesor'), (c) => c.json({ ok: true }));
  a.get('/duenio', requiereRol('dueño'), (c) => c.json({ ok: true }));
  a.get('/alumnos', requiereRol('alumno'), (c) => c.json({ ok: true }));
  a.get('/nadie', requiereRol(), (c) => c.json({ ok: true }));
  return a;
}

test('deja la identidad en el contexto', async () => {
  const r = await app().request('/yo', { headers: { 'X-Campus-Identidad': de('profesor') } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).rol, 'profesor');
});

test('401 con código ante identidad inválida', async () => {
  const casos: [Record<string, string>, string][] = [
    [{}, 'ausente'],
    [{ 'X-Campus-Identidad': 'basura' }, 'formato'],
    [{ 'X-Campus-Identidad': de('alumno', {}, otro.privada) }, 'firma'],
    [{ 'X-Campus-Identidad': de('alumno', { curso: 'otro' }) }, 'curso'],
    [{ Cookie: `X-Campus-Identidad=${de('alumno')}` }, 'ausente'],
    [{ Authorization: `Bearer ${de('alumno')}` }, 'ausente'],
    [{ 'X-Campus-Rol': 'profesor', 'X-Forwarded-User': 'u' }, 'ausente'],
  ];
  for (const [headers, codigo] of casos) {
    const r = await app().request('/yo', { headers });
    assert.equal(r.status, 401);
    assert.deepEqual(await r.json(), { error: 'identidad_invalida', codigo });
  }
  const r = await app().request(`/yo?X-Campus-Identidad=${de('alumno')}`);
  assert.equal(r.status, 401);
});

test('usa el reloj inyectado', async () => {
  const r = await app({ clavePublica: par.publica, curso: 'redes', ahora: () => T + 600 }).request('/yo', { headers: { 'X-Campus-Identidad': de('alumno') } });
  assert.deepEqual(await r.json(), { error: 'identidad_invalida', codigo: 'vencido' });
});

test('configuración inválida niega el acceso', async () => {
  for (const op of [{ clavePublica: 'mala', curso: 'redes' }, { clavePublica: par.publica, curso: '' }]) {
    const r = await app({ ...op, ahora: () => T }).request('/yo', { headers: { 'X-Campus-Identidad': de('alumno') } });
    assert.equal(r.status, 401);
    assert.equal((await r.json()).codigo, 'configuracion');
  }
});

test('lee el entorno por defecto en cada pedido', async () => {
  const antes = { c: process.env.CAMPUSIA_CLAVE_PUBLICA, k: process.env.CAMPUSIA_CURSO };
  const t = Math.floor(Date.now() / 1000);
  const enc = firmar(carga({ emitido: t, vence: t + 60 }), par.privada);
  const a = app({});
  try {
    delete process.env.CAMPUSIA_CLAVE_PUBLICA;
    delete process.env.CAMPUSIA_CURSO;
    let r = await a.request('/yo', { headers: { 'X-Campus-Identidad': enc } });
    assert.equal((await r.json()).codigo, 'configuracion');
    process.env.CAMPUSIA_CLAVE_PUBLICA = par.publica;
    process.env.CAMPUSIA_CURSO = 'redes';
    r = await a.request('/yo', { headers: { 'X-Campus-Identidad': enc } });
    assert.equal(r.status, 200);
  } finally {
    if (antes.c === undefined) delete process.env.CAMPUSIA_CLAVE_PUBLICA; else process.env.CAMPUSIA_CLAVE_PUBLICA = antes.c;
    if (antes.k === undefined) delete process.env.CAMPUSIA_CURSO; else process.env.CAMPUSIA_CURSO = antes.k;
  }
});

test('requiereRol', async () => {
  const casos: [string, string, number][] = [
    ['/docentes', 'profesor', 200], ['/docentes', 'dueño', 200], ['/docentes', 'alumno', 403],
    ['/duenio', 'dueño', 200], ['/duenio', 'profesor', 403], ['/duenio', 'alumno', 403],
    ['/alumnos', 'alumno', 200], ['/alumnos', 'profesor', 403], ['/alumnos', 'dueño', 403],
    ['/nadie', 'dueño', 403],
  ];
  for (const [ruta, rol, estado] of casos) {
    const r = await app().request(ruta, { headers: { 'X-Campus-Identidad': de(rol) } });
    assert.equal(r.status, estado, `${ruta} ${rol}`);
    if (estado === 403) assert.deepEqual(await r.json(), { error: 'prohibido' });
  }
});

test('requiereRol sin identidad responde 401', async () => {
  const a = new Hono();
  a.get('/docentes', requiereRol('profesor'), (c) => c.json({ ok: true }));
  const r = await a.request('/docentes', { headers: { 'X-Campus-Rol': 'profesor' } });
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error, 'identidad_invalida');
});

test('requiereRol rechaza roles desconocidos al configurarse', () => {
  assert.throws(() => requiereRol('admin' as never), TypeError);
});

test('obtenerIdentidad lanza sin identidad', async () => {
  const a = new Hono();
  a.get('/yo', (c) => {
    try {
      obtenerIdentidad(c);
      return c.text('mal');
    } catch (error) {
      return c.text(error instanceof ErrorIdentidad ? error.codigo : 'otro');
    }
  });
  assert.equal(await (await a.request('/yo')).text(), 'ausente');
});

test('encabezadoIdentidad devuelve el encabezado crudo ya verificado', async () => {
  const a = new Hono();
  a.use('*', identidadCampus({ clavePublica: par.publica, curso: 'redes', ahora: () => T + 1 }));
  a.get('/crudo', (c) => c.text(encabezadoIdentidad(c)));
  const valor = de('alumno');
  const r = await a.request('/crudo', { headers: { 'X-Campus-Identidad': valor } });
  assert.equal(r.status, 200);
  assert.equal(await r.text(), valor);
  assert.equal((await a.request('/crudo', { headers: { 'X-Campus-Identidad': de('alumno', {}, otro.privada) } })).status, 401);
});

test('encabezadoIdentidad lanza sin identidad verificada', async () => {
  const a = new Hono();
  a.get('/crudo', (c) => {
    try {
      encabezadoIdentidad(c);
      return c.text('mal');
    } catch (error) {
      return c.text(error instanceof ErrorIdentidad ? error.codigo : 'otro');
    }
  });
  assert.equal(await (await a.request('/crudo', { headers: { 'X-Campus-Identidad': de('alumno') } })).text(), 'ausente');
});
