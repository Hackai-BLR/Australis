import { crearTestTramo, expect, ADMIN_AUSTRAL, PROFE_AUSTRAL, PROFE2_AUSTRAL } from '../fixtures.ts';
import {
  AUSTRAL,
  archivar,
  cuentaNueva,
  cursoDePrueba,
  desarchivar,
  fila,
  idUniversidad,
  idUsuario,
  paginaCurso,
  sesion,
  sesionReautenticada,
  ultimaAuditoria,
} from '../lib.ts';

const test = crearTestTramo();

test('el dueño archiva: el curso se oculta a los alumnos, se marca para los docentes y vuelve al desarchivar', async ({ nucleo }) => {
  const uni = idUniversidad(nucleo, AUSTRAL);
  const alumno = await cuentaNueva(nucleo);
  const curso = cursoDePrueba(nucleo, { universidad: uni, dueno: PROFE_AUSTRAL, profesores: [PROFE2_AUSTRAL], alumnos: [alumno.email] });
  const dueno = await sesionReautenticada(nucleo, PROFE_AUSTRAL);
  const profe = await sesion(nucleo, PROFE2_AUSTRAL);
  const admin = await sesion(nucleo, ADMIN_AUSTRAL);

  const antes = await dueno.get(`/api/cursos/${curso}`);
  expect(antes.status).toBe(200);
  expect(antes.json.archivado).toBe(false);

  const r = await archivar(dueno, curso);
  expect(r.status, r.texto).toBe(200);
  expect(r.json.id).toBe(curso);
  expect(r.json.archivado).toBe(true);
  const f = fila(nucleo, 'SELECT archivado_en, archivado_por FROM cursos WHERE id = ?', curso);
  expect(f.archivado_en).toBeTruthy();
  expect(Number(f.archivado_por)).toBe(idUsuario(nucleo, PROFE_AUSTRAL));

  const misAlumno = await alumno.cliente.get('/api/mis-cursos');
  expect(misAlumno.status).toBe(200);
  expect(misAlumno.json.cursos.map((c: any) => c.id)).not.toContain(curso);
  expect((await alumno.cliente.get(`/api/cursos/${curso}`)).status).toBe(404);

  for (const docente of [dueno, profe]) {
    const mis = await docente.get('/api/mis-cursos');
    const item = mis.json.cursos.find((c: any) => c.id === curso);
    expect(item, 'el docente sigue viendo el curso').toBeTruthy();
    expect(item.archivado).toBe(true);
    const ver = await docente.get(`/api/cursos/${curso}`);
    expect(ver.status).toBe(200);
    expect(ver.json.archivado).toBe(true);
    expect((await docente.get(`/api/cursos/${curso}/inscriptos`)).status).toBe(200);
  }
  const otros = (await dueno.get('/api/mis-cursos')).json.cursos.filter((c: any) => c.id !== curso);
  for (const c of otros) expect(typeof c.archivado).toBe('boolean');

  const adminCursos = await admin.get('/api/admin/cursos');
  expect(adminCursos.json.cursos.find((c: any) => c.id === curso).archivado).toBe(true);

  for (const c of [alumno.cliente, dueno]) {
    const p = await paginaCurso(c, curso);
    expect(p.status).toBe(403);
    expect(p.texto).not.toContain('Curso en preparación');
  }

  const e = ultimaAuditoria(nucleo, 'curso_archivado', curso);
  expect(e).toBeTruthy();
  expect(Number(e.universidad_id)).toBe(uni);

  const r2 = await desarchivar(dueno, curso);
  expect(r2.status, r2.texto).toBe(200);
  expect(r2.json.archivado).toBe(false);
  expect(fila(nucleo, 'SELECT archivado_en FROM cursos WHERE id = ?', curso).archivado_en).toBeNull();
  expect((await alumno.cliente.get('/api/mis-cursos')).json.cursos.map((c: any) => c.id)).toContain(curso);
  expect((await alumno.cliente.get(`/api/cursos/${curso}`)).status).toBe(200);
  expect((await paginaCurso(alumno.cliente, curso)).status).toBe(200);
  expect(ultimaAuditoria(nucleo, 'curso_desarchivado', curso)).toBeTruthy();
});

test('el administrador de la universidad archiva y desarchiva', async ({ nucleo }) => {
  const uni = idUniversidad(nucleo, AUSTRAL);
  const alumno = await cuentaNueva(nucleo);
  const curso = cursoDePrueba(nucleo, { universidad: uni, dueno: PROFE_AUSTRAL, alumnos: [alumno.email] });
  const admin = await sesionReautenticada(nucleo, ADMIN_AUSTRAL);

  const r = await archivar(admin, curso, 'admin');
  expect(r.status, r.texto).toBe(200);
  expect(r.json.id).toBe(curso);
  expect(r.json.archivado).toBe(true);
  expect(Number(fila(nucleo, 'SELECT archivado_por FROM cursos WHERE id = ?', curso).archivado_por)).toBe(idUsuario(nucleo, ADMIN_AUSTRAL));
  expect((await alumno.cliente.get('/api/mis-cursos')).json.cursos.map((c: any) => c.id)).not.toContain(curso);
  expect((await archivar(admin, curso, 'admin')).status).toBe(200);

  const r2 = await desarchivar(admin, curso, 'admin');
  expect(r2.status, r2.texto).toBe(200);
  expect(r2.json.archivado).toBe(false);
  expect((await alumno.cliente.get('/api/mis-cursos')).json.cursos.map((c: any) => c.id)).toContain(curso);
});

test('los datos del curso archivado se conservan y los docentes los pueden leer', async ({ nucleo }) => {
  const uni = idUniversidad(nucleo, AUSTRAL);
  const alumno = await cuentaNueva(nucleo);
  const curso = cursoDePrueba(nucleo, { universidad: uni, dueno: PROFE_AUSTRAL, alumnos: [alumno.email] });
  const dueno = await sesionReautenticada(nucleo, PROFE_AUSTRAL);

  const entrega = await alumno.cliente.post(`/api/cursos/${curso}/entregas`, { actividad: 'tp1', texto: 'mi entrega' });
  expect(entrega.status, entrega.texto).toBe(201);
  const nota = await dueno.post(`/api/cursos/${curso}/notas`, { usuario_id: alumno.id, actividad: 'tp1', valor: '9' });
  expect(nota.status, nota.texto).toBe(201);

  expect((await archivar(dueno, curso)).status).toBe(200);

  const entregas = await dueno.get(`/api/cursos/${curso}/entregas`);
  expect(entregas.status).toBe(200);
  expect(entregas.json.entregas.some((e: any) => e.texto === 'mi entrega')).toBe(true);
  const notas = await dueno.get(`/api/cursos/${curso}/notas`);
  expect(notas.status).toBe(200);
  expect(notas.json.notas.some((n: any) => n.valor === '9')).toBe(true);
  expect((await dueno.get(`/api/cursos/${curso}/notas/historial`)).status).toBe(200);
  expect((await dueno.get(`/api/cursos/${curso}/archivos`)).status).toBe(200);
  expect(fila(nucleo, 'SELECT COUNT(*) AS n FROM entregas WHERE curso_id = ?', curso).n).toBe(1);
  expect(fila(nucleo, 'SELECT COUNT(*) AS n FROM notas WHERE curso_id = ?', curso).n).toBe(1);
  expect(fila(nucleo, 'SELECT COUNT(*) AS n FROM inscripciones WHERE curso_id = ?', curso).n).toBe(2);

  expect((await desarchivar(dueno, curso)).status).toBe(200);
  const propias = await alumno.cliente.get(`/api/cursos/${curso}/entregas`);
  expect(propias.status).toBe(200);
  expect(propias.json.entregas.some((e: any) => e.texto === 'mi entrega')).toBe(true);
});

test('el curso archivado se puede transferir', async ({ nucleo }) => {
  const uni = idUniversidad(nucleo, AUSTRAL);
  const curso = cursoDePrueba(nucleo, { universidad: uni, dueno: PROFE_AUSTRAL, profesores: [PROFE2_AUSTRAL] });
  const dueno = await sesionReautenticada(nucleo, PROFE_AUSTRAL);
  expect((await archivar(dueno, curso)).status).toBe(200);
  const t = await dueno.post(`/api/cursos/${curso}/transferir`, { usuario_id: idUsuario(nucleo, PROFE2_AUSTRAL) });
  expect(t.status, t.texto).toBe(200);
  expect(t.json.dueno.email).toBe(PROFE2_AUSTRAL);
  const admin = await sesionReautenticada(nucleo, ADMIN_AUSTRAL);
  const t2 = await admin.post(`/api/admin/cursos/${curso}/transferir`, { usuario_id: idUsuario(nucleo, PROFE_AUSTRAL) });
  expect(t2.status, t2.texto).toBe(200);
  expect(t2.json.dueno.email).toBe(PROFE_AUSTRAL);
});
