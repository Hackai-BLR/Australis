import { crearTestTramo, expect, OWNER, OWNER_AUSTRAL } from '../fixtures.ts';
import { Cliente } from '../../comun/http.ts';
import type { Nucleo } from '../../comun/nucleo.ts';
import { aleatorio, entrar, esperar, pedirCodigo } from '../../comun/sesion.ts';
import {
  cuentaNueva,
  cursoDePrueba,
  deshabilitar,
  ejecutarSql,
  esperarOk,
  estadoCuenta,
  fila,
  idUsuario,
  rehabilitar,
  sesion,
  sesionReautenticada,
  tokenPersonal,
  ultimaAuditoria,
  universidadNueva,
} from '../lib.ts';

const test = crearTestTramo();

function esAdministrador(nucleo: Nucleo, id: number) {
  return Number(fila(nucleo, 'SELECT administrador FROM usuarios WHERE id = ?', id).administrador);
}

function esOwner(nucleo: Nucleo, id: number) {
  return Number(fila(nucleo, 'SELECT owner FROM usuarios WHERE id = ?', id).owner);
}

async function sinOtrosOwners<T>(nucleo: Nucleo, conservar: number, f: () => Promise<T>): Promise<T> {
  const otros = nucleo.consultar('SELECT id FROM usuarios WHERE owner = 1 AND id <> ?', conservar).map((x: any) => Number(x.id));
  for (const id of otros) ejecutarSql(nucleo, 'UPDATE usuarios SET owner = 0 WHERE id = ?', id);
  try {
    return await f();
  } finally {
    for (const id of otros) ejecutarSql(nucleo, 'UPDATE usuarios SET owner = 1 WHERE id = ?', id);
  }
}

test.describe('quitar administradores', () => {
  test('el owner quita un administrador: deja de serlo, se revocan sus sesiones y queda en la auditoría', async ({ nucleo }) => {
    const owner = await sesionReautenticada(nucleo, OWNER);
    const uni = await universidadNueva(owner);
    const segundo = `admin2@${uni.dominio}`;
    esperarOk(await owner.post(`/api/owner/universidades/${uni.id}/administradores`, { email: segundo }), 'invitar segundo administrador', 201);
    const admin = await sesionReautenticada(nucleo, uni.admin);
    const token = await tokenPersonal(admin, ['admin:leer']);
    const copia = admin.clonarSesion();
    expect((await admin.get('/api/admin/personas')).status).toBe(200);
    const idAdmin = idUsuario(nucleo, uni.admin);

    const r = await owner.delete(`/api/owner/universidades/${uni.id}/administradores/${idAdmin}`);
    esperarOk(r, 'quitar administrador');
    expect(r.json.id).toBe(uni.id);
    expect(r.json.administradores.map((a: any) => a.email)).toEqual([segundo]);
    expect(esAdministrador(nucleo, idAdmin)).toBe(0);
    expect(estadoCuenta(nucleo, idAdmin).suspendida_en).toBeNull();

    for (const c of [admin, copia]) expect((await c.get('/api/admin/personas')).status).toBe(401);
    expect((await admin.get('/api/admin/personas', { bearer: token, sinCookies: true })).status).toBe(401);

    const otra = await sesion(nucleo, uni.admin);
    const yo = await otra.get('/api/yo');
    expect(yo.status).toBe(200);
    expect(yo.json.usuario.administrador).toBe(false);
    expect((await otra.get('/api/admin/personas')).status).toBe(403);

    const ev = ultimaAuditoria(nucleo, 'administrador_quitado', uni.admin);
    expect(ev).toBeTruthy();
    expect(Number(ev.universidad_id)).toBe(uni.id);
    expect(Number(ev.actor_id)).toBe(idUsuario(nucleo, OWNER));
  });

  test('no se puede quitar al último administrador de una universidad activa, sí si está deshabilitada', async ({ nucleo }) => {
    const owner = await sesionReautenticada(nucleo, OWNER);
    const uni = await universidadNueva(owner);
    const idAdmin = idUsuario(nucleo, uni.admin);
    const r = await owner.delete(`/api/owner/universidades/${uni.id}/administradores/${idAdmin}`);
    expect(r.status, r.texto).toBe(409);
    expect(r.json.error).toBe('ultimo_administrador');
    expect(esAdministrador(nucleo, idAdmin)).toBe(1);

    esperarOk(await deshabilitar(owner, uni.id), 'deshabilitar');
    esperarOk(await owner.delete(`/api/owner/universidades/${uni.id}/administradores/${idAdmin}`), 'quitar con la universidad deshabilitada');
    expect(esAdministrador(nucleo, idAdmin)).toBe(0);
    esperarOk(await rehabilitar(owner, uni.id), 'rehabilitar');
  });
});

test.describe('poner y quitar owners', () => {
  test('el owner da el rol a un mail nuevo y a una cuenta existente, y lo quita revocando sus sesiones', async ({ nucleo }) => {
    const owner = await sesionReautenticada(nucleo, OWNER);
    const email = `${aleatorio('o')}@equipo.campusia.prueba`;
    const desde = nucleo.cantidadMails();
    const r = await owner.post('/api/owner/owners', { email });
    esperarOk(r, 'invitar owner', 201);
    expect(r.json).toMatchObject({ email, pendiente: true });
    expect(nucleo.mails().slice(desde).some((m) => m.para === email)).toBe(true);

    const nuevo = await sesionReautenticada(nucleo, email);
    expect((await nuevo.get('/api/yo')).json.usuario.owner).toBe(true);
    expect((await nuevo.get('/api/owner/universidades')).status).toBe(200);
    const token = await tokenPersonal(nuevo, ['owner:leer']);

    const lista = await owner.get('/api/owner/owners');
    esperarOk(lista, 'listar owners');
    expect(lista.json.owners.map((o: any) => o.email)).toEqual(expect.arrayContaining([OWNER, email]));

    const comun = await cuentaNueva(nucleo);
    const e = await owner.post('/api/owner/owners', { email: comun.email });
    esperarOk(e, 'dar el rol a una cuenta existente');
    expect(esOwner(nucleo, comun.id)).toBe(1);
    expect(ultimaAuditoria(nucleo, 'owner_agregado', comun.email)).toBeTruthy();

    const idNuevo = idUsuario(nucleo, email);
    const q = await owner.delete(`/api/owner/owners/${idNuevo}`);
    esperarOk(q, 'quitar owner');
    expect(q.json.owners.map((o: any) => o.email)).not.toContain(email);
    expect(esOwner(nucleo, idNuevo)).toBe(0);
    expect((await nuevo.get('/api/owner/universidades')).status).toBe(401);
    expect((await nuevo.get('/api/owner/universidades', { bearer: token, sinCookies: true })).status).toBe(401);
    expect(ultimaAuditoria(nucleo, 'owner_quitado', email)).toBeTruthy();

    esperarOk(await owner.delete(`/api/owner/owners/${comun.id}`), 'quitar owner a la cuenta existente');
    expect(esOwner(nucleo, comun.id)).toBe(0);
  });

  test('no se puede quitar al último owner, ni por la API ni por la línea de comandos', async ({ nucleo }) => {
    const owner = await sesionReautenticada(nucleo, OWNER);
    const id = idUsuario(nucleo, OWNER);
    await sinOtrosOwners(nucleo, id, async () => {
      const r = await owner.delete(`/api/owner/owners/${id}`);
      expect(r.status, r.texto).toBe(409);
      expect(r.json.error).toBe('ultimo_owner');
      expect(esOwner(nucleo, id)).toBe(1);
      const cli = nucleo.ejecutar(['quitar-owner', OWNER]);
      expect(cli.status).not.toBe(0);
      expect(esOwner(nucleo, id)).toBe(1);
      expect((await owner.get('/api/owner/owners')).status).toBe(200);
    });
  });

  test('un owner se puede quitar a sí mismo si no es el último', async ({ nucleo }) => {
    const owner = await sesionReautenticada(nucleo, OWNER);
    const email = `${aleatorio('o')}@equipo.campusia.prueba`;
    esperarOk(await owner.post('/api/owner/owners', { email }), 'invitar owner', 201);
    const otro = await sesionReautenticada(nucleo, email);
    const id = idUsuario(nucleo, email);
    esperarOk(await otro.delete(`/api/owner/owners/${id}`), 'quitarse a sí mismo');
    expect(esOwner(nucleo, id)).toBe(0);
    expect((await otro.get('/api/yo')).status).toBe(401);
  });

  test('crear-owner levanta la suspensión de un owner y quitar-owner le saca el rol', async ({ nucleo }) => {
    const owner = await sesionReautenticada(nucleo, OWNER);
    const email = `${aleatorio('o')}@equipo.campusia.prueba`;
    esperarOk(await owner.post('/api/owner/owners', { email }), 'invitar owner', 201);
    const otro = await sesion(nucleo, email);
    const id = idUsuario(nucleo, email);
    esperarOk(await owner.post(`/api/owner/personas/${id}/suspender`, {}), 'suspender owner');
    expect((await otro.get('/api/yo')).status).toBe(401);
    const desde = nucleo.cantidadMails();
    esperarOk(await pedirCodigo(new Cliente(nucleo), email), 'pedir código suspendido');
    await esperar(300);
    expect(nucleo.mails().slice(desde).filter((m) => m.para === email)).toHaveLength(0);

    const cli = nucleo.ejecutar(['crear-owner', email]);
    expect(cli.status, cli.stderr).toBe(0);
    expect(estadoCuenta(nucleo, id).suspendida_en).toBeNull();
    const vuelta = new Cliente(nucleo);
    await entrar(vuelta, email);
    expect((await vuelta.get('/api/owner/universidades')).status).toBe(200);

    const quitar = nucleo.ejecutar(['quitar-owner', email]);
    expect(quitar.status, quitar.stderr).toBe(0);
    expect(esOwner(nucleo, id)).toBe(0);
    expect((await vuelta.get('/api/yo')).status).toBe(401);
    expect(nucleo.ejecutar(['quitar-owner', `${aleatorio('nadie')}@equipo.campusia.prueba`]).status).not.toBe(0);
    expect(auditoriaCli(nucleo, email)).toBeTruthy();
  });
});

function auditoriaCli(nucleo: Nucleo, email: string) {
  return fila(nucleo, "SELECT * FROM auditoria WHERE accion = 'owner_quitado' AND actor_id IS NULL AND detalle LIKE ?", `%${email}%`);
}

test.describe('el owner administra cualquier universidad', () => {
  test('administra dos universidades distintas desde la misma sesión', async ({ nucleo }) => {
    const owner = await sesionReautenticada(nucleo, OWNER);
    const idOwner = idUsuario(nucleo, OWNER);
    const a = await universidadNueva(owner);
    const b = await universidadNueva(owner);
    const pa = await cuentaNueva(nucleo, a.dominio);
    const pb = await cuentaNueva(nucleo, b.dominio);
    const qa = `?universidad=${a.id}`;
    const qb = `?universidad=${b.id}`;

    expect((await owner.get('/api/admin/personas')).status).toBe(403);
    const ua = await owner.get(`/api/admin/universidad${qa}`);
    esperarOk(ua, 'ver universidad A');
    expect(ua.json.nombre).toBe(a.nombre);
    expect((await owner.get(`/api/admin/universidad${qb}`)).json.nombre).toBe(b.nombre);

    const la = await owner.get(`/api/admin/personas${qa}`);
    esperarOk(la, 'personas de A');
    expect(la.json.personas.map((p: any) => p.id)).toContain(pa.id);
    expect(la.json.personas.map((p: any) => p.id)).not.toContain(pb.id);
    const lb = await owner.get(`/api/admin/personas?filtro=todos&universidad=${b.id}`);
    expect(lb.json.personas.map((p: any) => p.id)).toContain(pb.id);
    expect(lb.json.personas.map((p: any) => p.id)).not.toContain(pa.id);

    esperarOk(await owner.put(`/api/admin/personas/${pa.id}/profesor${qa}`, { profesor: true }), 'marcar profesor en A');
    expect((await owner.put(`/api/admin/personas/${pa.id}/profesor${qb}`, { profesor: false })).status).toBe(404);
    expect(Number(fila(nucleo, 'SELECT profesor FROM usuarios WHERE id = ?', pa.id).profesor)).toBe(1);

    esperarOk(await owner.post(`/api/admin/invitaciones${qb}`, { email: `prof@${b.dominio}`, tipo: 'profesor' }), 'invitar en B', 201);
    esperarOk(await owner.post(`/api/admin/dominios${qa}`, { dominio: `alumnos.${a.dominio}` }), 'dominio en A', 201);
    const cb = await owner.put(`/api/admin/cupos/predeterminado${qb}`, { tokens: 33 });
    esperarOk(cb, 'cupo predeterminado en B');
    expect(Number(cb.json.universidad.id)).toBe(b.id);
    expect(cb.json.predeterminado).toBe(33);
    expect((await owner.get(`/api/admin/cupos${qa}`)).json.predeterminado).not.toBe(33);

    esperarOk(await owner.post(`/api/admin/personas/${pb.id}/suspender${qb}`, {}), 'suspender en B');
    expect((await owner.post(`/api/admin/personas/${pa.id}/suspender${qb}`, {})).status).toBe(404);
    expect(estadoCuenta(nucleo, pa.id).suspendida_en).toBeNull();
    const ev = ultimaAuditoria(nucleo, 'cuenta_suspendida', pb.email);
    expect(Number(ev.universidad_id)).toBe(b.id);
    expect(Number(ev.actor_id)).toBe(idOwner);

    const idAdminA = idUsuario(nucleo, a.admin);
    esperarOk(await owner.post(`/api/admin/personas/${idAdminA}/suspender${qa}`, {}), 'suspender al administrador de A');
    esperarOk(await owner.post(`/api/admin/personas/${idAdminA}/reactivar${qa}`, {}), 'reactivar al administrador de A');

    const curso = cursoDePrueba(nucleo, { universidad: a.id, dueno: pa.email });
    const cursos = await owner.get(`/api/admin/cursos${qa}`);
    expect(cursos.json.cursos.map((c: any) => c.id)).toContain(curso);
    expect((await owner.get(`/api/admin/cursos${qb}`)).json.cursos.map((c: any) => c.id)).not.toContain(curso);
    expect((await owner.post(`/api/admin/cursos/${curso}/archivar${qb}`, {})).status).toBe(404);
    esperarOk(await owner.post(`/api/admin/cursos/${curso}/archivar${qa}`, {}), 'archivar en A');
    esperarOk(await owner.post(`/api/admin/cursos/${curso}/desarchivar${qa}`, {}), 'desarchivar en A');

    const act = await owner.get(`/api/admin/auditoria?limite=50&universidad=${a.id}`);
    esperarOk(act, 'actividad de A');
    const acciones = act.json.eventos.map((e: any) => e.accion);
    expect(acciones).toEqual(expect.arrayContaining(['curso_archivado', 'dominio_agregado', 'marca_profesor']));
    expect(act.json.eventos.find((e: any) => e.accion === 'curso_archivado').actor.email).toBe(OWNER);
    expect((await owner.get('/api/admin/universidad?universidad=999999')).status).toBe(404);
  });

  test('un owner que también es administrador sigue administrando la suya sin indicar universidad', async ({ nucleo }) => {
    const rectora = await sesionReautenticada(nucleo, OWNER_AUSTRAL);
    const id = idUsuario(nucleo, OWNER_AUSTRAL);
    const antes = Number(fila(nucleo, 'SELECT administrador FROM usuarios WHERE id = ?', id).administrador);
    ejecutarSql(nucleo, 'UPDATE usuarios SET administrador = 1 WHERE id = ?', id);
    try {
      expect((await rectora.get('/api/admin/personas')).status).toBe(200);
      const demo = Number(fila(nucleo, "SELECT id FROM universidades WHERE nombre = 'Universidad de Prueba'").id);
      const r = await rectora.get(`/api/admin/universidad?universidad=${demo}`);
      expect(r.json.nombre).toBe('Universidad de Prueba');
    } finally {
      ejecutarSql(nucleo, 'UPDATE usuarios SET administrador = ? WHERE id = ?', antes, id);
    }
  });
});
