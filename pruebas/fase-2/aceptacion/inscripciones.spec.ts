import { MODO_CODIGO } from '../../comun/nucleo.ts';
import { crearTestCursos, expect, PROFE_AUSTRAL, PROFE2_AUSTRAL, PROFE3_AUSTRAL, ALUMNO_AUSTRAL, ALUMNA2_AUSTRAL, ADMIN_AUSTRAL } from '../fixtures.ts';
import { aleatorio, entrar, reautenticar } from '../../comun/sesion.ts';
import { Cliente } from '../../comun/http.ts';
import { crearXlsx } from '../lib/xlsx.ts';
import { crearXls } from '../lib/planillas.ts';
import { auditoria, crearCurso, idAleatorio, idUsuario, inscribirOk, sesion } from '../lib/cursos.ts';

const test = crearTestCursos({ entorno: MODO_CODIGO });
test.describe.configure({ timeout: 300_000 });

async function cursoNuevo(nucleo: any, dueno = PROFE_AUSTRAL) {
  const profe = await sesion(nucleo, dueno);
  const id = idAleatorio('ins');
  const r = await crearCurso(profe, { id, nombre: `Inscripciones ${id}` });
  expect(r.status, r.texto).toBe(201);
  return { profe, id };
}

function csv(filas: string[][], sep = ';', bom = true) {
  const texto = filas.map((f) => f.map((v) => (v.includes(sep) || v.includes('"') ? `"${v.replace(/"/g, '""')}"` : v)).join(sep)).join('\r\n');
  return Buffer.from((bom ? '﻿' : '') + texto + '\r\n', 'utf8');
}

test.describe('inscripciones por mail', () => {
  test('el dueño inscribe alumnos y profesores y ve la lista ordenada', async ({ nucleo }) => {
    const { profe, id } = await cursoNuevo(nucleo);
    const a = await inscribirOk(profe, id, [` ${ALUMNO_AUSTRAL.toUpperCase()} `, ALUMNA2_AUSTRAL, ALUMNO_AUSTRAL]);
    expect(a.agregados.sort()).toEqual([ALUMNA2_AUSTRAL, ALUMNO_AUSTRAL].sort());
    expect(a.ya_estaban).toEqual([]);
    expect(a.creados).toEqual([]);
    const p = await inscribirOk(profe, id, [PROFE2_AUSTRAL], 'profesor');
    expect(p.agregados).toEqual([PROFE2_AUSTRAL]);
    const otra = await inscribirOk(profe, id, [ALUMNO_AUSTRAL]);
    expect(otra.ya_estaban).toEqual([ALUMNO_AUSTRAL]);
    expect(otra.agregados).toEqual([]);
    const l = await profe.get(`/api/cursos/${id}/inscriptos`);
    expect(l.status).toBe(200);
    expect(l.json.alumnos).toBe(2);
    expect(l.json.profesores).toBe(2);
    expect(l.json.inscriptos.map((i: any) => [i.email, i.rol])).toEqual([
      [PROFE_AUSTRAL, 'dueño'],
      [PROFE2_AUSTRAL, 'profesor'],
      [ALUMNA2_AUSTRAL, 'alumno'],
      [ALUMNO_AUSTRAL, 'alumno'],
    ]);
    for (const i of l.json.inscriptos) {
      expect(typeof i.id).toBe('number');
      expect(i.pendiente).toBe(false);
      expect(i.nombre.length).toBeGreaterThan(0);
    }
    const alumno = await sesion(nucleo, ALUMNO_AUSTRAL);
    const mis = await alumno.get('/api/mis-cursos');
    expect(mis.json.cursos.find((c: any) => c.id === id)?.rol).toBe('alumno');
    const ev = auditoria(nucleo, 'inscripcion').filter((e) => String(e.detalle).includes(id));
    expect(ev.length).toBe(3);
    expect(ev.some((e) => String(e.detalle).includes(ALUMNO_AUSTRAL))).toBe(true);
  });

  test('un profesor del curso inscribe alumnos', async ({ nucleo }) => {
    const { profe, id } = await cursoNuevo(nucleo);
    await inscribirOk(profe, id, [PROFE2_AUSTRAL], 'profesor');
    const p2 = await sesion(nucleo, PROFE2_AUSTRAL);
    const r = await inscribirOk(p2, id, [ALUMNA2_AUSTRAL]);
    expect(r.agregados).toEqual([ALUMNA2_AUSTRAL]);
    expect((await p2.get(`/api/cursos/${id}/inscriptos`)).json.alumnos).toBe(1);
  });

  test('las cuentas nuevas quedan pendientes y se activan al primer login', async ({ nucleo }) => {
    const { profe, id } = await cursoNuevo(nucleo);
    const email = `${aleatorio('nuevo.')}@mail.austral.edu.ar`;
    const r = await inscribirOk(profe, id, [email]);
    expect(r.creados).toEqual([email]);
    expect(r.agregados).toEqual([email]);
    const fila = nucleo.consultar('SELECT pendiente, universidad_id FROM usuarios WHERE email = ?', email)[0];
    expect(fila.pendiente).toBe(1);
    const uni = nucleo.consultar("SELECT id FROM universidades WHERE nombre = 'Universidad Austral'")[0];
    expect(fila.universidad_id).toBe(uni.id);
    const l = await profe.get(`/api/cursos/${id}/inscriptos`);
    expect(l.json.inscriptos.find((i: any) => i.email === email)?.pendiente).toBe(true);
    const admin = await sesion(nucleo, ADMIN_AUSTRAL);
    const personas = await admin.get(`/api/admin/personas?buscar=${encodeURIComponent(email)}`);
    expect(personas.json.personas[0]).toMatchObject({ email, pendiente: true, cursos: 1 });
    const nuevo = new Cliente(nucleo);
    await entrar(nuevo, email);
    expect(nucleo.consultar('SELECT pendiente FROM usuarios WHERE email = ?', email)[0].pendiente).toBe(0);
    const mis = await nuevo.get('/api/mis-cursos');
    expect(mis.json.cursos.map((c: any) => c.id)).toContain(id);
    const l2 = await profe.get(`/api/cursos/${id}/inscriptos`);
    expect(l2.json.inscriptos.find((i: any) => i.email === email)?.pendiente).toBe(false);
  });
});

test.describe('importar el listado del SIU', () => {
  test('CSV con punto y coma, BOM, comillas y filas rechazadas', async ({ nucleo }) => {
    const { profe, id } = await cursoNuevo(nucleo);
    const n1 = `${aleatorio('siu.a')}@mail.austral.edu.ar`;
    const n2 = `${aleatorio('siu.b')}@austral.edu.ar`;
    const archivo = csv([
      ['Legajo', 'Apellido y Nombre', 'Correo electrónico', 'Carrera'],
      ['1001', 'Pérez, Juana', n1, 'Ingeniería'],
      ['1002', 'Gómez Ramiro', n2, 'Ingeniería; Informática'],
      ['1003', 'García Tomás', ALUMNO_AUSTRAL, 'Ingeniería'],
      ['1004', 'Externo Uno', 'externo@demo.edu.ar', 'Otra'],
      ['1005', 'Sin Mail', '', 'Otra'],
      ['1006', 'Roto', 'no-es-un-mail', 'Otra'],
    ]);
    const r = await profe.post(`/api/cursos/${id}/inscriptos/siu`, { archivo: 'inscriptos.csv', contenido: archivo.toString('base64') });
    expect(r.status, r.texto).toBe(200);
    expect(r.json.agregados.sort()).toEqual([ALUMNO_AUSTRAL, n1, n2].sort());
    expect(r.json.creados.sort()).toEqual([n1, n2].sort());
    expect(r.json.ya_estaban).toEqual([]);
    const rech = r.json.rechazados.map((x: any) => [x.fila, x.email, x.motivo]);
    expect(rech).toContainEqual([5, 'externo@demo.edu.ar', 'dominio_no_habilitado']);
    expect(rech).toContainEqual([7, 'no-es-un-mail', 'email_invalido']);
    expect(rech.length).toBe(2);
    const l = await profe.get(`/api/cursos/${id}/inscriptos`);
    const juana = l.json.inscriptos.find((i: any) => i.email === n1);
    expect(juana).toMatchObject({ rol: 'alumno', pendiente: true });
    expect(juana.nombre).toMatch(/Juana/);
    expect(juana.nombre).toMatch(/Pérez/);
    expect(l.json.inscriptos.find((i: any) => i.email === ALUMNO_AUSTRAL).nombre).toBe('Tomás García');
    const r2 = await profe.post(`/api/cursos/${id}/inscriptos/siu`, { archivo: 'inscriptos.csv', contenido: archivo.toString('base64') });
    expect(r2.status).toBe(200);
    expect(r2.json.agregados).toEqual([]);
    expect(r2.json.ya_estaban.sort()).toEqual([ALUMNO_AUSTRAL, n1, n2].sort());
    expect(auditoria(nucleo, 'importacion_siu').some((e) => String(e.detalle).includes(id))).toBe(true);
  });

  test('CSV con coma y columnas separadas de apellido y nombre', async ({ nucleo }) => {
    const { profe, id } = await cursoNuevo(nucleo);
    const n1 = `${aleatorio('coma')}@austral.edu.ar`;
    const archivo = csv([['Apellido', 'Nombres', 'Mail'], ['Rossi', 'Ana Laura', n1]], ',', false);
    const r = await profe.post(`/api/cursos/${id}/inscriptos/siu`, { archivo: 'listado.csv', contenido: archivo.toString('base64') });
    expect(r.status, r.texto).toBe(200);
    expect(r.json.agregados).toEqual([n1]);
    const l = await profe.get(`/api/cursos/${id}/inscriptos`);
    expect(l.json.inscriptos.find((i: any) => i.email === n1).nombre).toBe('Ana Laura Rossi');
  });

  test('Excel xlsx exportado del SIU', async ({ nucleo }) => {
    const { profe, id } = await cursoNuevo(nucleo);
    const n1 = `${aleatorio('xlsx')}@mail.austral.edu.ar`;
    const libro = crearXlsx([
      ['Nombre y Apellido', 'E-mail', 'Legajo'],
      ['Valentina Sosa', n1, '2001'],
      ['Sofía López', ALUMNA2_AUSTRAL, '2002'],
      ['De Afuera', 'x@otra.edu.ar', '2003'],
    ]);
    const r = await profe.post(`/api/cursos/${id}/inscriptos/siu`, { archivo: 'inscriptos.xlsx', contenido: libro.toString('base64') });
    expect(r.status, r.texto).toBe(200);
    expect(r.json.agregados.sort()).toEqual([ALUMNA2_AUSTRAL, n1].sort());
    expect(r.json.rechazados).toEqual([{ fila: 4, email: 'x@otra.edu.ar', motivo: 'dominio_no_habilitado' }]);
    const l = await profe.get(`/api/cursos/${id}/inscriptos`);
    expect(l.json.inscriptos.find((i: any) => i.email === n1)).toMatchObject({ nombre: 'Valentina Sosa', rol: 'alumno', pendiente: true });
  });

  test('un archivo sin columna de mail se rechaza entero', async ({ nucleo }) => {
    const { profe, id } = await cursoNuevo(nucleo);
    const archivo = csv([['Legajo', 'Nombre'], ['1', 'Alguien']]);
    const r = await profe.post(`/api/cursos/${id}/inscriptos/siu`, { archivo: 'x.csv', contenido: archivo.toString('base64') });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('archivo_invalido');
  });
});

test.describe('código de inscripción', () => {
  test('generar, unirse, desactivar y volver a activar', async ({ nucleo }) => {
    const { profe, id } = await cursoNuevo(nucleo);
    const g = await profe.post(`/api/cursos/${id}/codigo`, { dias: 10 });
    expect(g.status, g.texto).toBe(200);
    expect(g.json.activo).toBe(true);
    expect(g.json.codigo).toMatch(/^INS-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
    const vence = Date.parse(g.json.vence);
    expect(Math.abs(vence - (Date.now() + 10 * 86400_000))).toBeLessThan(120_000);
    expect((await profe.get(`/api/cursos/${id}/codigo`)).json).toEqual(g.json);
    const alumna = await sesion(nucleo, ALUMNA2_AUSTRAL);
    const u = await alumna.post('/api/unirse', { codigo: `  ${g.json.codigo.toLowerCase()} ` });
    expect(u.status, u.texto).toBe(200);
    expect(u.json.curso).toMatchObject({ id, rol: 'alumno', nombre: `Inscripciones ${id}` });
    expect((await alumna.get('/api/mis-cursos')).json.cursos.map((c: any) => c.id)).toContain(id);
    const otra = await alumna.post('/api/unirse', { codigo: g.json.codigo });
    expect(otra.status).toBe(200);
    expect(otra.json.curso.rol).toBe('alumno');
    expect(auditoria(nucleo, 'inscripcion_por_codigo').some((e) => String(e.detalle).includes(ALUMNA2_AUSTRAL))).toBe(true);
    const off = await profe.put(`/api/cursos/${id}/codigo`, { activo: false });
    expect(off.status).toBe(200);
    expect(off.json).toMatchObject({ codigo: g.json.codigo, activo: false });
    const tomas = await sesion(nucleo, ALUMNO_AUSTRAL);
    const no = await tomas.post('/api/unirse', { codigo: g.json.codigo });
    expect(no.status).toBe(400);
    expect(no.json.error).toBe('codigo_invalido');
    expect((await profe.put(`/api/cursos/${id}/codigo`, { activo: true })).json.activo).toBe(true);
    expect((await tomas.post('/api/unirse', { codigo: g.json.codigo })).status).toBe(200);
    expect(auditoria(nucleo, 'codigo_curso_generado').some((e) => String(e.detalle).includes(id))).toBe(true);
    expect(auditoria(nucleo, 'codigo_curso_cambiado').some((e) => String(e.detalle).includes(id))).toBe(true);
  });

  test('el profesor que ya está inscripto no cambia de rol al usar el código', async ({ nucleo }) => {
    const { profe, id } = await cursoNuevo(nucleo);
    await inscribirOk(profe, id, [PROFE2_AUSTRAL], 'profesor');
    const g = await profe.post(`/api/cursos/${id}/codigo`, {});
    const p2 = await sesion(nucleo, PROFE2_AUSTRAL);
    const u = await p2.post('/api/unirse', { codigo: g.json.codigo });
    expect(u.status).toBe(200);
    expect(u.json.curso.rol).toBe('profesor');
    const d = await profe.post('/api/unirse', { codigo: g.json.codigo });
    expect(d.json.curso.rol).toBe('dueño');
  });

  test('regenerar el código anula el anterior', async ({ nucleo }) => {
    const { profe, id } = await cursoNuevo(nucleo);
    const a = (await profe.post(`/api/cursos/${id}/codigo`, {})).json.codigo;
    const b = (await profe.post(`/api/cursos/${id}/codigo`, {})).json.codigo;
    expect(b).not.toBe(a);
    const alumna = await sesion(nucleo, ALUMNA2_AUSTRAL);
    expect((await alumna.post('/api/unirse', { codigo: a })).status).toBe(400);
    expect((await alumna.post('/api/unirse', { codigo: b })).status).toBe(200);
  });
});

test.describe('roles, bajas y transferencia', () => {
  test('el dueño cambia roles con reautenticación', async ({ nucleo }) => {
    const { profe, id } = await cursoNuevo(nucleo);
    await inscribirOk(profe, id, [PROFE3_AUSTRAL]);
    const uid = idUsuario(nucleo, PROFE3_AUSTRAL);
    const sin = await profe.put(`/api/cursos/${id}/inscriptos/${uid}`, { rol: 'profesor' });
    expect(sin.status).toBe(403);
    expect(sin.json.error).toBe('reautenticacion_requerida');
    await reautenticar(profe);
    const r = await profe.put(`/api/cursos/${id}/inscriptos/${uid}`, { rol: 'profesor' });
    expect(r.status, r.texto).toBe(200);
    expect(r.json).toMatchObject({ id: uid, email: PROFE3_AUSTRAL, rol: 'profesor' });
    const v = await profe.put(`/api/cursos/${id}/inscriptos/${uid}`, { rol: 'alumno' });
    expect(v.json.rol).toBe('alumno');
    expect(auditoria(nucleo, 'rol_en_curso').filter((e) => String(e.detalle).includes(PROFE3_AUSTRAL)).length).toBeGreaterThanOrEqual(2);
  });

  test('quitar un alumno exige reautenticación y le saca el acceso', async ({ nucleo }) => {
    const { profe, id } = await cursoNuevo(nucleo);
    await inscribirOk(profe, id, [ALUMNO_AUSTRAL, ALUMNA2_AUSTRAL]);
    await inscribirOk(profe, id, [PROFE2_AUSTRAL], 'profesor');
    const p2 = await sesion(nucleo, PROFE2_AUSTRAL);
    const uid = idUsuario(nucleo, ALUMNO_AUSTRAL);
    const sin = await p2.delete(`/api/cursos/${id}/inscriptos/${uid}`);
    expect(sin.status).toBe(403);
    expect(sin.json.error).toBe('reautenticacion_requerida');
    await reautenticar(p2);
    const r = await p2.delete(`/api/cursos/${id}/inscriptos/${uid}`);
    expect(r.status, r.texto).toBe(204);
    const alumno = await sesion(nucleo, ALUMNO_AUSTRAL);
    expect((await alumno.get('/api/mis-cursos')).json.cursos.map((c: any) => c.id)).not.toContain(id);
    expect((await alumno.get(`/api/cursos/${id}`)).status).toBe(404);
    const l = await profe.get(`/api/cursos/${id}/inscriptos`);
    expect(l.json.inscriptos.map((i: any) => i.email)).not.toContain(ALUMNO_AUSTRAL);
    expect(auditoria(nucleo, 'desinscripcion').some((e) => String(e.detalle).includes(ALUMNO_AUSTRAL) && String(e.detalle).includes(id))).toBe(true);
  });

  test('el dueño quita profesores', async ({ nucleo }) => {
    const { profe, id } = await cursoNuevo(nucleo);
    await inscribirOk(profe, id, [PROFE2_AUSTRAL], 'profesor');
    await reautenticar(profe);
    const r = await profe.delete(`/api/cursos/${id}/inscriptos/${idUsuario(nucleo, PROFE2_AUSTRAL)}`);
    expect(r.status, r.texto).toBe(204);
    expect((await profe.get(`/api/cursos/${id}/inscriptos`)).json.profesores).toBe(1);
  });

  test('el dueño transfiere el curso a un profesor', async ({ nucleo }) => {
    const { profe, id } = await cursoNuevo(nucleo);
    await inscribirOk(profe, id, [PROFE2_AUSTRAL], 'profesor');
    const uid = idUsuario(nucleo, PROFE2_AUSTRAL);
    const sin = await profe.post(`/api/cursos/${id}/transferir`, { usuario_id: uid });
    expect(sin.status).toBe(403);
    expect(sin.json.error).toBe('reautenticacion_requerida');
    await reautenticar(profe);
    const r = await profe.post(`/api/cursos/${id}/transferir`, { usuario_id: uid });
    expect(r.status, r.texto).toBe(200);
    expect(r.json.dueno).toMatchObject({ id: uid, email: PROFE2_AUSTRAL });
    const l = await profe.get(`/api/cursos/${id}/inscriptos`);
    expect(l.json.inscriptos.map((i: any) => [i.email, i.rol])).toEqual([
      [PROFE2_AUSTRAL, 'dueño'],
      [PROFE_AUSTRAL, 'profesor'],
    ]);
    expect(nucleo.consultar("SELECT COUNT(*) AS n FROM inscripciones WHERE curso_id = ? AND rol = 'dueño'", id)[0].n).toBe(1);
    const p2 = await sesion(nucleo, PROFE2_AUSTRAL);
    expect((await p2.get(`/api/cursos/${id}`)).json.rol).toBe('dueño');
    expect(auditoria(nucleo, 'curso_transferido').some((e) => String(e.detalle).includes(id))).toBe(true);
  });
});

test.describe('importar el listado del SIU: formatos y límites', () => {
  test('Excel .xls (BIFF) exportado del SIU', async ({ nucleo }) => {
    const { profe, id } = await cursoNuevo(nucleo);
    const n1 = `${aleatorio('xls')}@mail.austral.edu.ar`;
    const libro = crearXls([
      ['Apellido y Nombre', 'Correo electrónico', 'Legajo'],
      ['Núñez, José', n1, '3001'],
      ['Ajeno, Uno', 'uno@otra.edu.ar', '3002'],
    ]);
    expect([...libro.subarray(0, 4)]).toEqual([0xd0, 0xcf, 0x11, 0xe0]);
    const r = await profe.post(`/api/cursos/${id}/inscriptos/siu`, { archivo: 'inscriptos.xls', contenido: libro.toString('base64') });
    expect(r.status, r.texto).toBe(200);
    expect(r.json.agregados).toEqual([n1]);
    expect(r.json.creados).toEqual([n1]);
    expect(r.json.rechazados).toEqual([{ fila: 3, email: 'uno@otra.edu.ar', motivo: 'dominio_no_habilitado' }]);
    const l = await profe.get(`/api/cursos/${id}/inscriptos`);
    expect(l.json.inscriptos.find((i: any) => i.email === n1)).toMatchObject({ nombre: 'José Núñez', rol: 'alumno', pendiente: true });
  });

  test('CSV en Windows-1252', async ({ nucleo }) => {
    const { profe, id } = await cursoNuevo(nucleo);
    const n1 = `${aleatorio('w1252')}@austral.edu.ar`;
    const texto = `Apellido;Nombres;Correo electrónico\r\nO\u0092Neill Muñoz;Agustín;${n1}\r\n`;
    const archivo = Buffer.from(texto, 'latin1');
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(archivo)).toThrow();
    expect(archivo.includes(0x92)).toBe(true);
    const r = await profe.post(`/api/cursos/${id}/inscriptos/siu`, { archivo: 'siu.csv', contenido: archivo.toString('base64') });
    expect(r.status, r.texto).toBe(200);
    expect(r.json.agregados).toEqual([n1]);
    const l = await profe.get(`/api/cursos/${id}/inscriptos`);
    expect(l.json.inscriptos.find((i: any) => i.email === n1).nombre).toBe('Agustín O\u2019Neill Muñoz');
  });

  test('un archivo de hasta 2 MB se acepta', async ({ nucleo }) => {
    const { profe, id } = await cursoNuevo(nucleo);
    const n1 = `${aleatorio('grande')}@austral.edu.ar`;
    const cabecera = `Mail,Nombre,Observaciones\r\n${n1},Grande Uno,`;
    const relleno = 2 * 1024 * 1024 - Buffer.byteLength(cabecera) - 2;
    const archivo = Buffer.from(`${cabecera}${'x'.repeat(relleno)}\r\n`, 'utf8');
    expect(archivo.length).toBe(2 * 1024 * 1024);
    const r = await profe.post(`/api/cursos/${id}/inscriptos/siu`, { archivo: 'grande.csv', contenido: archivo.toString('base64') });
    expect(r.status, r.texto.slice(0, 300)).toBe(200);
    expect(r.json.agregados).toEqual([n1]);
  });

  test('un archivo de más de 2 MB se rechaza', async ({ nucleo }) => {
    const { profe, id } = await cursoNuevo(nucleo);
    const n1 = `${aleatorio('enorme')}@austral.edu.ar`;
    const cabecera = `Mail,Nombre,Observaciones\r\n${n1},Enorme Uno,`;
    const archivo = Buffer.from(`${cabecera}${'x'.repeat(2 * 1024 * 1024)}\r\n`, 'utf8');
    const contenido = archivo.toString('base64');
    expect(Buffer.byteLength(JSON.stringify({ archivo: 'x.csv', contenido }))).toBeLessThan(4 * 1024 * 1024);
    const r = await profe.post(`/api/cursos/${id}/inscriptos/siu`, { archivo: 'enorme.csv', contenido });
    expect([400, 413]).toContain(r.status);
    if (r.status === 400) expect(r.json.error).toBe('archivo_invalido');
    expect(nucleo.consultar('SELECT id FROM usuarios WHERE email = ?', n1)).toEqual([]);
  });

  test('un cuerpo de más de 4 MB se corta con 413', async ({ nucleo }) => {
    const { profe, id } = await cursoNuevo(nucleo);
    const contenido = Buffer.alloc(3 * 1024 * 1024 + 512 * 1024, 0x61).toString('base64');
    expect(Buffer.byteLength(JSON.stringify({ archivo: 'x.csv', contenido }))).toBeGreaterThan(4 * 1024 * 1024);
    const r = await profe.post(`/api/cursos/${id}/inscriptos/siu`, { archivo: 'x.csv', contenido });
    expect(r.status).toBe(413);
  });

  test('las demás rutas siguen con el límite general de cuerpo', async ({ nucleo }) => {
    const { profe, id } = await cursoNuevo(nucleo);
    const emails = Array.from({ length: 3 }, (_, i) => `${'x'.repeat(1024 * 1024)}${i}@austral.edu.ar`);
    const r = await profe.post(`/api/cursos/${id}/inscriptos`, { emails, rol: 'alumno' });
    expect(r.status).toBe(413);
  });
});
