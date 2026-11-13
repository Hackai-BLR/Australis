import { crearTestCursos, expect, PROFE_AUSTRAL, ALUMNO_AUSTRAL } from '../fixtures.ts';
import { corriendo, inspeccionar } from '../lib/docker.ts';
import {
  TIEMPO_PRUEBA_DOCKER,
  contenedorDe,
  cursoListo,
  enCurso,
  esperarHasta,
  getCurso,
  idAleatorio,
  inscribirOk,
  sesion,
} from '../lib/cursos.ts';

const test = crearTestCursos({ inactividadSeg: 6 });
test.describe.configure({ mode: 'serial', timeout: TIEMPO_PRUEBA_DOCKER });

test.describe('apagado por inactividad y encendido con una visita', () => {
  test('el curso se apaga solo, se despierta con una visita y conserva sus datos', async ({ nucleo }) => {
    const profe = await sesion(nucleo, PROFE_AUSTRAL);
    const id = idAleatorio('dor');
    await cursoListo(profe, { id, nombre: 'Curso Dormilón' });
    await inscribirOk(profe, id, [ALUMNO_AUSTRAL]);
    const nombre = contenedorDe(nucleo, id);
    const c = await enCurso(profe, id, 'POST', '/api/clases', { titulo: 'Antes de dormir' });
    expect(c.status, c.texto).toBe(201);
    expect(corriendo(nombre)).toBe(true);

    await esperarHasta(() => !corriendo(nombre), 60_000, 'el contenedor se detiene por inactividad');
    expect(inspeccionar(nombre), 'el contenedor se detiene, no se borra').toBeTruthy();
    const estado = await profe.get(`/api/cursos/${id}`);
    expect(estado.json.contenedor).toBe('apagado');

    const alumno = await sesion(nucleo, ALUMNO_AUSTRAL);
    const r = await getCurso(alumno, id, '/');
    expect(r.status, r.texto.slice(0, 300)).toBe(200);
    expect(String(r.encabezados['content-type'])).toContain('text/html');
    expect(corriendo(nombre)).toBe(true);
    const clases = await getCurso(alumno, id, '/api/clases');
    expect(clases.status).toBe(200);
    expect(clases.json.map((x: any) => x.titulo)).toEqual(['Antes de dormir']);
    expect((await profe.get(`/api/cursos/${id}`)).json.contenedor).toBe('encendido');
  });

  test('las visitas mantienen encendido el curso', async ({ nucleo }) => {
    const profe = await sesion(nucleo, PROFE_AUSTRAL);
    const id = idAleatorio('act');
    await cursoListo(profe, { id });
    const nombre = contenedorDe(nucleo, id);
    const fin = Date.now() + 15_000;
    while (Date.now() < fin) {
      expect((await getCurso(profe, id, '/api/yo')).status).toBe(200);
      expect(corriendo(nombre)).toBe(true);
      await new Promise((r) => setTimeout(r, 2000));
    }
  });

  test('varias peticiones simultáneas a un curso dormido esperan el mismo arranque', async ({ nucleo }) => {
    const profe = await sesion(nucleo, PROFE_AUSTRAL);
    const id = idAleatorio('sim');
    await cursoListo(profe, { id });
    const nombre = contenedorDe(nucleo, id);
    await esperarHasta(() => !corriendo(nombre), 60_000, 'el contenedor se detiene por inactividad');
    const inicioAntes = inspeccionar(nombre).State.StartedAt;
    const respuestas = await Promise.all(Array.from({ length: 8 }, () => getCurso(profe, id, '/api/yo')));
    for (const r of respuestas) {
      expect(r.status, r.texto).toBe(200);
      expect(r.json.rol).toBe('dueño');
    }
    const info = inspeccionar(nombre);
    expect(info.State.Running).toBe(true);
    expect(info.State.StartedAt).not.toBe(inicioAntes);
    expect(info.RestartCount ?? 0).toBe(0);
  });
});
