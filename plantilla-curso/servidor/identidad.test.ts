import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ahoraSeg, armar, firmar, identidadDe, nuevoParDeClaves, PERSONAS } from './prueba-utiles.ts';

const RUTAS = ['/', '/index.html', '/assets/app.js', '/api/yo', '/api/portada', '/api/clases', '/api/no-existe', '/cualquier/cosa'];

async function todas401(pedir: ReturnType<typeof armar>['pedir'], headers: Record<string, string>, ruta = '') {
  for (const r of RUTAS) {
    const res = await pedir(r + ruta, { headers });
    assert.equal(res.status, 401, `${r} devolvió ${res.status}`);
    const cuerpo = (await res.json()) as { error: string };
    assert.equal(cuerpo.error, 'identidad_invalida');
  }
}

test('/salud responde sin identidad', async () => {
  const { pedir } = armar();
  const res = await pedir('/salud');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { estado: 'ok' });
});

test('sin encabezado todo lo demás da 401', async () => {
  const { pedir } = armar();
  await todas401(pedir, {});
});

test('identidades inválidas dan 401', async () => {
  const { pedir, par } = armar();
  const otro = nuevoParDeClaves();
  const t = ahoraSeg();
  const casos = [
    identidadDe('duenio', otro.privada),
    identidadDe('duenio', par.privada, { curso: 'otro' }),
    identidadDe('duenio', par.privada, { v: 2 }),
    identidadDe('duenio', par.privada, { rol: 'admin' }),
    firmar({ v: 1, curso: 'redes', ...PERSONAS.duenio, emitido: t - 200, vence: t - 80 }, par.privada),
    firmar({ v: 1, curso: 'redes', ...PERSONAS.duenio, emitido: t + 600, vence: t + 660 }, par.privada),
    firmar({ v: 1, curso: 'redes', ...PERSONAS.duenio, emitido: t, vence: t + 3600 }, par.privada),
    'basura',
  ];
  for (const identidad of casos) await todas401(pedir, { 'X-Campus-Identidad': identidad });
});

test('la carga alterada no sube de rol', async () => {
  const { pedir, par } = armar();
  const [, firma] = identidadDe('alumno', par.privada).split('.');
  const t = ahoraSeg();
  const carga = Buffer.from(JSON.stringify({ v: 1, curso: 'redes', ...PERSONAS.alumno, rol: 'profesor', emitido: t, vence: t + 60 })).toString('base64url');
  await todas401(pedir, { 'X-Campus-Identidad': `${carga}.${firma}` });
});

test('la identidad no se toma de cookies, consulta ni Authorization', async () => {
  const { pedir, par } = armar();
  const enc = identidadDe('duenio', par.privada);
  await todas401(pedir, { Cookie: `X-Campus-Identidad=${enc}` });
  await todas401(pedir, { Authorization: `Bearer ${enc}` });
  await todas401(pedir, { 'X-Campus-Rol': 'profesor', 'X-Forwarded-User': 'u-duenio' });
  await todas401(pedir, {}, `?X-Campus-Identidad=${enc}`);
});

test('/api/yo refleja la identidad de cada persona', async () => {
  const { pedir } = armar();
  for (const p of ['duenio', 'profesor', 'alumno'] as const) {
    const res = await pedir('/api/yo', { persona: p });
    assert.equal(res.status, 200);
    const { usuario, email, nombre, rol } = PERSONAS[p];
    assert.deepEqual(await res.json(), { usuario, email, nombre, rol });
  }
});
