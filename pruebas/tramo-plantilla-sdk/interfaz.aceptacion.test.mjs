import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { nuevoParDeClaves, encabezadoDe } from './lib/identidad.mjs';
import { levantarPlataforma } from './lib/plataforma-falsa.mjs';
import { levantarCurso, bajarCurso, esperarSalud, crearVolumen, borrarVolumen, apiDesdeContenedor } from './lib/docker.mjs';
import { pedir } from './lib/http.mjs';

let par, plataforma, volumen, curso, navegador;

before(async () => {
  par = nuevoParDeClaves();
  plataforma = await levantarPlataforma();
  volumen = crearVolumen();
  curso = levantarCurso({ clavePublica: par.publica, api: apiDesdeContenedor(plataforma.puerto), volumen });
  await esperarSalud(curso);
  navegador = await chromium.launch();
});

after(async () => {
  await navegador?.close();
  bajarCurso(curso);
  borrarVolumen(volumen);
  await plataforma?.cerrar();
});

async function abrir(persona, { ancho = 1280, alto = 800 } = {}) {
  const contexto = await navegador.newContext({
    viewport: { width: ancho, height: alto },
    extraHTTPHeaders: { 'X-Campus-Identidad': encabezadoDe(persona, par.privada) },
  });
  const pagina = await contexto.newPage();
  const externos = [];
  const errores = [];
  pagina.on('request', (r) => { if (!r.url().startsWith(curso.base) && !r.url().startsWith('data:')) externos.push(r.url()); });
  pagina.on('pageerror', (e) => errores.push(String(e)));
  const respuesta = await pagina.goto(`${curso.base}/`);
  await pagina.waitForSelector('[data-prueba="curso-nombre"]', { timeout: 15000 });
  return { contexto, pagina, respuesta, externos, errores };
}

test('un alumno ve la portada con el nombre del curso, el período, los docentes y las clases vacías', async () => {
  const { contexto, pagina, respuesta, externos, errores } = await abrir('alumno');
  try {
    assert.equal(respuesta.status(), 200);
    assert.equal((await pagina.textContent('[data-prueba="curso-nombre"]')).trim(), 'Redes de Computadoras');
    assert.match(await pagina.textContent('[data-prueba="curso-periodo"]'), /2\.º cuatrimestre 2026/);
    const docentes = await pagina.textContent('[data-prueba="curso-profesores"]');
    assert.match(docentes, /Lucía Fernández/);
    assert.match(docentes, /Martín Sosa/);
    assert.doesNotMatch(docentes, /Ana Gómez|Bruno Díaz/);
    assert.ok(await pagina.isVisible('[data-prueba="clases-vacio"]'), 'falta el estado vacío de clases');
    assert.equal(await pagina.locator('[data-prueba="clase"]').count(), 0);
    assert.equal(await pagina.locator('[data-prueba="rol"]').count(), 0, 'un alumno no lleva indicador de rol');
    assert.deepEqual(externos, [], 'la página pidió recursos fuera del curso');
    assert.deepEqual(errores, []);
    assert.equal(await pagina.getAttribute('html', 'lang'), 'es');
  } finally {
    await contexto.close();
  }
});

test('las clases aparecen en orden y el texto se muestra tal cual, sin ejecutarse', async () => {
  const titulos = ['Modelo OSI y TCP/IP', '<img src=x onerror="window.__xss=1">Capa de enlace', 'Direccionamiento IP'];
  for (const titulo of titulos) {
    const r = await pedir(curso.base, '/api/clases', { identidad: encabezadoDe('profesor', par.privada), metodo: 'POST', cuerpo: { titulo, fecha: '2026-09-01' } });
    assert.equal(r.estado, 201, r.texto);
  }
  const { contexto, pagina } = await abrir('alumno');
  try {
    await pagina.waitForSelector('[data-prueba="clase"]');
    const textos = await pagina.locator('[data-prueba="clase"]').allTextContents();
    assert.equal(textos.length, 3);
    titulos.forEach((t, i) => assert.ok(textos[i].includes(t), `clase ${i + 1}: ${textos[i]}`));
    assert.equal(await pagina.isVisible('[data-prueba="clases-vacio"]'), false);
    assert.equal(await pagina.evaluate(() => window.__xss), undefined);
  } finally {
    await contexto.close();
  }
});

test('el dueño y un profesor ven un indicador discreto de su rol', async () => {
  for (const [persona, texto] of [['duenio', 'Dueño'], ['profesor', 'Profesor']]) {
    const { contexto, pagina } = await abrir(persona);
    try {
      assert.equal((await pagina.textContent('[data-prueba="rol"]')).trim(), texto);
    } finally {
      await contexto.close();
    }
  }
});

test('la identidad visual es propia: títulos con serif y sin la tipografía de la plataforma', async () => {
  const { contexto, pagina } = await abrir('alumno');
  try {
    const fuente = await pagina.$eval('[data-prueba="curso-nombre"]', (e) => getComputedStyle(e).fontFamily);
    assert.match(fuente, /serif/i);
    assert.doesNotMatch(fuente, /sans-serif\s*$/i);
    assert.doesNotMatch(fuente, /Inter/);
  } finally {
    await contexto.close();
  }
});

test('la portada se adapta a un teléfono sin desplazamiento horizontal', async () => {
  const { contexto, pagina } = await abrir('alumno', { ancho: 375, alto: 740 });
  try {
    const ancho = await pagina.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(ancho <= 376, `ancho de la página ${ancho}`);
    assert.ok(await pagina.isVisible('[data-prueba="curso-nombre"]'));
  } finally {
    await contexto.close();
  }
});

test('sin identidad el navegador no ve el curso', async () => {
  const contexto = await navegador.newContext();
  try {
    const pagina = await contexto.newPage();
    const r = await pagina.goto(`${curso.base}/`);
    assert.equal(r.status(), 401);
    assert.doesNotMatch(await pagina.content(), /Redes de Computadoras/);
  } finally {
    await contexto.close();
  }
});
