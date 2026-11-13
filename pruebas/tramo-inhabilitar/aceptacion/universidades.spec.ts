import { crearTestTramo, expect, OWNER } from '../fixtures.ts';
import { Cliente } from '../../comun/http.ts';
import { entrar, pedirCodigo, reautenticar } from '../../comun/sesion.ts';
import {
  cuentaNueva,
  cursoDePrueba,
  deshabilitar,
  fila,
  idUsuario,
  mailNuevo,
  paginaCurso,
  rehabilitar,
  sesion,
  tokenPersonal,
  ultimaAuditoria,
  universidadNueva,
} from '../lib.ts';

const test = crearTestTramo();

test('deshabilitar una universidad corta el acceso de sus cuentas y rehabilitarla lo devuelve', async ({ nucleo }) => {
  const owner = await sesion(nucleo, OWNER);
  await reautenticar(owner);
  const uni = await universidadNueva(owner);
  const admin = await sesion(nucleo, uni.admin);
  await reautenticar(admin);
  const tokenAdmin = await tokenPersonal(admin, ['admin:leer']);
  const profe = await cuentaNueva(nucleo, uni.dominio, 'prof');
  const alumno = await cuentaNueva(nucleo, uni.dominio, 'al');
  const curso = cursoDePrueba(nucleo, { universidad: uni.id, dueno: profe.email, alumnos: [alumno.email] });
  expect((await paginaCurso(alumno.cliente, curso)).status).toBe(200);
  expect((await admin.get('/api/admin/personas', { bearer: tokenAdmin, sinCookies: true })).status).toBe(401);

  const r = await deshabilitar(owner, uni.id);
  expect(r.status, r.texto).toBe(200);
  expect(r.json.id).toBe(uni.id);
  expect(r.json.deshabilitada).toBe(true);
  expect(fila(nucleo, 'SELECT deshabilitada_en FROM universidades WHERE id = ?', uni.id).deshabilitada_en).toBeTruthy();
  const lista = await owner.get('/api/owner/universidades');
  expect(lista.json.universidades.find((u: any) => u.id === uni.id).deshabilitada).toBe(true);

  for (const c of [admin, profe.cliente, alumno.cliente]) expect((await c.get('/api/yo')).status).toBe(401);
  expect((await admin.get('/api/admin/personas', { bearer: tokenAdmin, sinCookies: true })).status).toBe(401);
  const pagina = await paginaCurso(alumno.cliente, curso);
  expect([401, 403]).toContain(pagina.status);
  expect(pagina.texto).not.toContain(`Curso de prueba ${curso}`);
  for (const email of [uni.admin, profe.email, alumno.email]) {
    expect(fila(nucleo, 'SELECT COUNT(*) AS n FROM sesiones WHERE usuario_id = ? AND revocada = 0', idUsuario(nucleo, email)).n).toBe(0);
  }

  const desde = nucleo.cantidadMails();
  const nuevo = mailNuevo(uni.dominio, 'nuevo');
  for (const email of [alumno.email, uni.admin, nuevo]) expect((await pedirCodigo(new Cliente(nucleo), email)).status).toBe(200);
  await new Promise((res) => setTimeout(res, 500));
  expect(nucleo.mails().slice(desde).filter((m) => [alumno.email, uni.admin, nuevo].includes(m.para))).toHaveLength(0);
  expect(fila(nucleo, 'SELECT COUNT(*) AS n FROM usuarios WHERE email = ?', nuevo).n).toBe(0);

  const inv = await owner.post(`/api/owner/universidades/${uni.id}/administradores`, { email: mailNuevo(uni.dominio, 'adm') });
  expect(inv.status).toBe(409);
  expect(inv.json.error).toBe('universidad_deshabilitada');

  expect(ultimaAuditoria(nucleo, 'universidad_deshabilitada', uni.nombre)).toBeTruthy();
  expect(Number(ultimaAuditoria(nucleo, 'universidad_deshabilitada', uni.nombre).universidad_id)).toBe(uni.id);

  const r2 = await rehabilitar(owner, uni.id);
  expect(r2.status, r2.texto).toBe(200);
  expect(r2.json.deshabilitada).toBe(false);
  expect(fila(nucleo, 'SELECT deshabilitada_en FROM universidades WHERE id = ?', uni.id).deshabilitada_en).toBeNull();
  expect(ultimaAuditoria(nucleo, 'universidad_rehabilitada', uni.nombre)).toBeTruthy();

  expect((await alumno.cliente.get('/api/yo')).status).toBe(401);
  const vuelta = new Cliente(nucleo);
  await entrar(vuelta, alumno.email);
  const mis = await vuelta.get('/api/mis-cursos');
  expect(mis.json.cursos.map((c: any) => c.id)).toContain(curso);
  expect((await paginaCurso(vuelta, curso)).status).toBe(200);
  expect((await admin.get('/api/admin/personas', { bearer: tokenAdmin, sinCookies: true })).status).toBe(401);

  const creada = new Cliente(nucleo);
  await entrar(creada, nuevo);
  expect(Number(fila(nucleo, 'SELECT universidad_id FROM usuarios WHERE email = ?', nuevo).universidad_id)).toBe(uni.id);
});

test('un owner de una universidad deshabilitada sigue entrando', async ({ nucleo }) => {
  const owner = await sesion(nucleo, OWNER);
  await reautenticar(owner);
  const uni = await universidadNueva(owner);
  const rector = await cuentaNueva(nucleo, uni.dominio, 'rector');
  const r = nucleo.ejecutar(['crear-owner', rector.email]);
  expect(r.status, r.stderr).toBe(0);

  expect((await deshabilitar(owner, uni.id)).status).toBe(200);
  const otra = new Cliente(nucleo);
  await entrar(otra, rector.email);
  const yo = await otra.get('/api/yo');
  expect(yo.status).toBe(200);
  expect(yo.json.usuario.owner).toBe(true);
  expect((await otra.get('/api/owner/universidades')).status).toBe(200);
  expect((await rehabilitar(owner, uni.id)).status).toBe(200);
});

test('deshabilitar y rehabilitar son idempotentes y responden 404 para una universidad inexistente', async ({ nucleo }) => {
  const owner = await sesion(nucleo, OWNER);
  await reautenticar(owner);
  const uni = await universidadNueva(owner);
  expect((await deshabilitar(owner, uni.id)).status).toBe(200);
  const antes = fila(nucleo, 'SELECT deshabilitada_en FROM universidades WHERE id = ?', uni.id).deshabilitada_en;
  await new Promise((res) => setTimeout(res, 1100));
  expect((await deshabilitar(owner, uni.id)).status).toBe(200);
  expect(fila(nucleo, 'SELECT deshabilitada_en FROM universidades WHERE id = ?', uni.id).deshabilitada_en).toBe(antes);
  expect((await rehabilitar(owner, uni.id)).status).toBe(200);
  expect((await rehabilitar(owner, uni.id)).status).toBe(200);
  expect((await deshabilitar(owner, 999999)).status).toBe(404);
  expect((await rehabilitar(owner, 999999)).status).toBe(404);
});
