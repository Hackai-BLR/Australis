import { crearTestTramo, expect, ADMIN_AUSTRAL, OWNER, PROFE_AUSTRAL, PROFE2_AUSTRAL, PROFE3_AUSTRAL } from '../fixtures.ts';
import { reautenticar } from '../../comun/sesion.ts';
import type { Nucleo } from '../../comun/nucleo.ts';
import {
  AUSTRAL,
  archivar,
  cuentaNueva,
  cursoDePrueba,
  darDeBaja,
  ejecutarSql,
  fila,
  idUniversidad,
  idUsuario,
  paginaCurso,
  revivirSesiones,
  sesion,
  sesionReautenticada,
  suspender,
  tokenPersonal,
} from '../lib.ts';

const test = crearTestTramo();

function conteos(nucleo: Nucleo, curso: string) {
  return JSON.stringify({
    inscripciones: nucleo.consultar('SELECT usuario_id, rol FROM inscripciones WHERE curso_id = ? ORDER BY usuario_id', curso),
    codigo: nucleo.consultar('SELECT codigo, activo, vence_en FROM codigos_curso WHERE curso_id = ?', curso),
    entregas: fila(nucleo, 'SELECT COUNT(*) AS n FROM entregas WHERE curso_id = ?', curso).n,
    notas: fila(nucleo, 'SELECT COUNT(*) AS n FROM notas WHERE curso_id = ?', curso).n,
    archivos: fila(nucleo, 'SELECT COUNT(*) AS n FROM archivos WHERE curso_id = ?', curso).n,
  });
}

test('nadie entra a un curso archivado por su subdominio', async ({ nucleo }) => {
  const alumno = await cuentaNueva(nucleo);
  const curso = cursoDePrueba(nucleo, { universidad: idUniversidad(nucleo, AUSTRAL), dueno: PROFE_AUSTRAL, profesores: [PROFE2_AUSTRAL], alumnos: [alumno.email] });
  const dueno = await sesionReautenticada(nucleo, PROFE_AUSTRAL);
  const profe = await sesion(nucleo, PROFE2_AUSTRAL);
  const admin = await sesion(nucleo, ADMIN_AUSTRAL);
  expect((await archivar(dueno, curso)).status).toBe(200);
  const origen = `${nucleo.esquema()}://${nucleo.host(`${curso}-curso`)}`;
  for (const c of [alumno.cliente, dueno, profe, admin]) {
    for (const [metodo, ruta] of [['GET', '/'], ['GET', '/api/algo'], ['HEAD', '/'], ['POST', '/api/entregas']]) {
      const r = await c.pedir(metodo, ruta, metodo === 'POST' ? { x: 1 } : undefined, { sub: `${curso}-curso`, origen });
      expect(r.status, `${metodo} ${ruta}: ${r.texto.slice(0, 200)}`).toBe(403);
      expect(r.texto).not.toContain('Curso en preparación');
    }
  }
  const sinSesion = await paginaCurso(alumno.cliente, curso, { sinCookies: true });
  expect(sinSesion.status).toBe(401);
  const r = await paginaCurso(alumno.cliente, curso);
  expect(r.texto).not.toContain(`Curso de prueba ${curso}`);
});

test('un curso archivado no se puede modificar', async ({ nucleo }) => {
  const alumno = await cuentaNueva(nucleo);
  const curso = cursoDePrueba(nucleo, { universidad: idUniversidad(nucleo, AUSTRAL), dueno: PROFE_AUSTRAL, profesores: [PROFE2_AUSTRAL], alumnos: [alumno.email] });
  const dueno = await sesionReautenticada(nucleo, PROFE_AUSTRAL);
  const profe = await sesionReautenticada(nucleo, PROFE2_AUSTRAL);
  const gen = await dueno.post(`/api/cursos/${curso}/codigo`, { dias: 30 });
  expect(gen.status, gen.texto).toBe(200);
  expect((await archivar(dueno, curso)).status).toBe(200);
  const antes = conteos(nucleo, curso);
  const nuevo = await cuentaNueva(nucleo);

  const intentos: [string, () => Promise<any>][] = [
    ['inscribir alumnos', () => dueno.post(`/api/cursos/${curso}/inscriptos`, { emails: [nuevo.email], rol: 'alumno' })],
    ['inscribir profesores', () => dueno.post(`/api/cursos/${curso}/inscriptos`, { emails: [PROFE3_AUSTRAL], rol: 'profesor' })],
    ['inscribir un profesor del curso', () => profe.post(`/api/cursos/${curso}/inscriptos`, { emails: [nuevo.email], rol: 'alumno' })],
    ['importar del SIU', () => dueno.post(`/api/cursos/${curso}/inscriptos/siu`, { archivo: 'a.csv', contenido: Buffer.from(`mail\n${nuevo.email}\n`).toString('base64') })],
    ['cambiar rol', () => dueno.put(`/api/cursos/${curso}/inscriptos/${idUsuario(nucleo, PROFE2_AUSTRAL)}`, { rol: 'alumno' })],
    ['quitar alumno', () => dueno.delete(`/api/cursos/${curso}/inscriptos/${alumno.id}`)],
    ['generar código', () => dueno.post(`/api/cursos/${curso}/codigo`, { dias: 10 })],
    ['activar código', () => dueno.put(`/api/cursos/${curso}/codigo`, { activo: false })],
    ['entregar', () => dueno.post(`/api/cursos/${curso}/entregas`, { actividad: 'tp1', texto: 'no' })],
    ['poner nota', () => dueno.post(`/api/cursos/${curso}/notas`, { usuario_id: alumno.id, actividad: 'tp1', valor: '10' })],
    ['subir archivo', () => dueno.pedir('POST', `/api/cursos/${curso}/archivos?nombre=a.txt`, undefined, { cuerpoCrudo: 'hola', tipo: 'application/octet-stream' })],
  ];
  for (const [nombre, intento] of intentos) {
    const r = await intento();
    expect(r.status, `${nombre}: ${r.texto}`).toBe(409);
    expect(r.json.error, nombre).toBe('curso_archivado');
  }
  expect(conteos(nucleo, curso)).toBe(antes);

  const codigo = gen.json.codigo;
  const unirse = await nuevo.cliente.post('/api/unirse', { codigo });
  const inventado = await nuevo.cliente.post('/api/unirse', { codigo: 'ZZZ-ZZZZZZ' });
  expect(unirse.status).toBe(400);
  expect(unirse.json.error).toBe('codigo_invalido');
  expect(unirse.texto).toBe(inventado.texto);
  expect(fila(nucleo, 'SELECT COUNT(*) AS n FROM inscripciones WHERE curso_id = ? AND usuario_id = ?', curso, nuevo.id).n).toBe(0);
});

test('un alumno no ve el curso archivado por ninguna ruta', async ({ nucleo }) => {
  const alumno = await cuentaNueva(nucleo);
  const curso = cursoDePrueba(nucleo, { universidad: idUniversidad(nucleo, AUSTRAL), dueno: PROFE_AUSTRAL, alumnos: [alumno.email] });
  const ent = await alumno.cliente.post(`/api/cursos/${curso}/entregas`, { actividad: 'tp1', texto: 'antes' });
  expect(ent.status).toBe(201);
  const dueno = await sesionReautenticada(nucleo, PROFE_AUSTRAL);
  expect((await archivar(dueno, curso)).status).toBe(200);
  for (const ruta of [`/api/cursos/${curso}`, `/api/cursos/${curso}/entregas`, `/api/cursos/${curso}/notas`, `/api/cursos/${curso}/archivos`, `/api/cursos/${curso}/inscriptos`]) {
    const r = await alumno.cliente.get(ruta);
    expect(r.status, `${ruta}: ${r.texto}`).toBe(404);
    expect(r.texto).not.toContain('antes');
  }
  const e = await alumno.cliente.post(`/api/cursos/${curso}/entregas`, { actividad: 'tp2', texto: 'después' });
  expect([404, 409]).toContain(e.status);
  expect(fila(nucleo, 'SELECT COUNT(*) AS n FROM entregas WHERE curso_id = ?', curso).n).toBe(1);
  const mis = await alumno.cliente.get('/api/mis-cursos');
  expect(mis.json.cursos.map((c: any) => c.id)).not.toContain(curso);
  const otro = await sesion(nucleo, PROFE3_AUSTRAL);
  expect((await otro.get(`/api/cursos/${curso}`)).status).toBe(404);
});

test('un dueño suspendido, aun con la sesión revivida, no archiva ni desarchiva', async ({ nucleo }) => {
  const ana = await sesionReautenticada(nucleo, ADMIN_AUSTRAL);
  const profe = await cuentaNueva(nucleo, 'austral.edu.ar', 'prof');
  expect((await ana.put(`/api/admin/personas/${profe.id}/profesor`, { profesor: true })).status).toBe(200);
  const curso = cursoDePrueba(nucleo, { universidad: idUniversidad(nucleo, AUSTRAL), dueno: profe.email });
  await reautenticar(profe.cliente);
  expect((await suspender(ana, profe.id)).status).toBe(200);
  revivirSesiones(nucleo, profe.email);
  ejecutarSql(nucleo, "UPDATE sesiones SET reautenticada_en = ? WHERE usuario_id = ?", new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), profe.id);
  expect((await archivar(profe.cliente, curso)).status).toBe(401);
  expect(fila(nucleo, 'SELECT archivado_en FROM cursos WHERE id = ?', curso).archivado_en).toBeNull();
});

test('la historia de inscripciones es de solo agregado', async ({ nucleo }) => {
  const ana = await sesionReautenticada(nucleo, ADMIN_AUSTRAL);
  const alumno = await cuentaNueva(nucleo);
  cursoDePrueba(nucleo, { universidad: idUniversidad(nucleo, AUSTRAL), dueno: PROFE_AUSTRAL, alumnos: [alumno.email] });
  expect((await darDeBaja(ana, alumno.id)).status).toBe(200);
  const antes = nucleo.consultar('SELECT * FROM inscripciones_historia WHERE usuario_id = ?', alumno.id);
  expect(antes).toHaveLength(1);
  expect(() => ejecutarSql(nucleo, "UPDATE inscripciones_historia SET motivo = 'desinscripcion' WHERE usuario_id = ?", alumno.id)).toThrow();
  expect(() => ejecutarSql(nucleo, 'DELETE FROM inscripciones_historia WHERE usuario_id = ?', alumno.id)).toThrow();
  expect(nucleo.consultar('SELECT * FROM inscripciones_historia WHERE usuario_id = ?', alumno.id)).toEqual(antes);
  for (const metodo of ['DELETE', 'PUT', 'PATCH']) {
    const r = await ana.pedir(metodo, `/api/admin/personas/${alumno.id}`, metodo === 'DELETE' ? undefined : {});
    expect([404, 405]).toContain(r.status);
  }
  const owner = await sesionReautenticada(nucleo, OWNER);
  for (const ruta of [`/api/owner/universidades/${idUniversidad(nucleo, AUSTRAL)}`, '/api/cursos/redes', `/api/admin/cursos/redes`]) {
    const r = await owner.delete(ruta);
    expect([403, 404, 405]).toContain(r.status);
  }
  expect(fila(nucleo, 'SELECT COUNT(*) AS n FROM usuarios WHERE id = ?', alumno.id).n).toBe(1);
  expect(fila(nucleo, "SELECT COUNT(*) AS n FROM cursos WHERE id = 'redes'").n).toBe(1);
});
