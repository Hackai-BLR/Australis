import { crearTestTramo, expect, ADMIN_AUSTRAL, PROFE_AUSTRAL } from '../fixtures.ts';
import { corriendo, docker } from '../../fase-2/lib/docker.ts';
import { TIEMPO_PRUEBA_DOCKER, apiDeCurso, contenedorDe, cursoListo, getCurso, inscribirOk, pedirApiCursos, tokenDeCurso } from '../../fase-2/lib/cursos.ts';
import { archivar, cuentaNueva, esperarHasta, revivirSesiones, sesionReautenticada, suspender } from '../lib.ts';

const test = crearTestTramo({ docker: true });
test.describe.configure({ timeout: TIEMPO_PRUEBA_DOCKER });

test('un curso archivado no se enciende con visitas ni acepta su token de curso', async ({ nucleo }) => {
  const prefijo = { prefijo: nucleo.prefijo as string };
  const dueno = await sesionReautenticada(nucleo, PROFE_AUSTRAL);
  const id = await cursoListo(dueno);
  const alumno = await cuentaNueva(nucleo);
  await inscribirOk(dueno, id, [alumno.email]);
  expect((await getCurso(alumno.cliente, id)).status).toBe(200);
  const nombre = contenedorDe(prefijo, id);
  const api = apiDeCurso(prefijo, id);
  const token = tokenDeCurso(prefijo, id);
  expect((await pedirApiCursos(`${api}/api/curso/yo`, token)).status).toBe(200);

  expect((await archivar(dueno, id)).status).toBe(200);
  await esperarHasta(() => !corriendo(nombre), 30_000, 'el contenedor del curso archivado se detiene');

  for (const ruta of ['/api/curso/yo', '/api/curso/inscriptos', '/api/curso/entregas']) {
    const r = await pedirApiCursos(`${api}${ruta}`, token);
    expect(r.status, `${ruta}: ${r.texto}`).toBe(401);
  }

  const visitas = await Promise.all(Array.from({ length: 12 }, () => getCurso(alumno.cliente, id)));
  for (const v of visitas) expect(v.status).toBe(403);
  docker(['start', nombre], true);
  await new Promise((res) => setTimeout(res, 3000));
  const despues = await getCurso(alumno.cliente, id);
  expect(despues.status, 'aunque alguien encienda el contenedor a mano, el enrutador no lo sirve').toBe(403);
  await esperarHasta(() => !corriendo(nombre), 60_000, 'el núcleo vuelve a detener un curso archivado que alguien encendió');
});

test('el enrutador no reenvía nada para una cuenta suspendida con la sesión revivida', async ({ nucleo }) => {
  const prefijo = { prefijo: nucleo.prefijo as string };
  const ana = await sesionReautenticada(nucleo, ADMIN_AUSTRAL);
  const dueno = await sesionReautenticada(nucleo, PROFE_AUSTRAL);
  const id = await cursoListo(dueno);
  const alumno = await cuentaNueva(nucleo);
  await inscribirOk(dueno, id, [alumno.email]);
  expect((await getCurso(alumno.cliente, id)).status).toBe(200);
  expect((await suspender(ana, alumno.id)).status).toBe(200);
  revivirSesiones(nucleo, alumno.email);
  const origen = `${nucleo.esquema()}://${nucleo.host(`${id}-curso`)}`;
  for (const [metodo, ruta] of [['GET', '/'], ['GET', '/api/entregas'], ['POST', '/api/entregas']]) {
    const r = await alumno.cliente.pedir(metodo, ruta, metodo === 'POST' ? { actividad: 'tp1', texto: 'x' } : undefined, { sub: `${id}-curso`, origen });
    expect(r.status, `${metodo} ${ruta}: ${r.texto.slice(0, 200)}`).toBe(403);
  }
  expect(nucleo.consultar('SELECT COUNT(*) AS n FROM entregas WHERE curso_id = ?', id)[0].n).toBe(0);
  expect(corriendo(contenedorDe(prefijo, id))).toBe(true);
});
