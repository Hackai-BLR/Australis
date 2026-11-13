import { crearTestTramo, expect, ADMIN_AUSTRAL, OWNER, PROFE_AUSTRAL } from '../fixtures.ts';
import { entrar, reautenticar } from '../../comun/sesion.ts';
import { Cliente } from '../../comun/http.ts';
import { corriendo } from '../../fase-2/lib/docker.ts';
import { TIEMPO_PRUEBA_DOCKER, apiDeCurso, contenedorDe, cursoListo, getCurso, inscribirOk, pedirApiCursos, tokenDeCurso } from '../../fase-2/lib/cursos.ts';
import {
  archivar,
  cuentaNueva,
  desarchivar,
  deshabilitar,
  esperarHasta,
  profesorNuevo,
  rehabilitar,
  revivirSesiones,
  sesion,
  sesionReautenticada,
  suspender,
  universidadNueva,
} from '../lib.ts';

const test = crearTestTramo({ docker: true });
test.describe.configure({ timeout: TIEMPO_PRUEBA_DOCKER });

function nombre(nucleo: { prefijo: string | null }, id: string) {
  return contenedorDe({ prefijo: nucleo.prefijo as string }, id);
}

test('el contenedor de un curso archivado se detiene, no se enciende con visitas y vuelve al desarchivar', async ({ nucleo }) => {
  const dueno = await sesionReautenticada(nucleo, PROFE_AUSTRAL);
  const id = await cursoListo(dueno);
  const alumno = await cuentaNueva(nucleo);
  await inscribirOk(dueno, id, [alumno.email]);
  const antes = await getCurso(alumno.cliente, id);
  expect(antes.status, antes.texto.slice(0, 300)).toBe(200);
  expect(corriendo(nombre(nucleo, id))).toBe(true);

  const r = await archivar(dueno, id);
  expect(r.status, r.texto).toBe(200);
  await esperarHasta(() => !corriendo(nombre(nucleo, id)), 30_000, 'el contenedor del curso archivado se detiene');

  for (let i = 0; i < 3; i++) {
    expect((await getCurso(alumno.cliente, id)).status).toBe(403);
    const d = await getCurso(dueno, id);
    expect(d.status).toBe(403);
    expect(d.texto).toContain('Curso archivado');
  }
  await new Promise((res) => setTimeout(res, 4000));
  expect(corriendo(nombre(nucleo, id)), 'nadie vuelve a encender un curso archivado').toBe(false);

  const r2 = await desarchivar(dueno, id);
  expect(r2.status, r2.texto).toBe(200);
  const despues = await getCurso(alumno.cliente, id);
  expect(despues.status, despues.texto.slice(0, 300)).toBe(200);
  expect(corriendo(nombre(nucleo, id))).toBe(true);
});

test('los cursos de una universidad deshabilitada se detienen y vuelven al rehabilitarla', async ({ nucleo }) => {
  const owner = await sesionReautenticada(nucleo, OWNER);
  const uni = await universidadNueva(owner);
  const admin = await sesion(nucleo, uni.admin);
  await reautenticar(admin);
  const profe = await profesorNuevo(nucleo, admin, uni.dominio);
  const id = await cursoListo(profe.cliente);
  expect((await getCurso(profe.cliente, id)).status).toBe(200);
  expect(corriendo(nombre(nucleo, id))).toBe(true);

  expect((await deshabilitar(owner, uni.id)).status).toBe(200);
  await esperarHasta(() => !corriendo(nombre(nucleo, id)), 30_000, 'el contenedor de la universidad deshabilitada se detiene');

  revivirSesiones(nucleo, profe.email);
  const p = await getCurso(profe.cliente, id);
  expect(p.status).toBe(403);
  await new Promise((res) => setTimeout(res, 4000));
  expect(corriendo(nombre(nucleo, id))).toBe(false);

  expect((await rehabilitar(owner, uni.id)).status).toBe(200);
  const vuelta = new Cliente(nucleo);
  await entrar(vuelta, profe.email);
  const v = await getCurso(vuelta, id);
  expect(v.status, v.texto.slice(0, 300)).toBe(200);
  expect(corriendo(nombre(nucleo, id))).toBe(true);
});

test('el curso de un dueño suspendido sigue funcionando y la API para cursos no lista a los inactivos', async ({ nucleo }) => {
  const admin = await sesionReautenticada(nucleo, ADMIN_AUSTRAL);
  const profe = await profesorNuevo(nucleo, admin);
  const id = await cursoListo(profe.cliente);
  const alumno = await cuentaNueva(nucleo);
  const otra = await cuentaNueva(nucleo);
  await inscribirOk(profe.cliente, id, [alumno.email, otra.email]);
  expect((await getCurso(alumno.cliente, id)).status).toBe(200);

  expect((await suspender(admin, profe.id)).status).toBe(200);
  expect((await suspender(admin, otra.id)).status).toBe(200);
  const r = await getCurso(alumno.cliente, id);
  expect(r.status, r.texto.slice(0, 300)).toBe(200);

  const lista = await pedirApiCursos(`${apiDeCurso(nucleo as any, id)}/api/curso/inscriptos`, tokenDeCurso(nucleo as any, id));
  expect(lista.status, lista.texto).toBe(200);
  const emails = lista.json.map((i: any) => i.email);
  expect(emails).toContain(alumno.email);
  expect(emails).not.toContain(otra.email);
  expect(emails).not.toContain(profe.email);
});
