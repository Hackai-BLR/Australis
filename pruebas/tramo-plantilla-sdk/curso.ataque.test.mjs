import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { nuevoParDeClaves, encabezadoDe, firmar, cargaBase, b64url, partes, ahoraSeg, PERSONAS } from './lib/identidad.mjs';
import { levantarPlataforma, TOKEN } from './lib/plataforma-falsa.mjs';
import { levantarCurso, bajarCurso, esperarSalud, crearVolumen, borrarVolumen, apiDesdeContenedor, docker } from './lib/docker.mjs';
import { pedir } from './lib/http.mjs';

let par, otroPar, plataforma, volumen, curso;

before(async () => {
  par = nuevoParDeClaves();
  otroPar = nuevoParDeClaves();
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
const RUTAS = ['/', '/index.html', '/api/yo', '/api/portada', '/api/clases', '/assets/inexistente.js', '/cualquier/cosa'];

async function todas401(opciones, mensaje) {
  for (const ruta of RUTAS) {
    const r = await pedir(curso.base, ruta, opciones);
    assert.equal(r.estado, 401, `${mensaje}: ${ruta} devolvió ${r.estado}`);
    assert.equal(r.json?.error, 'identidad_invalida', `${mensaje}: ${ruta}`);
    assert.doesNotMatch(r.texto, /Lucía|Martín|Ana Gómez|Redes de Computadoras/);
  }
}

test('sin encabezado no se ve nada salvo /salud', async () => {
  await todas401({}, 'sin encabezado');
  assert.equal((await pedir(curso.base, '/salud')).estado, 200);
});

test('firma inválida', async () => {
  await todas401({ identidad: encabezadoDe('duenio', otroPar.privada) }, 'firma de otra clave');
  const { c } = partes(id('duenio'));
  await todas401({ identidad: `${c}.${b64url(Buffer.alloc(64, 7))}` }, 'firma inventada');
});

test('carga alterada para subir de rol', async () => {
  const { f } = partes(id('alumno'));
  const alterada = b64url(Buffer.from(JSON.stringify(cargaBase({ rol: 'profesor' })), 'utf8'));
  await todas401({ identidad: `${alterada}.${f}` }, 'carga alterada');
  const r = await pedir(curso.base, '/api/clases', { identidad: `${alterada}.${f}`, metodo: 'POST', cuerpo: { titulo: 'Intrusa' } });
  assert.equal(r.estado, 401);
});

test('identidad de otro curso', async () => {
  await todas401({ identidad: id('duenio', { curso: 'otro-curso' }) }, 'otro curso');
});

test('identidad vencida', async () => {
  const t = ahoraSeg();
  await todas401({ identidad: firmar(cargaBase({ ...PERSONAS.duenio, emitido: t - 200, vence: t - 80 }), par.privada) }, 'vencida');
});

test('identidad emitida en el futuro', async () => {
  const t = ahoraSeg();
  await todas401({ identidad: firmar(cargaBase({ ...PERSONAS.duenio, emitido: t + 600, vence: t + 660 }), par.privada) }, 'futura');
});

test('identidad con vigencia excesiva', async () => {
  const t = ahoraSeg();
  await todas401({ identidad: firmar(cargaBase({ ...PERSONAS.duenio, emitido: t, vence: t + 3600 }), par.privada) }, 'vigencia larga');
});

test('versión distinta y rol desconocido', async () => {
  await todas401({ identidad: id('duenio', { v: 2 }) }, 'versión 2');
  await todas401({ identidad: id('duenio', { rol: 'admin' }) }, 'rol admin');
});

test('clave pública equivocada en el curso', async () => {
  const otro = levantarCurso({ clavePublica: otroPar.publica, api: apiDesdeContenedor(plataforma.puerto) });
  try {
    await esperarSalud(otro);
    const r = await pedir(otro.base, '/api/yo', { identidad: id('duenio') });
    assert.equal(r.estado, 401);
  } finally {
    bajarCurso(otro);
  }
});

test('el encabezado en una cookie, en la consulta o en Authorization no sirve', async () => {
  const enc = id('duenio');
  await todas401({ encabezados: { Cookie: `X-Campus-Identidad=${enc}; identidad=${enc}` } }, 'cookie');
  await todas401({ encabezados: { Authorization: `Bearer ${enc}` } }, 'authorization');
  const r = await pedir(curso.base, `/api/yo?X-Campus-Identidad=${enc}&identidad=${enc}`);
  assert.equal(r.estado, 401);
});

test('encabezados inventados no otorgan identidad ni rol', async () => {
  await todas401({ encabezados: { 'X-Campus-Rol': 'profesor', 'X-Campus-Usuario': 'u-duenio', 'X-Forwarded-User': 'lucia.fernandez@austral.edu.ar', 'X-Remote-User': 'u-duenio' } }, 'encabezados inventados');
  const r = await pedir(curso.base, '/api/clases', { identidad: id('alumno'), metodo: 'POST', cuerpo: { titulo: 'x' }, encabezados: { 'X-Campus-Rol': 'profesor' } });
  assert.equal(r.estado, 403);
});

test('un alumno no puede crear clases', async () => {
  const r = await pedir(curso.base, '/api/clases', { identidad: id('alumno'), metodo: 'POST', cuerpo: { titulo: 'Clase trucha' } });
  assert.equal(r.estado, 403);
  assert.equal(r.json?.error, 'prohibido');
  const l = await pedir(curso.base, '/api/clases', { identidad: id('profesor') });
  assert.ok(!l.json.some((c) => c.titulo === 'Clase trucha'));
});

test('crear clases exige JSON: formularios de otro sitio no sirven', async () => {
  const r = await pedir(curso.base, '/api/clases', { identidad: id('profesor'), metodo: 'POST', cuerpo: 'titulo=Falsificada', tipo: 'application/x-www-form-urlencoded' });
  assert.equal(r.estado, 415);
  const t = await pedir(curso.base, '/api/clases', { identidad: id('profesor'), metodo: 'POST', cuerpo: '{"titulo":"Falsificada"}', tipo: 'text/plain' });
  assert.equal(t.estado, 415);
  const l = await pedir(curso.base, '/api/clases', { identidad: id('profesor') });
  assert.ok(!l.json.some((c) => c.titulo === 'Falsificada'));
});

test('datos inválidos al crear una clase', async () => {
  const malos = [
    '{no es json',
    {},
    { titulo: '' },
    { titulo: '   ' },
    { titulo: 42 },
    { titulo: 'x'.repeat(201) },
    { titulo: 'ok', fecha: '25/08/2026' },
    { titulo: 'ok', fecha: '2026-13-45' },
    { titulo: 'ok', contenido: 'x'.repeat(20001) },
    { titulo: 'ok', numero: -1 },
    { titulo: 'ok', numero: 1.5 },
    { titulo: 'ok', numero: '3' },
  ];
  for (const cuerpo of malos) {
    const r = await pedir(curso.base, '/api/clases', { identidad: id('profesor'), metodo: 'POST', cuerpo });
    assert.equal(r.estado, 400, `cuerpo ${JSON.stringify(cuerpo).slice(0, 60)} devolvió ${r.estado}`);
    assert.equal(r.json?.error, 'datos_invalidos');
  }
});

test('un cuerpo enorme se rechaza sin tumbar el curso', async () => {
  const r = await pedir(curso.base, '/api/clases', { identidad: id('profesor'), metodo: 'POST', cuerpo: { titulo: 'ok', contenido: 'x'.repeat(300000) } });
  assert.ok([400, 413].includes(r.estado), `devolvió ${r.estado}`);
  assert.equal((await pedir(curso.base, '/salud')).estado, 200);
});

test('rutas de API desconocidas devuelven 404 en JSON', async () => {
  const r = await pedir(curso.base, '/api/no-existe', { identidad: id('duenio') });
  assert.equal(r.estado, 404);
  assert.equal(r.json?.error, 'no_encontrado');
});

test('un alumno no ve mails ni datos de otros inscriptos', async () => {
  const r = await pedir(curso.base, '/api/portada', { identidad: id('alumno') });
  assert.equal(r.estado, 200);
  assert.doesNotMatch(r.texto, /@austral\.edu\.ar/);
  assert.doesNotMatch(r.texto, /Bruno|u-alumno-2|u-profe-2|u-duenio/);
  const y = await pedir(curso.base, '/api/yo', { identidad: id('alumno') });
  assert.equal(y.json.usuario, 'u-alumno-1');
});

test('no se filtran el token ni la configuración', async () => {
  const enc = id('duenio');
  const html = await pedir(curso.base, '/', { identidad: enc });
  const recursos = [...html.texto.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]);
  const textos = [html.texto, (await pedir(curso.base, '/salud')).texto, (await pedir(curso.base, '/api/portada', { identidad: enc })).texto];
  for (const ruta of recursos) textos.push((await pedir(curso.base, ruta, { identidad: id('duenio') })).texto);
  for (const t of textos) {
    assert.ok(!t.includes(TOKEN), 'apareció el token del curso');
    assert.ok(!t.includes(par.publica), 'apareció la clave pública');
    assert.ok(!t.includes('host.docker.internal'), 'apareció la URL de la plataforma');
  }
});

test('no se puede salir de la carpeta de archivos estáticos', async () => {
  for (const ruta of ['/assets/..%2f..%2f..%2f..%2fetc%2fpasswd', '/..%2f..%2f..%2fetc%2fpasswd', '/assets/%2e%2e/%2e%2e/%2e%2e/etc/passwd', '/%2e%2e/package.json']) {
    const r = await pedir(curso.base, ruta, { identidad: id('duenio') });
    assert.doesNotMatch(r.texto, /root:x?:0:0/, ruta);
    assert.doesNotMatch(r.texto, /"dependencies"/, ruta);
  }
});

test('si la plataforma no responde, la portada da 502 y el resto sigue andando', async () => {
  const caido = levantarCurso({ clavePublica: par.publica, api: 'http://host.docker.internal:9' });
  try {
    await esperarSalud(caido);
    const r = await pedir(caido.base, '/api/portada', { identidad: id('alumno') });
    assert.equal(r.estado, 502);
    assert.equal(r.json?.error, 'plataforma_no_disponible');
    assert.equal((await pedir(caido.base, '/api/clases', { identidad: id('alumno') })).estado, 200);
    assert.equal((await pedir(caido.base, '/api/yo', { identidad: id('alumno') })).estado, 200);
  } finally {
    bajarCurso(caido);
  }
});

test('sin clave pública configurada el curso no arranca o niega todo menos /salud', async () => {
  const sinClave = levantarCurso({ clavePublica: '', api: apiDesdeContenedor(plataforma.puerto) });
  try {
    await new Promise((r) => setTimeout(r, 4000));
    const estado = docker(['inspect', '-f', '{{.State.Status}}', sinClave.nombre], { permitirFallo: true }).salida;
    if (estado !== 'running' || !sinClave.base) return;
    const r = await pedir(sinClave.base, '/api/yo', { identidad: id('duenio') });
    assert.ok([401, 500, 503].includes(r.estado), `devolvió ${r.estado}`);
  } finally {
    bajarCurso(sinClave);
  }
});
