import { crearTestTramo, expect, ADMIN_AUSTRAL, OWNER, PROFE_AUSTRAL, PROFE2_AUSTRAL } from '../fixtures.ts';
import { Cliente } from '../../comun/http.ts';
import { entrar, pedirCodigo } from '../../comun/sesion.ts';
import {
  AUSTRAL,
  auditoria,
  cuentaNueva,
  cursoDePrueba,
  darDeBaja,
  estadoCuenta,
  fila,
  idUniversidad,
  idUsuario,
  paginaCurso,
  profesorNuevo,
  reactivar,
  sesionReautenticada,
  suspender,
  tokenPersonal,
  ultimaAuditoria,
} from '../lib.ts';
import { reautenticar } from '../../comun/sesion.ts';

const test = crearTestTramo();

test.describe('suspender y reactivar una cuenta', () => {
  test('la persona suspendida no entra ni ve cursos; la reactivada sí', async ({ nucleo }) => {
    const admin = await sesionReautenticada(nucleo, ADMIN_AUSTRAL);
    const alumno = await cuentaNueva(nucleo);
    const curso = cursoDePrueba(nucleo, { universidad: idUniversidad(nucleo, AUSTRAL), dueno: PROFE_AUSTRAL, alumnos: [alumno.email] });
    await reautenticar(alumno.cliente);
    const token = await tokenPersonal(alumno.cliente, ['cursos:leer']);
    const otraSesion = new Cliente(nucleo);
    await entrar(otraSesion, alumno.email);

    const antes = await alumno.cliente.get('/api/mis-cursos');
    expect(antes.status).toBe(200);
    expect(antes.json.cursos.map((c: any) => c.id)).toContain(curso);
    expect((await paginaCurso(alumno.cliente, curso)).status).toBe(200);

    const r = await suspender(admin, alumno.id);
    expect(r.status, r.texto).toBe(200);
    expect(r.json.id).toBe(alumno.id);
    expect(r.json.estado).toBe('suspendida');
    expect(r.json.baja).toBe(false);
    expect(estadoCuenta(nucleo, alumno.id).suspendida_en).toBeTruthy();

    expect((await alumno.cliente.get('/api/yo')).status).toBe(401);
    expect((await otraSesion.get('/api/mis-cursos')).status).toBe(401);
    expect((await alumno.cliente.get('/api/mis-cursos', { bearer: token, sinCookies: true })).status).toBe(401);
    const pagina = await paginaCurso(alumno.cliente, curso);
    expect([401, 403]).toContain(pagina.status);
    expect(pagina.texto).not.toContain(`Curso de prueba ${curso}`);
    expect(fila(nucleo, 'SELECT COUNT(*) AS n FROM sesiones WHERE usuario_id = ? AND revocada = 0', alumno.id).n).toBe(0);
    expect(fila(nucleo, 'SELECT COUNT(*) AS n FROM tokens_api WHERE usuario_id = ? AND revocado = 0', alumno.id).n).toBe(0);

    const desde = nucleo.cantidadMails();
    expect((await pedirCodigo(new Cliente(nucleo), alumno.email)).status).toBe(200);
    await new Promise((res) => setTimeout(res, 500));
    expect(nucleo.mails().slice(desde).filter((m) => m.para === alumno.email)).toHaveLength(0);

    const r2 = await reactivar(admin, alumno.id);
    expect(r2.status, r2.texto).toBe(200);
    expect(r2.json.estado).toBe('activa');
    expect(estadoCuenta(nucleo, alumno.id).suspendida_en).toBeNull();

    const vuelta = new Cliente(nucleo);
    await entrar(vuelta, alumno.email);
    const despues = await vuelta.get('/api/mis-cursos');
    expect(despues.status).toBe(200);
    expect(despues.json.cursos.map((c: any) => c.id)).toContain(curso);
    expect((await paginaCurso(vuelta, curso)).status).toBe(200);
    expect((await vuelta.get('/api/mis-cursos', { bearer: token, sinCookies: true })).status).toBe(401);
    expect((await alumno.cliente.get('/api/yo')).status).toBe(401);
  });

  test('suspender y reactivar son idempotentes y quedan en la auditoría', async ({ nucleo }) => {
    const admin = await sesionReautenticada(nucleo, ADMIN_AUSTRAL);
    const persona = await cuentaNueva(nucleo);
    expect((await suspender(admin, persona.id)).status).toBe(200);
    const primera = estadoCuenta(nucleo, persona.id).suspendida_en;
    await new Promise((res) => setTimeout(res, 1100));
    expect((await suspender(admin, persona.id)).status).toBe(200);
    expect(estadoCuenta(nucleo, persona.id).suspendida_en).toBe(primera);
    expect((await reactivar(admin, persona.id)).status).toBe(200);
    expect((await reactivar(admin, persona.id)).status).toBe(200);

    const s = ultimaAuditoria(nucleo, 'cuenta_suspendida', persona.email);
    expect(s, 'auditoría cuenta_suspendida con el mail').toBeTruthy();
    expect(Number(s.universidad_id)).toBe(idUniversidad(nucleo, AUSTRAL));
    expect(Number(s.actor_id)).toBe(idUsuario(nucleo, ADMIN_AUSTRAL));
    expect(ultimaAuditoria(nucleo, 'cuenta_reactivada', persona.email)).toBeTruthy();
    const eventos = await admin.get('/api/admin/auditoria?limite=50');
    expect(eventos.json.eventos.some((e: any) => e.accion === 'cuenta_suspendida' && e.detalle.includes(persona.email))).toBe(true);
  });

  test('estado en Personas y filtro por estado', async ({ nucleo }) => {
    const admin = await sesionReautenticada(nucleo, ADMIN_AUSTRAL);
    const activa = await cuentaNueva(nucleo);
    const suspendida = await cuentaNueva(nucleo);
    expect((await suspender(admin, suspendida.id)).status).toBe(200);

    const todas = await admin.get('/api/admin/personas');
    expect(todas.status).toBe(200);
    const porId = new Map(todas.json.personas.map((p: any) => [p.id, p]));
    expect((porId.get(activa.id) as any).estado).toBe('activa');
    expect((porId.get(suspendida.id) as any).estado).toBe('suspendida');
    const pendiente = todas.json.personas.find((p: any) => p.email === 'cpendiente@austral.edu.ar');
    expect(pendiente.estado).toBe('pendiente');
    for (const p of todas.json.personas) expect(typeof p.baja).toBe('boolean');

    const susp = await admin.get('/api/admin/personas?estado=suspendidas');
    expect(susp.status).toBe(200);
    const ids = susp.json.personas.map((p: any) => p.id);
    expect(ids).toContain(suspendida.id);
    expect(ids).not.toContain(activa.id);
    for (const p of susp.json.personas) expect(p.estado).toBe('suspendida');

    const act = await admin.get('/api/admin/personas?estado=activas');
    expect(act.json.personas.map((p: any) => p.id)).toContain(activa.id);
    for (const p of act.json.personas) expect(p.estado).toBe('activa');

    const pend = await admin.get('/api/admin/personas?estado=pendientes');
    expect(pend.json.personas.map((p: any) => p.email)).toContain('cpendiente@austral.edu.ar');
    for (const p of pend.json.personas) expect(p.estado).toBe('pendiente');

    const combinado = await admin.get(`/api/admin/personas?estado=suspendidas&buscar=${encodeURIComponent(suspendida.email)}`);
    expect(combinado.json.personas.map((p: any) => p.id)).toEqual([suspendida.id]);

    expect((await admin.get('/api/admin/personas?estado=borradas')).status).toBe(400);
  });

  test('la persona suspendida deja de contar como inscripta activa', async ({ nucleo }) => {
    const admin = await sesionReautenticada(nucleo, ADMIN_AUSTRAL);
    const dueno = await sesionReautenticada(nucleo, PROFE_AUSTRAL);
    const alumno = await cuentaNueva(nucleo);
    const otro = await cuentaNueva(nucleo);
    const curso = cursoDePrueba(nucleo, { universidad: idUniversidad(nucleo, AUSTRAL), dueno: PROFE_AUSTRAL, alumnos: [alumno.email, otro.email] });

    const antes = await dueno.get(`/api/cursos/${curso}/inscriptos`);
    expect(antes.status).toBe(200);
    expect(antes.json.alumnos).toBe(2);
    expect(antes.json.inscriptos.every((i: any) => i.suspendida === false)).toBe(true);
    const cursosAntes = await admin.get('/api/admin/cursos');
    expect(cursosAntes.json.cursos.find((c: any) => c.id === curso).alumnos).toBe(2);

    expect((await suspender(admin, alumno.id)).status).toBe(200);
    const despues = await dueno.get(`/api/cursos/${curso}/inscriptos`);
    expect(despues.json.alumnos).toBe(1);
    const fila = despues.json.inscriptos.find((i: any) => i.id === alumno.id);
    expect(fila, 'la persona suspendida sigue en la lista').toBeTruthy();
    expect(fila.suspendida).toBe(true);
    const cursosDespues = await admin.get('/api/admin/cursos');
    expect(cursosDespues.json.cursos.find((c: any) => c.id === curso).alumnos).toBe(1);

    expect((await reactivar(admin, alumno.id)).status).toBe(200);
    const vuelta = await dueno.get(`/api/cursos/${curso}/inscriptos`);
    expect(vuelta.json.alumnos).toBe(2);
  });
});

test.describe('dar de baja de la universidad', () => {
  test('suspende la cuenta y quita sus inscripciones, que quedan en la historia', async ({ nucleo }) => {
    const admin = await sesionReautenticada(nucleo, ADMIN_AUSTRAL);
    const uni = idUniversidad(nucleo, AUSTRAL);
    const alumno = await cuentaNueva(nucleo);
    const c1 = cursoDePrueba(nucleo, { universidad: uni, dueno: PROFE_AUSTRAL, alumnos: [alumno.email] });
    const c2 = cursoDePrueba(nucleo, { universidad: uni, dueno: PROFE2_AUSTRAL, alumnos: [alumno.email] });

    const sinConfirmar = await darDeBaja(admin, alumno.id, 'admin', {});
    expect(sinConfirmar.status).toBe(400);
    expect(sinConfirmar.json.error).toBe('datos_invalidos');
    expect(estadoCuenta(nucleo, alumno.id).suspendida_en).toBeNull();
    expect(fila(nucleo, 'SELECT COUNT(*) AS n FROM inscripciones WHERE usuario_id = ?', alumno.id).n).toBe(2);

    const r = await darDeBaja(admin, alumno.id);
    expect(r.status, r.texto).toBe(200);
    expect(r.json.estado).toBe('suspendida');
    expect(r.json.baja).toBe(true);
    const estado = estadoCuenta(nucleo, alumno.id);
    expect(estado.suspendida_en).toBeTruthy();
    expect(estado.baja_en).toBeTruthy();
    expect(fila(nucleo, 'SELECT COUNT(*) AS n FROM inscripciones WHERE usuario_id = ?', alumno.id).n).toBe(0);
    const historia = nucleo.consultar('SELECT * FROM inscripciones_historia WHERE usuario_id = ? ORDER BY curso_id', alumno.id);
    expect(historia.map((h: any) => h.curso_id).sort()).toEqual([c1, c2].sort());
    for (const h of historia) {
      expect(h.rol).toBe('alumno');
      expect(h.motivo).toBe('baja');
    }
    expect(fila(nucleo, 'SELECT COUNT(*) AS n FROM usuarios WHERE id = ?', alumno.id).n).toBe(1);
    expect((await alumno.cliente.get('/api/yo')).status).toBe(401);
    expect(ultimaAuditoria(nucleo, 'baja_universidad', alumno.email)).toBeTruthy();

    const persona = (await admin.get('/api/admin/personas?estado=suspendidas')).json.personas.find((p: any) => p.id === alumno.id);
    expect(persona.baja).toBe(true);

    expect((await reactivar(admin, alumno.id)).status).toBe(200);
    expect(estadoCuenta(nucleo, alumno.id).baja_en).toBeNull();
    const vuelta = new Cliente(nucleo);
    await entrar(vuelta, alumno.email);
    const mis = await vuelta.get('/api/mis-cursos');
    expect(mis.json.cursos.map((c: any) => c.id)).not.toContain(c1);
    expect(fila(nucleo, 'SELECT COUNT(*) AS n FROM inscripciones_historia WHERE usuario_id = ?', alumno.id).n).toBe(2);
  });

  test('no se puede dar de baja a la dueña de un curso hasta transferirlo', async ({ nucleo }) => {
    const admin = await sesionReautenticada(nucleo, ADMIN_AUSTRAL);
    const profe = await profesorNuevo(nucleo, admin);
    const curso = cursoDePrueba(nucleo, { universidad: idUniversidad(nucleo, AUSTRAL), dueno: profe.email });
    const r = await darDeBaja(admin, profe.id);
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('es_dueno');
    expect(r.json.cursos).toContain(curso);
    expect(estadoCuenta(nucleo, profe.id).suspendida_en).toBeNull();
    expect(fila(nucleo, 'SELECT COUNT(*) AS n FROM inscripciones WHERE usuario_id = ?', profe.id).n).toBe(1);
    expect((await profe.cliente.get('/api/yo')).status).toBe(200);
  });
});

test.describe('owner y dueños suspendidos', () => {
  test('el owner suspende y reactiva a un administrador', async ({ nucleo }) => {
    const owner = await sesionReautenticada(nucleo, OWNER);
    const uni = idUniversidad(nucleo, AUSTRAL);
    const email = `adm${Date.now().toString(36)}@austral.edu.ar`;
    const inv = await owner.post(`/api/owner/universidades/${uni}/administradores`, { email });
    expect([200, 201]).toContain(inv.status);
    const adm = new Cliente(nucleo);
    await entrar(adm, email);
    const id = idUsuario(nucleo, email);

    const r = await suspender(owner, id, 'owner');
    expect(r.status, r.texto).toBe(200);
    expect(r.json.estado).toBe('suspendida');
    expect((await adm.get('/api/admin/personas')).status).toBe(401);
    expect(ultimaAuditoria(nucleo, 'cuenta_suspendida', email)).toBeTruthy();

    expect((await reactivar(owner, id, 'owner')).status).toBe(200);
    const vuelta = new Cliente(nucleo);
    await entrar(vuelta, email);
    expect((await vuelta.get('/api/admin/personas')).status).toBe(200);
  });

  test('el curso de una dueña suspendida sigue funcionando y el administrador lo transfiere', async ({ nucleo }) => {
    const admin = await sesionReautenticada(nucleo, ADMIN_AUSTRAL);
    const uni = idUniversidad(nucleo, AUSTRAL);
    const profe = await profesorNuevo(nucleo, admin);
    const alumno = await cuentaNueva(nucleo);
    const curso = cursoDePrueba(nucleo, { universidad: uni, dueno: profe.email, alumnos: [alumno.email] });

    expect((await suspender(admin, profe.id)).status).toBe(200);
    expect((await paginaCurso(alumno.cliente, curso)).status).toBe(200);
    const listado = await admin.get('/api/admin/cursos');
    expect(listado.json.cursos.some((c: any) => c.id === curso)).toBe(true);

    const nuevo = idUsuario(nucleo, PROFE2_AUSTRAL);
    const t = await admin.post(`/api/admin/cursos/${curso}/transferir`, { usuario_id: nuevo });
    expect(t.status, t.texto).toBe(200);
    expect(t.json.dueno.id).toBe(nuevo);
    expect(t.json.dueno.email).toBe(PROFE2_AUSTRAL);
    const roles = Object.fromEntries(
      nucleo.consultar('SELECT usuario_id, rol FROM inscripciones WHERE curso_id = ?', curso).map((f: any) => [Number(f.usuario_id), f.rol]),
    );
    expect(roles[nuevo]).toBe('dueño');
    expect(roles[profe.id]).toBe('profesor');
    expect(roles[alumno.id]).toBe('alumno');
    expect(auditoria(nucleo, 'curso_transferido').some((e: any) => String(e.detalle).includes(curso))).toBe(true);

    const nuevoDueno = await sesionReautenticada(nucleo, PROFE2_AUSTRAL);
    const ins = await nuevoDueno.get(`/api/cursos/${curso}/inscriptos`);
    expect(ins.status).toBe(200);
    expect(ins.json.inscriptos[0].id).toBe(nuevo);
    expect(ins.json.inscriptos[0].rol).toBe('dueño');
    expect((await paginaCurso(alumno.cliente, curso)).status).toBe(200);
  });
});
