import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { nuevoParDeClaves, encabezadoDe, PERSONAS } from './lib/identidad.mjs';
import { levantarPlataforma, TOKEN, CURSO } from './lib/plataforma-falsa.mjs';
import { levantarCurso, bajarCurso, esperarSalud, crearVolumen, borrarVolumen, apiDesdeContenedor } from './lib/docker.mjs';
import { pedir } from './lib/http.mjs';

let par, plataforma, volumen, curso;

before(async () => {
  par = nuevoParDeClaves();
  plataforma = await levantarPlataforma();
  volumen = crearVolumen();
  curso = levantarCurso({ clavePublica: par.publica, api: apiDesdeContenedor(plataforma.puerto), volumen });
  await esperarSalud(curso);
});

after(async () => {
  bajarCurso(curso);
  borrarVolumen(volumen);
  await plataforma?.cerrar();
});

const id = (p, extra) => encabezadoDe(p, par.privada, extra);

test('/salud responde sin identidad', async () => {
  const r = await pedir(curso.base, '/salud');
  assert.equal(r.estado, 200);
  assert.deepEqual(r.json, { estado: 'ok' });
});

test('la portada responde HTML en castellano con identidad válida', async () => {
  const r = await pedir(curso.base, '/', { identidad: id('alumno') });
  assert.equal(r.estado, 200);
  assert.match(r.encabezados.get('content-type') || '', /text\/html/);
  assert.match(r.texto, /<html[^>]*lang="es"/);
  assert.match(r.texto, /name="viewport"/);
});

test('las rutas desconocidas fuera de /api devuelven la aplicación', async () => {
  const r = await pedir(curso.base, '/clases/1', { identidad: id('alumno') });
  assert.equal(r.estado, 200);
  assert.match(r.encabezados.get('content-type') || '', /text\/html/);
});

test('/api/yo refleja la identidad y el rol de cada persona', async () => {
  for (const p of ['duenio', 'profesor', 'alumno']) {
    const r = await pedir(curso.base, '/api/yo', { identidad: id(p) });
    assert.equal(r.estado, 200, p);
    const { usuario, email, nombre, rol } = PERSONAS[p];
    assert.deepEqual(r.json, { usuario, email, nombre, rol });
  }
});

test('/api/portada trae el curso desde la plataforma, sus docentes y las clases vacías', async () => {
  const r = await pedir(curso.base, '/api/portada', { identidad: id('alumno') });
  assert.equal(r.estado, 200, r.texto);
  assert.deepEqual(r.json.curso, CURSO);
  assert.deepEqual(r.json.profesores, [
    { nombre: 'Lucía Fernández', rol: 'dueño' },
    { nombre: 'Martín Sosa', rol: 'profesor' },
  ]);
  assert.deepEqual(r.json.clases, []);
  assert.deepEqual(r.json.yo, { nombre: 'Ana Gómez', rol: 'alumno' });
});

test('el curso llama a la plataforma con su token y sin reenviar la identidad', async () => {
  assert.ok(plataforma.pedidos.length > 0, 'el curso no consultó la plataforma');
  for (const p of plataforma.pedidos) {
    assert.equal(p.encabezados.authorization, `Bearer ${TOKEN}`);
    assert.equal(p.encabezados['x-campus-identidad'], undefined);
    assert.equal(p.encabezados.cookie, undefined);
    assert.match(p.url, /^\/api\/curso\//);
  }
});

test('al inicio no hay clases', async () => {
  const r = await pedir(curso.base, '/api/clases', { identidad: id('alumno') });
  assert.equal(r.estado, 200);
  assert.deepEqual(r.json, []);
});

test('profesor y dueño agregan clases y todos las ven en orden', async () => {
  const a = await pedir(curso.base, '/api/clases', { identidad: id('profesor'), metodo: 'POST', cuerpo: { titulo: 'Modelo OSI y TCP/IP', fecha: '2026-08-25', contenido: 'Capas y encapsulamiento.' } });
  assert.equal(a.estado, 201, a.texto);
  assert.equal(typeof a.json.id, 'number');
  assert.equal(a.json.numero, 1);
  assert.equal(a.json.titulo, 'Modelo OSI y TCP/IP');
  assert.equal(a.json.fecha, '2026-08-25');
  assert.equal(a.json.contenido, 'Capas y encapsulamiento.');
  const b = await pedir(curso.base, '/api/clases', { identidad: id('duenio'), metodo: 'POST', cuerpo: { titulo: 'Capa de enlace y Ethernet' } });
  assert.equal(b.estado, 201, b.texto);
  assert.equal(b.json.numero, 2);
  assert.equal(b.json.fecha, null);
  assert.equal(b.json.contenido, '');
  const l = await pedir(curso.base, '/api/clases', { identidad: id('alumno') });
  assert.equal(l.estado, 200);
  assert.deepEqual(l.json.map((c) => [c.numero, c.titulo]), [[1, 'Modelo OSI y TCP/IP'], [2, 'Capa de enlace y Ethernet']]);
  const p = await pedir(curso.base, '/api/portada', { identidad: id('alumno') });
  assert.equal(p.json.clases.length, 2);
});

test('una clase con número explícito queda en su lugar', async () => {
  const r = await pedir(curso.base, '/api/clases', { identidad: id('profesor'), metodo: 'POST', cuerpo: { titulo: 'Introducción', numero: 0 } });
  assert.equal(r.estado, 201, r.texto);
  assert.equal(r.json.numero, 0);
  const l = await pedir(curso.base, '/api/clases', { identidad: id('alumno') });
  assert.deepEqual(l.json.map((c) => c.numero), [0, 1, 2]);
});

test('los datos persisten al recrear el contenedor con el mismo volumen', async () => {
  const antes = await pedir(curso.base, '/api/clases', { identidad: id('alumno') });
  bajarCurso(curso);
  curso = levantarCurso({ clavePublica: par.publica, api: apiDesdeContenedor(plataforma.puerto), volumen });
  await esperarSalud(curso);
  const despues = await pedir(curso.base, '/api/clases', { identidad: id('alumno') });
  assert.equal(despues.estado, 200);
  assert.deepEqual(despues.json, antes.json);
  const otra = await pedir(curso.base, '/api/clases', { identidad: id('profesor'), metodo: 'POST', cuerpo: { titulo: 'Direccionamiento IP' } });
  assert.equal(otra.estado, 201);
  assert.equal(otra.json.numero, 3);
});
