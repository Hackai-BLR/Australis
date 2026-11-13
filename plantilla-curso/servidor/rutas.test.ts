import { test } from 'node:test';
import assert from 'node:assert/strict';
import { armar, CURSO } from './prueba-utiles.ts';
import { abrirBaseEnMemoria, migrar } from './base.ts';
import { clavePublicaValida, leerConfiguracion } from './configuracion.ts';

test('la portada trae el curso, solo nombre y rol de los docentes, clases y yo', async () => {
  const { pedir } = armar();
  const res = await pedir('/api/portada', { persona: 'alumno' });
  assert.equal(res.status, 200);
  const texto = await res.text();
  assert.deepEqual(JSON.parse(texto), {
    curso: CURSO,
    profesores: [
      { nombre: 'Lucía Fernández', rol: 'dueño' },
      { nombre: 'Martín Sosa', rol: 'profesor' },
    ],
    clases: [],
    yo: { nombre: 'Ana Gómez', rol: 'alumno' },
  });
  assert.doesNotMatch(texto, /@austral|Bruno|u-duenio/);
});

test('los datos del curso se cachean y los inscriptos se consultan cada vez', async () => {
  const { pedir, plataforma } = armar();
  await pedir('/api/portada', { persona: 'alumno' });
  await pedir('/api/portada', { persona: 'profesor' });
  assert.equal(plataforma.llamadasYo, 1);
  assert.equal(plataforma.llamadasInscriptos, 2);
});

test('si la plataforma falla la portada da 502 y el resto sigue', async () => {
  const { pedir, plataforma } = armar();
  plataforma.caida = true;
  const res = await pedir('/api/portada', { persona: 'alumno' });
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: 'plataforma_no_disponible' });
  assert.equal((await pedir('/api/clases', { persona: 'alumno' })).status, 200);
  assert.equal((await pedir('/api/yo', { persona: 'alumno' })).status, 200);
});

test('profesor y dueño crean clases; quedan en orden', async () => {
  const { pedir, crear } = armar();
  const a = await crear('profesor', { titulo: '  Modelo OSI  ', fecha: '2026-08-25', contenido: 'Capas' });
  assert.equal(a.status, 201);
  const ca = (await a.json()) as Record<string, unknown>;
  assert.equal(typeof ca.id, 'number');
  assert.deepEqual({ ...ca, id: 0 }, { id: 0, numero: 1, titulo: 'Modelo OSI', fecha: '2026-08-25', contenido: 'Capas' });
  const b = await crear('duenio', { titulo: 'Ethernet' });
  assert.equal(b.status, 201);
  assert.deepEqual(await b.json(), { id: 2, numero: 2, titulo: 'Ethernet', fecha: null, contenido: '' });
  assert.equal((await crear('profesor', { titulo: 'Intro', numero: 0 })).status, 201);
  assert.equal((await crear('profesor', { titulo: 'Repetida', numero: 2 })).status, 201);
  const l = await pedir('/api/clases', { persona: 'alumno' });
  const clases = (await l.json()) as { numero: number; titulo: string; creada?: string }[];
  assert.deepEqual(clases.map((c) => [c.numero, c.titulo]), [[0, 'Intro'], [1, 'Modelo OSI'], [2, 'Ethernet'], [2, 'Repetida']]);
  assert.ok(clases.every((c) => !('creada' in c)));
  const siguiente = await crear('profesor', { titulo: 'Otra' });
  assert.equal(((await siguiente.json()) as { numero: number }).numero, 3);
});

test('un alumno no crea clases', async () => {
  const { crear, pedir } = armar();
  const res = await crear('alumno', { titulo: 'Trucha' });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'prohibido' });
  assert.deepEqual(await (await pedir('/api/clases', { persona: 'alumno' })).json(), []);
});

test('crear exige JSON', async () => {
  const { pedir } = armar();
  for (const tipo of ['application/x-www-form-urlencoded', 'text/plain', 'multipart/form-data; boundary=x']) {
    const res = await pedir('/api/clases', { persona: 'profesor', method: 'POST', headers: { 'Content-Type': tipo }, body: '{"titulo":"x"}' });
    assert.equal(res.status, 415);
    assert.deepEqual(await res.json(), { error: 'tipo_no_admitido' });
  }
  const sinTipo = await pedir('/api/clases', { persona: 'profesor', method: 'POST', body: '{"titulo":"x"}' });
  assert.equal(sinTipo.status, 415);
  const conCharset = await pedir('/api/clases', { persona: 'profesor', method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: '{"titulo":"x"}' });
  assert.equal(conCharset.status, 201);
});

test('datos inválidos dan 400', async () => {
  const { crear } = armar();
  const malos: unknown[] = [
    '{no es json', '[]', 'null', '"texto"', {}, { titulo: '' }, { titulo: '   ' }, { titulo: 42 },
    { titulo: 'x'.repeat(201) }, { titulo: 'ok', fecha: '25/08/2026' }, { titulo: 'ok', fecha: '2026-13-45' },
    { titulo: 'ok', fecha: '2026-02-30' }, { titulo: 'ok', fecha: 20260825 }, { titulo: 'ok', contenido: 'x'.repeat(20001) },
    { titulo: 'ok', contenido: 5 }, { titulo: 'ok', numero: -1 }, { titulo: 'ok', numero: 1.5 }, { titulo: 'ok', numero: '3' },
  ];
  for (const cuerpo of malos) {
    const res = await crear('profesor', cuerpo);
    assert.equal(res.status, 400, JSON.stringify(cuerpo).slice(0, 40));
    assert.deepEqual(await res.json(), { error: 'datos_invalidos' });
  }
  assert.equal((await crear('profesor', { titulo: 'x'.repeat(200), fecha: '2024-02-29', contenido: 'y'.repeat(20000) })).status, 201);
  assert.equal((await crear('profesor', { titulo: 'ok', fecha: null })).status, 201);
});

test('un cuerpo de más de 100 KB se rechaza', async () => {
  const { crear } = armar();
  const res = await crear('profesor', { titulo: 'ok', contenido: 'x'.repeat(300000) });
  assert.ok([400, 413].includes(res.status));
});

test('rutas de API desconocidas dan 404 en JSON', async () => {
  const { pedir } = armar();
  for (const ruta of ['/api/no-existe', '/api', '/api/clases/1']) {
    const res = await pedir(ruta, { persona: 'duenio' });
    assert.equal(res.status, 404, ruta);
    assert.deepEqual(await res.json(), { error: 'no_encontrado' });
  }
});

test('la aplicación web se sirve con fallback y sin salir de su carpeta', async () => {
  const { pedir } = armar();
  for (const ruta of ['/', '/index.html', '/clases/1']) {
    const res = await pedir(ruta, { persona: 'alumno' });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await res.text(), /lang="es"/);
  }
  const js = await pedir('/assets/app.js', { persona: 'alumno' });
  assert.match(js.headers.get('content-type') ?? '', /javascript/);
  assert.equal(await js.text(), 'console.log("curso")');
  for (const ruta of ['/..%2fsecreto.txt', '/assets/..%2f..%2fsecreto.txt', '/%2e%2e/secreto.txt', '/assets/%2e%2e/%2e%2e/secreto.txt', '/..%5csecreto.txt', '/%00']) {
    const res = await pedir(ruta, { persona: 'alumno' });
    assert.doesNotMatch(await res.text(), /no se sirve/, ruta);
  }
});

test('las migraciones son idempotentes', () => {
  const base = abrirBaseEnMemoria();
  assert.deepEqual(migrar(base), []);
  const versiones = base.prepare('SELECT version FROM migraciones').all();
  assert.deepEqual(versiones, [{ version: 1 }]);
});

test('la configuración exige una clave pública y un curso válidos', () => {
  assert.equal(clavePublicaValida(''), false);
  assert.equal(clavePublicaValida('abc'), false);
  assert.equal(clavePublicaValida(Buffer.alloc(32, 1).toString('base64url')), true);
  assert.throws(() => leerConfiguracion({ CAMPUSIA_CURSO: 'redes', CAMPUSIA_CLAVE_PUBLICA: '' }));
  assert.throws(() => leerConfiguracion({ CAMPUSIA_CLAVE_PUBLICA: Buffer.alloc(32, 1).toString('base64url') }));
  const c = leerConfiguracion({ CAMPUSIA_CURSO: 'redes', CAMPUSIA_CLAVE_PUBLICA: Buffer.alloc(32, 1).toString('base64url') });
  assert.deepEqual(c, { puerto: 3000, curso: 'redes', clavePublica: Buffer.alloc(32, 1).toString('base64url'), datos: '/datos' });
});
