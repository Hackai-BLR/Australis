import { crearTestAcciones, expect, TIEMPO_FASE3, PROFE_AUSTRAL, PROFE2_AUSTRAL, ADMIN_AUSTRAL, OWNER } from '../fixtures.ts';
import type { Cliente } from '../../comun/http.ts';
import { aleatorio } from '../../comun/sesion.ts';
import { inscribirOk } from '../../fase-2/lib/cursos.ts';
import { cursoConEspacio, entornoEspacio, guion, pedirAlAgente } from '../../fase-3/lib/agente.ts';
import { archivar, darDeBaja, deshabilitar, desarchivar, rehabilitar, suspender } from '../../tramo-inhabilitar/lib.ts';
import {
  PRELUDIO_SCRIPT,
  correrScript,
  esperarTokenAgente,
  idDe,
  ok,
  pedirInterna,
  profesorNuevo,
  resultado,
  rolEnCurso,
  sesionDe,
  universidadNueva,
} from '../lib.ts';

const test = crearTestAcciones();
test.describe.configure({ mode: 'serial', timeout: TIEMPO_FASE3 });

let id = '';
let duena: Cliente;
let profe: Cliente;
let admin: Cliente;
let owner: Cliente;

function confirmacionEnBase(nucleo: any, cid: number) {
  return nucleo.consultar('SELECT * FROM confirmaciones_agente WHERE id = ?', cid)[0];
}

function aceptado(r: { status: number; texto: string }, que: string) {
  expect([200, 204], `${que}: ${r.texto}`).toContain(r.status);
}

async function conTokenVivo(nucleo: any, c: Cliente, curso: string, accion: () => Promise<void>) {
  const nombre = aleatorio('viv').toLowerCase().replace(/[^a-z0-9]/g, '');
  const archivo = `acciones-prueba/${nombre}.mjs`;
  guion(nucleo, nombre, [
    { herramientas: [{ nombre: 'Write', entrada: { file_path: `/repo/${archivo}`, content: `${PRELUDIO_SCRIPT}\nsalida('token', TOKEN);\n` } }] },
    { herramientas: [{ nombre: 'Bash', entrada: { command: `node ${archivo}`, description: 'Muestra el token' } }] },
    { herramientas: [{ nombre: 'Bash', entrada: { command: 'sleep 30', description: 'Espera' } }] },
    { texto: 'Listo.' },
  ]);
  const espacios = String(entornoEspacio(nucleo, curso).CAMPUSIA_API).replace(/\/$/, '');
  const desde = nucleo.modelo.pedidos.length;
  const enCurso = pedirAlAgente(c, curso, `Mostrame el token [guion:${nombre}]`).catch(() => null);
  const token = await esperarTokenAgente(nucleo, desde);
  const antes = await pedirInterna(`${espacios}/api/curso/acciones/inscriptos`, token);
  expect(antes.status, antes.texto).toBe(200);
  await accion();
  const nuevo = `${aleatorio('srv.')}@mail.austral.edu.ar`;
  const lectura = await pedirInterna(`${espacios}/api/curso/acciones/inscriptos`, token);
  const escritura = await pedirInterna(`${espacios}/api/curso/acciones/inscriptos`, token, 'POST', { emails: [nuevo], rol: 'alumno' });
  const codigo = await pedirInterna(`${espacios}/api/curso/acciones/codigo`, token, 'POST', { dias: 3 });
  await enCurso;
  return { lectura, escritura, codigo, nuevo };
}

test.describe('confirmaciones en un curso archivado y token del agente con el profesor o el curso fuera de servicio', () => {
  test.beforeAll(async ({ nucleo }) => {
    test.setTimeout(TIEMPO_FASE3);
    duena = await sesionDe(nucleo, PROFE_AUSTRAL);
    profe = await sesionDe(nucleo, PROFE2_AUSTRAL);
    admin = await sesionDe(nucleo, ADMIN_AUSTRAL);
    owner = await sesionDe(nucleo, OWNER);
    id = await cursoConEspacio(duena, { nombre: 'Curso que se Archiva' });
    await inscribirOk(duena, id, [PROFE2_AUSTRAL], 'profesor');
  });

  test('aprobar o rechazar una confirmación de un curso archivado responde 409 curso_archivado y no cambia nada', async ({ nucleo }) => {
    const uno = `${aleatorio('ar1.')}@mail.austral.edu.ar`;
    const dos = `${aleatorio('ar2.')}@mail.austral.edu.ar`;
    await inscribirOk(duena, id, [uno, dos]);
    const res = await correrScript(nucleo, duena, id, [`await intentar('q1', () => c.pedirQuitar('${idDe(nucleo, uno)}'));`, `await intentar('q2', () => c.pedirQuitar('${idDe(nucleo, dos)}'));`].join('\n'), {
      pedido: 'Sacá a los dos',
    });
    const c1 = Number(resultado(res, 'q1').valor.id);
    const c2 = Number(resultado(res, 'q2').valor.id);
    expect(confirmacionEnBase(nucleo, c1).estado).toBe('pendiente');
    expect(confirmacionEnBase(nucleo, c2).estado).toBe('pendiente');

    aceptado(await archivar(duena, id), 'archivar');
    const ajeno = await profe.post(`/api/cursos/${id}/confirmaciones/${c1}/aprobar`, {});
    expect(ajeno.status, ajeno.texto).toBe(403);
    expect(ajeno.json?.error).toBe('prohibido');
    const aprobar = await duena.post(`/api/cursos/${id}/confirmaciones/${c1}/aprobar`, {});
    expect(aprobar.status, aprobar.texto).toBe(409);
    expect(aprobar.json?.error).toBe('curso_archivado');
    const rechazar = await duena.post(`/api/cursos/${id}/confirmaciones/${c2}/rechazar`, {});
    expect(rechazar.status, rechazar.texto).toBe(409);
    expect(rechazar.json?.error).toBe('curso_archivado');
    expect(confirmacionEnBase(nucleo, c1).estado).toBe('pendiente');
    expect(confirmacionEnBase(nucleo, c2).estado).toBe('pendiente');
    expect(rolEnCurso(nucleo, id, uno)).toBe('alumno');
    expect(rolEnCurso(nucleo, id, dos)).toBe('alumno');

    aceptado(await desarchivar(duena, id), 'desarchivar');
    expect(ok(await duena.post(`/api/cursos/${id}/confirmaciones/${c1}/aprobar`, {}), 'aprobar').estado).toBe('aprobada');
    expect(ok(await duena.post(`/api/cursos/${id}/confirmaciones/${c2}/rechazar`, {}), 'rechazar').estado).toBe('rechazada');
    expect(rolEnCurso(nucleo, id, uno)).toBeNull();
    expect(rolEnCurso(nucleo, id, dos)).toBe('alumno');
  });

  test('el token del agente de un profesor suspendido deja de servir en la petición siguiente', async ({ nucleo }) => {
    const p = await profesorNuevo(nucleo, admin);
    await inscribirOk(duena, id, [p.email], 'profesor');
    const r = await conTokenVivo(nucleo, p.cliente, id, async () => aceptado(await suspender(admin, p.id), 'suspender'));
    expect(r.lectura.status, r.lectura.texto).toBe(401);
    expect(r.escritura.status, r.escritura.texto).toBe(401);
    expect(r.codigo.status, r.codigo.texto).toBe(401);
    expect(rolEnCurso(nucleo, id, r.nuevo)).toBeNull();
  });

  test('el token del agente de un profesor dado de baja deja de servir en la petición siguiente', async ({ nucleo }) => {
    const p = await profesorNuevo(nucleo, admin);
    await inscribirOk(duena, id, [p.email], 'profesor');
    const r = await conTokenVivo(nucleo, p.cliente, id, async () => aceptado(await darDeBaja(admin, p.id), 'dar de baja'));
    expect(r.lectura.status, r.lectura.texto).toBe(401);
    expect(r.escritura.status, r.escritura.texto).toBe(401);
    expect(r.codigo.status, r.codigo.texto).toBe(401);
    expect(rolEnCurso(nucleo, id, r.nuevo)).toBeNull();
  });

  test('el token del agente deja de servir cuando el curso se archiva', async ({ nucleo }) => {
    const codigoAntes = ok(await duena.get(`/api/cursos/${id}/codigo`), 'código');
    const r = await conTokenVivo(nucleo, duena, id, async () => aceptado(await archivar(duena, id), 'archivar'));
    expect(r.lectura.status, r.lectura.texto).toBe(401);
    expect(r.escritura.status, r.escritura.texto).toBe(401);
    expect(r.codigo.status, r.codigo.texto).toBe(401);
    expect(rolEnCurso(nucleo, id, r.nuevo)).toBeNull();
    aceptado(await desarchivar(duena, id), 'desarchivar');
    expect(ok(await duena.get(`/api/cursos/${id}/codigo`), 'código')).toEqual(codigoAntes);
  });

  test('el token del agente deja de servir cuando se deshabilita la universidad', async ({ nucleo }) => {
    const uni = await universidadNueva(owner);
    const adminU = await sesionDe(nucleo, uni.admin);
    const p = await profesorNuevo(nucleo, adminU, uni.dominio);
    const curso = await cursoConEspacio(p.cliente, { nombre: 'Curso de una Universidad que se Deshabilita' });
    try {
      const r = await conTokenVivo(nucleo, p.cliente, curso, async () => aceptado(await deshabilitar(owner, uni.id), 'deshabilitar'));
      expect(r.lectura.status, r.lectura.texto).toBe(401);
      expect(r.escritura.status, r.escritura.texto).toBe(401);
      expect(r.codigo.status, r.codigo.texto).toBe(401);
      expect(rolEnCurso(nucleo, curso, r.nuevo)).toBeNull();
    } finally {
      await rehabilitar(owner, uni.id);
    }
  });
});
