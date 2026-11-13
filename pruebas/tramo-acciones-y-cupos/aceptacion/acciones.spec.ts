import fs from 'node:fs';
import path from 'node:path';
import { crearTestAcciones, expect, TIEMPO_FASE3, PROFE_AUSTRAL, PROFE2_AUSTRAL, PROFE3_AUSTRAL, ALUMNO_AUSTRAL, ALUMNA2_AUSTRAL } from '../fixtures.ts';
import { RAIZ_REPO } from '../../comun/entorno.ts';
import type { Cliente } from '../../comun/http.ts';
import { aleatorio } from '../../comun/sesion.ts';
import { inscribirOk, tokenDeCurso, apiDeCurso } from '../../fase-2/lib/cursos.ts';
import { ejecutarEn } from '../../fase-2/lib/docker.ts';
import { archivoEnRama, cursoConEspacio, entornoEspacio, nombreEspacio } from '../../fase-3/lib/agente.ts';
import { auditoriaDe, correrScript, idDe, inscriptosEnBase, ok, pedirInterna, resultado, rolEnCurso, sesionDe } from '../lib.ts';

const test = crearTestAcciones();
test.describe.configure({ mode: 'serial', timeout: TIEMPO_FASE3 });

let id = '';
let duena: Cliente;
let profe: Cliente;

const METODOS = ['listarInscriptos', 'inscribir', 'importarSiu', 'codigoInscripcion', 'generarCodigo', 'activarCodigo', 'pedirQuitar', 'pedirCambioDeRol', 'confirmaciones'];

test.describe('acciones del profesor a través del agente', () => {
  test.beforeAll(async ({ nucleo }) => {
    test.setTimeout(TIEMPO_FASE3);
    duena = await sesionDe(nucleo, PROFE_AUSTRAL);
    profe = await sesionDe(nucleo, PROFE2_AUSTRAL);
    id = await cursoConEspacio(duena, { nombre: 'Curso con Acciones' });
    await inscribirOk(duena, id, [PROFE2_AUSTRAL], 'profesor');
  });

  test('el profesor le pide al agente inscribir alumnos de un listado y quedan inscriptos', async ({ nucleo }) => {
    const nuevos = [`${aleatorio('al.')}@mail.austral.edu.ar`, `${aleatorio('al.')}@mail.austral.edu.ar`];
    const lista = [...nuevos, ALUMNO_AUSTRAL];
    const res = await correrScript(nucleo, duena, id, `await intentar('inscribir', () => c.inscribir(${JSON.stringify(lista)}));\nawait intentar('lista', () => c.listarInscriptos());`, {
      pedido: `Inscribí a estos alumnos: ${lista.join(', ')}`,
    });
    expect(res.respuesta.estado).toBe('ok');
    const ins = resultado(res, 'inscribir');
    expect(ins.ok, JSON.stringify(ins)).toBe(true);
    expect([...ins.valor.agregados].sort()).toEqual([...lista].sort());
    expect([...ins.valor.creados].sort()).toEqual([...nuevos].sort());
    expect(ins.valor.ya_estaban).toEqual([]);

    const enBase = inscriptosEnBase(nucleo, id);
    for (const e of lista) expect(enBase.find((x) => x.email === e)?.rol, e).toBe('alumno');
    for (const e of nuevos) expect(Number(enBase.find((x) => x.email === e)?.pendiente)).toBe(1);

    const web = ok(await duena.get(`/api/cursos/${id}/inscriptos`), 'inscriptos');
    for (const e of lista) expect(web.inscriptos.map((x: any) => x.email)).toContain(e);

    const listado = resultado(res, 'lista');
    expect(listado.ok).toBe(true);
    expect(listado.valor.alumnos).toBe(web.alumnos);
    expect(listado.valor.profesores).toBe(web.profesores);
    expect(listado.valor.inscriptos.map((x: any) => x.email)).toEqual(web.inscriptos.map((x: any) => x.email));
    for (const x of listado.valor.inscriptos) expect(typeof x.id).toBe('string');

    const duenaId = idDe(nucleo, PROFE_AUSTRAL);
    for (const e of lista) {
      const ev = auditoriaDe(nucleo, 'inscripcion', e).pop();
      expect(ev, `auditoría de ${e}`).toBeTruthy();
      expect(Number(ev.actor_id)).toBe(duenaId);
      expect(Number(ev.agente)).toBe(1);
      expect(String(ev.detalle)).toContain('pedido por el agente');
      expect(String(ev.detalle)).toContain(id);
    }
  });

  test('importa el listado del SIU que arma el agente', async ({ nucleo }) => {
    const juana = `${aleatorio('jperez.')}@mail.austral.edu.ar`;
    const csv = `Apellido y nombre;Correo electrónico\nPérez, Juana;${juana}\nSin Mail;no-es-un-mail\n`;
    const res = await correrScript(
      nucleo,
      duena,
      id,
      `await intentar('siu', () => c.importarSiu('listado.csv', new TextEncoder().encode(${JSON.stringify(csv)})));`,
      { pedido: 'Importá el listado del SIU' },
    );
    const siu = resultado(res, 'siu');
    expect(siu.ok, JSON.stringify(siu)).toBe(true);
    expect(siu.valor.agregados).toEqual([juana]);
    expect(siu.valor.rechazados).toEqual([{ fila: 3, email: 'no-es-un-mail', motivo: 'email_invalido' }]);
    expect(rolEnCurso(nucleo, id, juana)).toBe('alumno');
    const ev = auditoriaDe(nucleo, 'importacion_siu', id).pop();
    expect(ev).toBeTruthy();
    expect(Number(ev.agente)).toBe(1);
    expect(Number(ev.actor_id)).toBe(idDe(nucleo, PROFE_AUSTRAL));
  });

  test('genera, lee y desactiva el código de inscripción', async ({ nucleo }) => {
    const antes = ok(await duena.get(`/api/cursos/${id}/codigo`), 'código').codigo;
    const res = await correrScript(
      nucleo,
      duena,
      id,
      `await intentar('generar', () => c.generarCodigo(10));\nawait intentar('apagar', () => c.activarCodigo(false));\nawait intentar('leer', () => c.codigoInscripcion());`,
      { pedido: 'Generá un código nuevo y dejalo desactivado' },
    );
    const gen = resultado(res, 'generar');
    expect(gen.ok, JSON.stringify(gen)).toBe(true);
    expect(gen.valor.codigo).not.toBe(antes);
    expect(gen.valor.activo).toBe(true);
    const dias = (Date.parse(gen.valor.vence) - Date.now()) / 86_400_000;
    expect(dias).toBeGreaterThan(9.9);
    expect(dias).toBeLessThan(10.1);
    expect(resultado(res, 'apagar').valor.activo).toBe(false);
    const leido = resultado(res, 'leer').valor;
    const web = ok(await duena.get(`/api/cursos/${id}/codigo`), 'código');
    expect(web).toEqual(leido);
    expect(web.codigo).toBe(gen.valor.codigo);
    expect(web.activo).toBe(false);
    for (const accion of ['codigo_curso_generado', 'codigo_curso_cambiado']) {
      const ev = auditoriaDe(nucleo, accion, id).pop();
      expect(ev, accion).toBeTruthy();
      expect(Number(ev.agente)).toBe(1);
    }
  });

  test('pedir quitar a un alumno deja una confirmación y la persona sigue hasta que el profesor la aprueba', async ({ nucleo }) => {
    await inscribirOk(duena, id, [ALUMNA2_AUSTRAL]);
    const alumna = idDe(nucleo, ALUMNA2_AUSTRAL);
    const res = await correrScript(nucleo, duena, id, `await intentar('quitar', () => c.pedirQuitar(${alumna}));\nawait intentar('pendientes', () => c.confirmaciones());`, {
      pedido: 'Sacá a Sofía López del curso',
    });
    const q = resultado(res, 'quitar');
    expect(q.ok, JSON.stringify(q)).toBe(true);
    expect(q.valor).toMatchObject({ tipo: 'quitar', estado: 'pendiente', rol: null, resuelta: null });
    expect(q.valor.persona).toMatchObject({ id: String(alumna), email: ALUMNA2_AUSTRAL });
    expect(q.valor.pedida_por.id).toBe(String(idDe(nucleo, PROFE_AUSTRAL)));
    expect(resultado(res, 'pendientes').valor.map((x: any) => x.id)).toContain(q.valor.id);
    expect(rolEnCurso(nucleo, id, ALUMNA2_AUSTRAL)).toBe('alumno');

    const fila = nucleo.consultar('SELECT * FROM confirmaciones_agente WHERE id = ?', q.valor.id)[0];
    expect(fila).toMatchObject({ curso_id: id, tipo: 'quitar', estado: 'pendiente' });
    expect(Number(fila.usuario_id)).toBe(alumna);
    expect(Number(fila.pedida_por)).toBe(idDe(nucleo, PROFE_AUSTRAL));
    const pedido = auditoriaDe(nucleo, 'confirmacion_pedida', ALUMNA2_AUSTRAL).pop();
    expect(pedido).toBeTruthy();
    expect(Number(pedido.agente)).toBe(1);
    expect(auditoriaDe(nucleo, 'desinscripcion', ALUMNA2_AUSTRAL).filter((e) => String(e.detalle).includes(id))).toHaveLength(0);

    const lista = ok(await duena.get(`/api/cursos/${id}/confirmaciones`), 'confirmaciones');
    const c = lista.confirmaciones.find((x: any) => x.id === q.valor.id);
    expect(c).toMatchObject({ tipo: 'quitar', estado: 'pendiente' });
    expect(c.persona).toMatchObject({ id: alumna, email: ALUMNA2_AUSTRAL });
    expect(ok(await profe.get(`/api/cursos/${id}/confirmaciones`), 'confirmaciones del profesor').confirmaciones.map((x: any) => x.id)).toContain(q.valor.id);

    const ap = ok(await duena.post(`/api/cursos/${id}/confirmaciones/${q.valor.id}/aprobar`, {}), 'aprobar');
    expect(ap.estado).toBe('aprobada');
    expect(ap.resuelta).toBeTruthy();
    expect(rolEnCurso(nucleo, id, ALUMNA2_AUSTRAL)).toBeNull();
    const des = auditoriaDe(nucleo, 'desinscripcion', ALUMNA2_AUSTRAL).filter((e) => String(e.detalle).includes(id)).pop();
    expect(des).toBeTruthy();
    expect(Number(des.agente)).toBe(1);
    expect(Number(des.actor_id)).toBe(idDe(nucleo, PROFE_AUSTRAL));
    expect(ok(await duena.get(`/api/cursos/${id}/confirmaciones`), 'confirmaciones').confirmaciones.map((x: any) => x.id)).not.toContain(q.valor.id);
    const otra = await duena.post(`/api/cursos/${id}/confirmaciones/${q.valor.id}/aprobar`, {});
    expect(otra.status).toBe(409);
    expect(otra.json.error).toBe('confirmacion_resuelta');
  });

  test('el dueño pide cambiar un rol y lo confirma; un pedido cancelado no cambia nada', async ({ nucleo }) => {
    await inscribirOk(duena, id, [PROFE3_AUSTRAL, ALUMNA2_AUSTRAL]);
    const martin = idDe(nucleo, PROFE3_AUSTRAL);
    const sofia = idDe(nucleo, ALUMNA2_AUSTRAL);
    const res = await correrScript(
      nucleo,
      duena,
      id,
      `await intentar('rol', () => c.pedirCambioDeRol('${martin}', 'profesor'));\nawait intentar('quitar', () => c.pedirQuitar('${sofia}'));`,
      { pedido: 'Hacé profesor a Martín y sacá a Sofía' },
    );
    const rol = resultado(res, 'rol');
    expect(rol.ok, JSON.stringify(rol)).toBe(true);
    expect(rol.valor).toMatchObject({ tipo: 'rol', rol: 'profesor', estado: 'pendiente' });
    expect(rolEnCurso(nucleo, id, PROFE3_AUSTRAL)).toBe('alumno');
    const ap = ok(await duena.post(`/api/cursos/${id}/confirmaciones/${rol.valor.id}/aprobar`, {}), 'aprobar rol');
    expect(ap.estado).toBe('aprobada');
    expect(rolEnCurso(nucleo, id, PROFE3_AUSTRAL)).toBe('profesor');
    const ev = auditoriaDe(nucleo, 'rol_en_curso', PROFE3_AUSTRAL).pop();
    expect(ev).toBeTruthy();
    expect(Number(ev.agente)).toBe(1);

    const quitar = resultado(res, 'quitar');
    expect(quitar.ok, JSON.stringify(quitar)).toBe(true);
    const rech = ok(await duena.post(`/api/cursos/${id}/confirmaciones/${quitar.valor.id}/rechazar`, {}), 'rechazar');
    expect(rech.estado).toBe('rechazada');
    expect(rolEnCurso(nucleo, id, ALUMNA2_AUSTRAL)).toBe('alumno');
    const evr = auditoriaDe(nucleo, 'confirmacion_rechazada', ALUMNA2_AUSTRAL).pop();
    expect(evr).toBeTruthy();
    expect(Number(evr.agente)).toBe(1);
    const despues = await duena.post(`/api/cursos/${id}/confirmaciones/${quitar.valor.id}/aprobar`, {});
    expect(despues.status).toBe(409);
    expect(despues.json.error).toBe('confirmacion_resuelta');
    expect(rolEnCurso(nucleo, id, ALUMNA2_AUSTRAL)).toBe('alumno');
  });

  test('el agente de un profesor que no es dueño actúa con sus permisos y la confirmación la aprueba él', async ({ nucleo }) => {
    const nuevo = `${aleatorio('al.')}@mail.austral.edu.ar`;
    const res = await correrScript(nucleo, profe, id, `await intentar('inscribir', () => c.inscribir(['${nuevo}']));`, { pedido: 'Inscribí a un alumno' });
    expect(resultado(res, 'inscribir').ok).toBe(true);
    const ev = auditoriaDe(nucleo, 'inscripcion', nuevo).pop();
    expect(Number(ev.actor_id)).toBe(idDe(nucleo, PROFE2_AUSTRAL));
    expect(Number(ev.agente)).toBe(1);

    const alumno = idDe(nucleo, nuevo);
    const res2 = await correrScript(nucleo, profe, id, `await intentar('quitar', () => c.pedirQuitar('${alumno}'));`, { pedido: 'Sacalo' });
    const q = resultado(res2, 'quitar');
    expect(q.ok, JSON.stringify(q)).toBe(true);
    expect(q.valor.pedida_por.id).toBe(String(idDe(nucleo, PROFE2_AUSTRAL)));
    const ajena = await duena.post(`/api/cursos/${id}/confirmaciones/${q.valor.id}/aprobar`, {});
    expect(ajena.status).toBe(403);
    expect(rolEnCurso(nucleo, id, nuevo)).toBe('alumno');
    const propia = ok(await profe.post(`/api/cursos/${id}/confirmaciones/${q.valor.id}/aprobar`, {}), 'aprobar propia');
    expect(propia.estado).toBe('aprobada');
    expect(rolEnCurso(nucleo, id, nuevo)).toBeNull();
    const des = auditoriaDe(nucleo, 'desinscripcion', nuevo).pop();
    expect(Number(des.actor_id)).toBe(idDe(nucleo, PROFE2_AUSTRAL));
  });

  test('el código del curso, publicado o en prueba, lee las acciones', async ({ nucleo }) => {
    const web = ok(await duena.get(`/api/cursos/${id}/inscriptos`), 'inscriptos');
    const codigo = ok(await duena.get(`/api/cursos/${id}/codigo`), 'código');
    const espacio = entornoEspacio(nucleo, id);
    for (const [base, token] of [
      [String(espacio.CAMPUSIA_API).replace(/\/$/, ''), String(espacio.CAMPUSIA_TOKEN_CURSO)],
      [apiDeCurso(nucleo, id).replace(/\/$/, ''), tokenDeCurso(nucleo, id)],
    ]) {
      const i = await pedirInterna(`${base}/api/curso/acciones/inscriptos`, token);
      expect(i.status, `${base}: ${i.texto}`).toBe(200);
      expect(i.json.inscriptos.map((x: any) => x.email)).toEqual(web.inscriptos.map((x: any) => x.email));
      expect(i.json.alumnos).toBe(web.alumnos);
      const c = await pedirInterna(`${base}/api/curso/acciones/codigo`, token);
      expect(c.status).toBe(200);
      expect(c.json).toEqual(codigo);
      const p = await pedirInterna(`${base}/api/curso/acciones/confirmaciones`, token);
      expect(p.status).toBe(200);
      expect(Array.isArray(p.json.confirmaciones)).toBe(true);
    }
  });

  test('las instrucciones del agente describen las acciones y cómo usarlas con el SDK', async ({ nucleo }) => {
    const enRepo = archivoEnRama(nucleo, id, 'main', 'CLAUDE.md') ?? '';
    const gestionada = ejecutarEn(nombreEspacio(nucleo, id), ['cat', '/etc/claude-code/CLAUDE.md']);
    expect(gestionada.estado, gestionada.salida).toBe(0);
    const plantilla = fs.readFileSync(path.join(RAIZ_REPO, 'plantilla-curso', 'CLAUDE.md'), 'utf8');
    for (const texto of [enRepo, gestionada.salida, plantilla]) {
      for (const m of METODOS) expect(texto).toContain(m);
      expect(texto).toContain('clienteDesdeEntorno');
      expect(texto).toContain('panel Editar');
    }
    const permisos = ejecutarEn(nombreEspacio(nucleo, id), ['sh', '-c', 'test -w /etc/claude-code/CLAUDE.md && echo escribible || echo protegido']);
    expect(permisos.salida.trim()).toBe('protegido');
  });
});
