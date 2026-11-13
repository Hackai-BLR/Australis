import fs from 'node:fs';
import path from 'node:path';
import { crearTestCursos, expect, PROFE_AUSTRAL, PROFE2_AUSTRAL, ALUMNO_AUSTRAL } from '../fixtures.ts';
import { DOMINIO } from '../../comun/entorno.ts';
import { docker, corriendo, inspeccionar } from '../lib/docker.ts';
import {
  TIEMPO_PRUEBA_DOCKER,
  apiDeCurso,
  contenedorDe,
  cursoListo,
  enCurso,
  esperarHasta,
  getCurso,
  idAleatorio,
  idUsuario,
  inscribirOk,
  pedirApiCursos,
  sesion,
  tokenDeCurso,
} from '../lib/cursos.ts';

const test = crearTestCursos();
test.describe.configure({ mode: 'serial', timeout: TIEMPO_PRUEBA_DOCKER });

let id = '';
let nombre = '';

test.describe('enrutador de cursos', () => {
  test.beforeAll(async ({ nucleo }) => {
    test.setTimeout(TIEMPO_PRUEBA_DOCKER);
    const profe = await sesion(nucleo, PROFE_AUSTRAL);
    id = idAleatorio('red');
    nombre = `Redes Avanzadas ${id}`;
    await cursoListo(profe, { id, nombre, periodo: 'Anual 2027' });
    await inscribirOk(profe, id, [PROFE2_AUSTRAL], 'profesor');
    await inscribirOk(profe, id, [ALUMNO_AUSTRAL]);
  });

  test('el alumno ve el curso publicado en su subdominio', async ({ nucleo }) => {
    const alumno = await sesion(nucleo, ALUMNO_AUSTRAL);
    const r = await getCurso(alumno, id, '/');
    expect(r.status, r.texto.slice(0, 500)).toBe(200);
    expect(String(r.encabezados['content-type'])).toContain('text/html');
    expect(r.texto).toMatch(/<html[^>]*lang="es"/);
    expect(r.texto).not.toContain('Curso en preparación');
    expect(r.encabezados['set-cookie']).toBeUndefined();
    const csp = ([] as string[]).concat(r.encabezados['content-security-policy'] ?? []).join(', ');
    expect(csp).toContain(`frame-ancestors http://${id}.${DOMINIO}:${nucleo.puerto}`);
    expect(String(r.encabezados['x-content-type-options'])).toBe('nosniff');
  });

  test('el curso lee la identidad de cada rol con el SDK', async ({ nucleo }) => {
    for (const [email, rol] of [
      [PROFE_AUSTRAL, 'dueño'],
      [PROFE2_AUSTRAL, 'profesor'],
      [ALUMNO_AUSTRAL, 'alumno'],
    ]) {
      const c = await sesion(nucleo, email);
      const r = await getCurso(c, id, '/api/yo');
      expect(r.status, `${email}: ${r.texto}`).toBe(200);
      const fila = nucleo.consultar('SELECT id, nombre FROM usuarios WHERE email = ?', email)[0];
      expect(r.json).toEqual({ usuario: String(fila.id), email, nombre: fila.nombre, rol });
    }
  });

  test('la portada trae los datos de la plataforma con el token del curso', async ({ nucleo }) => {
    const alumno = await sesion(nucleo, ALUMNO_AUSTRAL);
    const r = await getCurso(alumno, id, '/api/portada');
    expect(r.status, r.texto).toBe(200);
    expect(r.json.curso).toEqual({ id, nombre, periodo: 'Anual 2027' });
    expect(r.json.profesores).toEqual([
      { nombre: 'Lucía Fernández', rol: 'dueño' },
      { nombre: 'Diego Herrera', rol: 'profesor' },
    ]);
    expect(r.json.yo).toEqual({ nombre: 'Tomás García', rol: 'alumno' });
    expect(JSON.stringify(r.json)).not.toContain('@');
  });

  test('la API para cursos responde con los formatos del SDK', async ({ nucleo }) => {
    const api = apiDeCurso(nucleo, id).replace(/\/$/, '');
    const token = tokenDeCurso(nucleo, id);
    const yo = await pedirApiCursos(`${api}/api/curso/yo`, token);
    expect(yo.status, yo.texto).toBe(200);
    expect(yo.json).toEqual({ id, nombre, periodo: 'Anual 2027' });
    const ins = await pedirApiCursos(`${api}/api/curso/inscriptos`, token);
    expect(ins.status).toBe(200);
    expect(Array.isArray(ins.json)).toBe(true);
    expect(ins.json).toEqual([
      { id: String(idUsuario(nucleo, PROFE_AUSTRAL)), nombre: 'Lucía Fernández', email: PROFE_AUSTRAL, rol: 'dueño' },
      { id: String(idUsuario(nucleo, PROFE2_AUSTRAL)), nombre: 'Diego Herrera', email: PROFE2_AUSTRAL, rol: 'profesor' },
      { id: String(idUsuario(nucleo, ALUMNO_AUSTRAL)), nombre: 'Tomás García', email: ALUMNO_AUSTRAL, rol: 'alumno' },
    ]);
    const salud = await pedirApiCursos(`${api}/salud`, null);
    expect(salud.status).toBe(200);
  });

  test('los profesores crean clases y los alumnos las ven; los datos quedan en la carpeta del curso', async ({ nucleo }) => {
    const p2 = await sesion(nucleo, PROFE2_AUSTRAL);
    const c = await enCurso(p2, id, 'POST', '/api/clases', { titulo: 'Subredes y máscaras', fecha: '2026-09-15' });
    expect(c.status, c.texto).toBe(201);
    const alumno = await sesion(nucleo, ALUMNO_AUSTRAL);
    const prohibido = await enCurso(alumno, id, 'POST', '/api/clases', { titulo: 'No' });
    expect(prohibido.status).toBe(403);
    const l = await getCurso(alumno, id, '/api/clases');
    expect(l.json.map((x: any) => x.titulo)).toEqual(['Subredes y máscaras']);
    expect(fs.existsSync(path.join(nucleo.raizCursos, id, 'datos', 'curso.sqlite'))).toBe(true);
  });

  test('si alguien borra el contenedor, la siguiente visita lo recrea con los mismos datos', async ({ nucleo }) => {
    docker(['rm', '-f', contenedorDe(nucleo, id)]);
    expect(inspeccionar(contenedorDe(nucleo, id))).toBeNull();
    const alumno = await sesion(nucleo, ALUMNO_AUSTRAL);
    const r = await getCurso(alumno, id, '/api/clases');
    expect(r.status, r.texto).toBe(200);
    expect(r.json.map((x: any) => x.titulo)).toEqual(['Subredes y máscaras']);
    expect(corriendo(contenedorDe(nucleo, id))).toBe(true);
    const yo = await getCurso(alumno, id, '/api/portada');
    expect(yo.status, yo.texto).toBe(200);
  });

  test('el estado del contenedor se ve en la API', async ({ nucleo }) => {
    const alumno = await sesion(nucleo, ALUMNO_AUSTRAL);
    await getCurso(alumno, id, '/api/yo');
    const r = await alumno.get(`/api/cursos/${id}`);
    expect(r.json).toMatchObject({ id, estado: 'listo', contenedor: 'encendido', rol: 'alumno' });
  });

  test('sin sesión se ofrece entrar por la barra, sin mostrar el curso', async ({ nucleo, cliente }) => {
    const r = await getCurso(cliente(), id, '/');
    expect(r.status).toBe(401);
    expect(r.texto).not.toContain(nombre);
    expect(r.texto).toContain(`${id}.${DOMINIO}`);
  });

  test('los cursos sembrados siguen con la página provisoria', async ({ nucleo }) => {
    const alumno = await sesion(nucleo, ALUMNO_AUSTRAL);
    const r = await getCurso(alumno, 'redes', '/');
    expect(r.status).toBe(200);
    expect(r.texto).toContain('Redes de Computadoras');
    expect(r.texto).toContain('Curso en preparación');
    expect((await getCurso(alumno, 'redes', '/api/yo')).status).toBe(404);
  });

  test('un curso que se está preparando responde que se está preparando', async ({ nucleo }) => {
    const profe = await sesion(nucleo, PROFE_AUSTRAL);
    const otro = idAleatorio('prep');
    const cr = await profe.post('/api/cursos', { nombre: 'En preparación', subdominio: otro, periodo: 'Anual 2027' });
    expect(cr.status).toBe(201);
    const r = await getCurso(profe, otro, '/');
    if (r.status === 503) {
      expect(r.texto).toContain('Preparando el curso');
      expect(r.encabezados['retry-after']).toBeTruthy();
    } else {
      expect(r.status).toBe(200);
    }
    await esperarHasta(async () => (await profe.get(`/api/cursos/${otro}`)).json?.estado === 'listo', 480_000, 'curso listo');
    expect((await getCurso(profe, otro, '/')).status).toBe(200);
  });
});
