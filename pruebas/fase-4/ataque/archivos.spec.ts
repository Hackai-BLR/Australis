import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DOMINIO } from '../../comun/entorno.ts';
import { ALUMNO_REDES, DUENO_REDES, MIEMBROS_REDES, PROFE_REDES, crearTestDatos, expect } from '../fixtures.ts';
import { PATRON_ARCHIVO_ID, archivosEnDisco, bajar, cursoAislado, listarArchivos, pedirCrudo, raizArchivos, sesion, subir, subirOk } from '../lib/datos.ts';

const CUOTA = 100_000;
const MAXIMO = 40_000;
const test = crearTestDatos({
  entorno: { ARCHIVOS_CUOTA_CURSO: String(CUOTA), ARCHIVOS_MAX_BYTES: String(MAXIMO), ARCHIVOS_TIPOS: 'txt,pdf,png,html,htm,svg,xml,js,xhtml' },
});
test.describe.configure({ mode: 'serial' });
const T = { id: '' };
const Q = { id: '' };
const P = { id: '' };
test.beforeAll(({ nucleo }) => {
  T.id = cursoAislado(nucleo, 'tam', MIEMBROS_REDES);
  Q.id = cursoAislado(nucleo, 'cuo', MIEMBROS_REDES);
  P.id = cursoAislado(nucleo, 'par', MIEMBROS_REDES);
});

function soloNombresInternos(raiz: string) {
  for (const f of archivosEnDisco(raiz)) {
    const rel = path.relative(raiz, f).split(path.sep);
    if (rel[0] === '.subiendo') continue;
    expect(rel.length, f).toBe(2);
    expect(rel[1], f).toMatch(PATRON_ARCHIVO_ID);
  }
}

test.describe('ataques a los archivos', () => {
  test('un archivo más grande que el máximo se rechaza y no se guarda', async ({ nucleo }) => {
    const dueno = await sesion(nucleo, DUENO_REDES);
    const antes = archivosEnDisco(raizArchivos(nucleo)).filter((f) => !f.includes('.subiendo')).length;
    const r = await subir(dueno, T.id, 'grande.txt', Buffer.alloc(MAXIMO + 1, 1));
    expect(r.status).toBe(413);
    expect(r.json?.error).toBe('archivo_demasiado_grande');
    const enorme = await subir(dueno, T.id, 'enorme.txt', Buffer.alloc(8 * 1024 * 1024, 1));
    expect([413, 0]).toContain(enorme.status);
    expect(archivosEnDisco(raizArchivos(nucleo)).filter((f) => !f.includes('.subiendo')).length).toBe(antes);
    expect(nucleo.consultar('SELECT COUNT(*) AS n FROM archivos WHERE curso_id = ?', T.id)[0].n).toBe(0);
    const justo = await subir(dueno, T.id, 'justo.txt', Buffer.alloc(MAXIMO, 1));
    expect(justo.status, justo.texto).toBe(201);
  });

  test('superar la cuota del curso se rechaza sin guardar nada', async ({ nucleo }) => {
    const alumno = await sesion(nucleo, ALUMNO_REDES);
    const dueno = await sesion(nucleo, DUENO_REDES);
    await subirOk(alumno, Q.id, 'uno.txt', Buffer.alloc(MAXIMO, 1));
    await subirOk(dueno, Q.id, 'dos.txt', Buffer.alloc(MAXIMO, 2));
    const r = await subir(alumno, Q.id, 'tres.txt', Buffer.alloc(30_000, 3));
    expect(r.status).toBe(409);
    expect(r.json?.error).toBe('cuota_excedida');
    const l = await listarArchivos(dueno, Q.id);
    expect(l.json.usado).toBe(2 * MAXIMO);
    expect(l.json.cuota).toBe(CUOTA);
    await subirOk(alumno, Q.id, 'cuatro.txt', Buffer.alloc(CUOTA - 2 * MAXIMO, 4));
    const r2 = await subir(dueno, Q.id, 'uno-mas.txt', 'x');
    expect(r2.status).toBe(409);
    expect((await listarArchivos(dueno, Q.id)).json.usado).toBe(CUOTA);
    const otroCurso = await subir(alumno, T.id, 'otro-curso.txt', 'x');
    expect(otroCurso.status).toBe(201);
  });

  test('subidas simultáneas no superan la cuota', async ({ nucleo }) => {
    const profe = await sesion(nucleo, PROFE_REDES);
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => subir(profe, P.id, `paralelo-${i}.txt`, Buffer.alloc(15_000, i))));
    const ok = rs.filter((r) => r.status === 201).length;
    expect(ok).toBeLessThanOrEqual(6);
    expect(ok).toBeGreaterThanOrEqual(1);
    for (const r of rs) if (r.status !== 201) expect(r.json?.error).toBe('cuota_excedida');
    const l = await listarArchivos(profe, P.id);
    expect(l.json.usado).toBe(ok * 15_000);
    expect(l.json.usado).toBeLessThanOrEqual(CUOTA);
    const enDisco = archivosEnDisco(path.join(raizArchivos(nucleo), P.id));
    expect(enDisco.length).toBe(ok);
  });

  test('los nombres con recorrido de rutas no escriben fuera de la carpeta de archivos', async ({ nucleo }) => {
    const profe = await sesion(nucleo, PROFE_REDES);
    const marca = crypto.randomBytes(4).toString('hex');
    const fuera = path.join(os.tmpdir(), `campusia-evil-${marca}.txt`);
    const casos: Array<[string, string]> = [
      [`../../../../../../${fuera.slice(1)}`, `campusia-evil-${marca}.txt`],
      [`..\\..\\..\\evil-${marca}.txt`, `evil-${marca}.txt`],
      ['/etc/passwd.txt', 'passwd.txt'],
      ['a/b/c.txt', 'c.txt'],
      ['./../d.txt', 'd.txt'],
    ];
    for (const [nombre, esperado] of casos) {
      const r = await subir(profe, P.id, nombre, 'x');
      if (r.status === 201) {
        expect(r.json.nombre, nombre).toBe(esperado);
      } else {
        expect(r.status, nombre).toBe(400);
        expect(r.json?.error, nombre).toBe('nombre_invalido');
      }
    }
    for (const nombre of ['..', '.', '', '   ', 'a\nb.txt', 'a\rb.txt', 'a\u0000b.txt', `${'x'.repeat(250)}.txt`, '../', 'dir/']) {
      const r = await pedirCrudo(profe, 'POST', `/api/cursos/${P.id}/archivos?nombre=${encodeURIComponent(nombre)}`, 'x');
      expect(r.status, JSON.stringify(nombre)).toBe(400);
      expect(['nombre_invalido', 'tipo_no_permitido', 'datos_invalidos'], JSON.stringify(nombre)).toContain(r.json?.error);
    }
    const sinNombre = await pedirCrudo(profe, 'POST', `/api/cursos/${P.id}/archivos`, 'x');
    expect(sinNombre.status).toBe(400);
    expect(fs.existsSync(fuera)).toBe(false);
    expect(fs.existsSync(path.join(raizArchivos(nucleo), '..', `evil-${marca}.txt`))).toBe(false);
    soloNombresInternos(raizArchivos(nucleo));
  });

  test('los tipos peligrosos nunca se sirven como contenido ejecutable en la plataforma', async ({ nucleo }) => {
    const alumno = await sesion(nucleo, ALUMNO_REDES);
    const dueno = await sesion(nucleo, DUENO_REDES);
    const html = '<!doctype html><html><body><script>alert(document.cookie)</script></body></html>';
    const casos: Array<[string, string, RegExp]> = [
      ['ataque.html', html, /^application\/octet-stream/],
      ['ataque.htm', html, /^application\/octet-stream/],
      ['ataque.xhtml', html, /^application\/octet-stream/],
      ['ataque.svg', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>', /^application\/octet-stream/],
      ['ataque.xml', '<?xml version="1.0"?><x:script xmlns:x="http://www.w3.org/1999/xhtml">alert(1)</x:script>', /^application\/octet-stream/],
      ['ataque.js', 'alert(1)', /^application\/octet-stream/],
      ['disfrazado.png', html, /^image\/png$/],
      ['disfrazado.pdf', html, /^application\/pdf$/],
      ['disfrazado.txt', html, /^text\/plain; charset=utf-8$/],
    ];
    const ids: string[] = [];
    for (const [nombre, contenido, tipo] of casos) {
      const a = await subirOk(alumno, T.id, nombre, contenido);
      ids.push(a.id);
      for (const sub of [undefined, T.id]) {
        const r = await bajar(dueno, T.id, a.id, { sub });
        expect(r.status, nombre).toBe(200);
        const ct = String(r.encabezados['content-type']);
        expect(ct, nombre).toMatch(tipo);
        expect(ct, nombre).not.toMatch(/html|svg|xml|javascript/);
        expect(String(r.encabezados['content-disposition']), nombre).toMatch(/^attachment;/);
        expect(String(r.encabezados['x-content-type-options']), nombre).toBe('nosniff');
        const csp = String(r.encabezados['content-security-policy']);
        expect(csp, nombre).toContain('sandbox');
        expect(csp, nombre).toContain("default-src 'none'");
        expect(r.encabezados['access-control-allow-origin'], nombre).toBeUndefined();
      }
      const enCurso = await bajar(dueno, T.id, a.id, { sub: `${T.id}-curso` });
      expect(enCurso.texto, nombre).not.toContain(contenido);
    }
  });

  test('en el navegador, abrir un archivo HTML subido lo descarga y no ejecuta nada', async ({ nucleo, paginaComo }) => {
    const alumno = await sesion(nucleo, ALUMNO_REDES);
    const dueno = await sesion(nucleo, DUENO_REDES);
    const a = await subirOk(alumno, T.id, 'trampa.html', '<html><body><h1 id="x">ejecutado</h1><script>window.__ejecutado=1;alert(1)</script></body></html>');
    const pagina = await paginaComo(dueno);
    let dialogo = false;
    pagina.on('dialog', async (d) => {
      dialogo = true;
      await d.dismiss();
    });
    const [descarga] = await Promise.all([
      pagina.waitForEvent('download', { timeout: 15_000 }),
      pagina.goto(`http://${DOMINIO}:${nucleo.puerto}/api/cursos/${T.id}/archivos/${a.id}`).catch(() => null),
    ]);
    expect(descarga.suggestedFilename()).toBe('trampa.html');
    expect(dialogo).toBe(false);
  });

  test('el nombre no inyecta encabezados ni cambia el nombre de la descarga', async ({ nucleo }) => {
    const alumno = await sesion(nucleo, ALUMNO_REDES);
    for (const nombre of ['a"; filename="evil.html.txt', 'Ñandú – informe final.pdf', "comilla'simple;y=igual.txt"]) {
      const a = await subirOk(alumno, T.id, nombre, 'x');
      expect(a.nombre).toBe(nombre);
      const r = await bajar(alumno, T.id, a.id);
      const cd = String(r.encabezados['content-disposition']);
      expect(cd).toMatch(/^attachment;/);
      expect(cd).not.toContain('filename="evil');
      const m = /filename\*=UTF-8''([^;\s]+)/.exec(cd);
      expect(m, cd).not.toBeNull();
      expect(decodeURIComponent(m![1])).toBe(nombre);
    }
  });
});
