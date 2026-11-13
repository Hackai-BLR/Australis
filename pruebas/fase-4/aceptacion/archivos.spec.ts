import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Cliente } from '../../comun/http.ts';
import { ALUMNA_REDES, ALUMNO_REDES, DUENO_REDES, PROFE_REDES, MIEMBROS_REDES, crearTestDatos, expect } from '../fixtures.ts';
import {
  PATRON_ARCHIVO_ID,
  archivosEnDisco,
  bajar,
  fechaEnRango,
  idUsuario,
  listarArchivos,
  raizArchivos,
  rutaArchivo,
  sesion,
  sha256,
  subir,
  subirOk,
  cursoAislado,
} from '../lib/datos.ts';

const test = crearTestDatos();
const C = { id: '' };
test.beforeAll(({ nucleo }) => {
  C.id = cursoAislado(nucleo, 'arc', MIEMBROS_REDES);
});

test.describe('archivos de un curso', () => {
  test('un alumno sube un archivo y lo baja igual, con el nombre original y su huella', async ({ nucleo }) => {
    const alumno = await sesion(nucleo, ALUMNO_REDES);
    const contenido = crypto.randomBytes(48 * 1024);
    const antes = Date.now();
    const a = await subirOk(alumno, C.id, 'Informe TP1.pdf', contenido);
    const despues = Date.now();
    expect(a.id).toMatch(PATRON_ARCHIVO_ID);
    expect(a.nombre).toBe('Informe TP1.pdf');
    expect(a.tamano).toBe(contenido.length);
    expect(a.sha256).toBe(sha256(contenido));
    expect(a.tipo).toBe('application/pdf');
    expect(a.material).toBe(false);
    expect(String(a.usuario.id)).toBe(String(idUsuario(nucleo, ALUMNO_REDES)));
    fechaEnRango(a.fecha, antes, despues);

    const b = await bajar(alumno, C.id, a.id);
    expect(b.status).toBe(200);
    expect(b.cuerpo.equals(contenido)).toBe(true);
    expect(String(b.encabezados['content-type'])).toBe('application/pdf');
    expect(String(b.encabezados['content-disposition'])).toMatch(/^attachment;/);
    expect(String(b.encabezados['content-disposition'])).toContain("filename*=UTF-8''Informe%20TP1.pdf");
    expect(String(b.encabezados['x-content-type-options'])).toBe('nosniff');
    expect(String(b.encabezados['content-security-policy'])).toContain('sandbox');
    expect(String(b.encabezados['content-security-policy'])).toContain("default-src 'none'");
  });

  test('el archivo se guarda fuera del curso, con un nombre interno que no depende del nombre del usuario', async ({ nucleo }) => {
    const alumno = await sesion(nucleo, ALUMNO_REDES);
    const contenido = Buffer.from(`apuntes ${crypto.randomUUID()}`);
    const a = await subirOk(alumno, C.id, 'mis apuntes secretos.txt', contenido);
    const ruta = rutaArchivo(nucleo, C.id, a.id);
    expect(fs.existsSync(ruta), ruta).toBe(true);
    expect(fs.readFileSync(ruta).equals(contenido)).toBe(true);
    expect((fs.statSync(ruta).mode & 0o077)).toBe(0);
    const todos = archivosEnDisco(raizArchivos(nucleo));
    expect(todos.some((f) => path.basename(f).includes('apuntes'))).toBe(false);
    expect(todos.every((f) => !f.includes('.txt'))).toBe(true);
    const fila = nucleo.consultar('SELECT * FROM archivos WHERE id = ?', a.id)[0];
    expect(fila.curso_id).toBe(C.id);
    expect(fila.nombre).toBe('mis apuntes secretos.txt');
    expect(fila.sha256).toBe(sha256(contenido));
    expect(Number(fila.tamano)).toBe(contenido.length);
  });

  test('los docentes ven todos los archivos y bajan los de los alumnos; el alumno ve los suyos y el material', async ({ nucleo }) => {
    const alumno = await sesion(nucleo, ALUMNO_REDES);
    const alumna = await sesion(nucleo, ALUMNA_REDES);
    const dueno = await sesion(nucleo, DUENO_REDES);
    const profe = await sesion(nucleo, PROFE_REDES);
    const propio = await subirOk(alumno, C.id, 'propio.txt', 'del alumno');
    const ajeno = await subirOk(alumna, C.id, 'ajeno.txt', 'de la alumna');
    const material = await subirOk(profe, C.id, 'Guía de ejercicios.pdf', '%PDF-1.4 guia', { material: true });
    expect(material.material).toBe(true);

    for (const docente of [dueno, profe]) {
      const l = await listarArchivos(docente, C.id);
      expect(l.status).toBe(200);
      const ids = l.json.archivos.map((x: any) => x.id);
      expect(ids).toEqual(expect.arrayContaining([propio.id, ajeno.id, material.id]));
      const b = await bajar(docente, C.id, ajeno.id);
      expect(b.status).toBe(200);
      expect(b.texto).toBe('de la alumna');
    }

    const l = await listarArchivos(alumno, C.id);
    expect(l.status).toBe(200);
    const ids = l.json.archivos.map((x: any) => x.id);
    expect(ids).toContain(propio.id);
    expect(ids).toContain(material.id);
    expect(ids).not.toContain(ajeno.id);
    const m = await bajar(alumno, C.id, material.id);
    expect(m.status).toBe(200);
    expect(m.texto).toBe('%PDF-1.4 guia');
  });

  test('la lista informa el uso y la cuota del curso', async ({ nucleo }) => {
    const dueno = await sesion(nucleo, DUENO_REDES);
    const antes = await listarArchivos(dueno, C.id);
    expect(antes.status).toBe(200);
    expect(typeof antes.json.usado).toBe('number');
    expect(antes.json.cuota).toBe(1073741824);
    await subirOk(dueno, C.id, 'cuota.txt', Buffer.alloc(1000, 1));
    const despues = await listarArchivos(dueno, C.id);
    expect(despues.json.usado).toBe(antes.json.usado + 1000);
  });

  test('se aceptan los tipos permitidos por defecto y se rechazan los demás', async ({ nucleo }) => {
    const alumno = await sesion(nucleo, ALUMNO_REDES);
    for (const nombre of ['a.pdf', 'b.TXT', 'c.png', 'd.jpg', 'e.zip', 'f.docx', 'g.py', 'h.ipynb', 'i.csv', 'j.md']) {
      const r = await subir(alumno, C.id, nombre, 'x');
      expect(r.status, `${nombre}: ${r.texto}`).toBe(201);
    }
    for (const nombre of ['a.html', 'b.htm', 'c.svg', 'd.exe', 'e.sh', 'sin-extension', 'f.xhtml', 'g.js.html']) {
      const r = await subir(alumno, C.id, nombre, 'x');
      expect(r.status, nombre).toBe(400);
      expect(r.json?.error, nombre).toBe('tipo_no_permitido');
    }
  });

});
