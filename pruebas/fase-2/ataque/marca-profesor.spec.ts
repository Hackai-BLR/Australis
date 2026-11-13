import { crearTestCursos, expect, PROFE_AUSTRAL, ALUMNO_AUSTRAL, ADMIN_AUSTRAL } from '../fixtures.ts';
import { aleatorio, reautenticar } from '../../comun/sesion.ts';
import type { Cliente } from '../../comun/http.ts';
import {
  TIEMPO_PRUEBA_DOCKER,
  crearCurso,
  cursoListo,
  getCurso,
  idAleatorio,
  idUsuario,
  inscribirOk,
  sesion,
} from '../lib/cursos.ts';

const test = crearTestCursos();
test.describe.configure({ mode: 'serial', timeout: TIEMPO_PRUEBA_DOCKER });

async function marcar(admin: Cliente, usuario: number, profesor: boolean) {
  const r = await admin.put(`/api/admin/personas/${usuario}/profesor`, { profesor });
  expect(r.status, r.texto).toBe(200);
}

let id = '';
let propio = '';
let profe: Cliente;
let duena: Cliente;
let admin: Cliente;
let emailProfe = '';
let emailDuena = '';

test.describe('quitar la marca de profesor', () => {
  test.beforeAll(async ({ nucleo }) => {
    test.setTimeout(TIEMPO_PRUEBA_DOCKER);
    emailProfe = `${aleatorio('exprofe')}@austral.edu.ar`;
    emailDuena = `${aleatorio('exduena')}@austral.edu.ar`;
    profe = await sesion(nucleo, emailProfe);
    duena = await sesion(nucleo, emailDuena);
    admin = await sesion(nucleo, ADMIN_AUSTRAL);
    await reautenticar(admin);
    await marcar(admin, idUsuario(nucleo, emailProfe), true);
    await marcar(admin, idUsuario(nucleo, emailDuena), true);
    const titular = await sesion(nucleo, PROFE_AUSTRAL);
    id = idAleatorio('marca');
    await cursoListo(titular, { id, nombre: `Marca ${id}` });
    await inscribirOk(titular, id, [emailProfe], 'profesor');
    await inscribirOk(titular, id, [ALUMNO_AUSTRAL]);
    propio = idAleatorio('propio');
    const c = await crearCurso(duena, { id: propio, nombre: `Propio ${propio}` });
    expect(c.status, c.texto).toBe(201);
    expect((await profe.get(`/api/cursos/${id}/inscriptos`)).status).toBe(200);
    expect((await duena.get(`/api/cursos/${propio}/inscriptos`)).status).toBe(200);
    const yo = await getCurso(profe, id, '/api/yo');
    expect(yo.json?.rol, yo.texto).toBe('profesor');
    await marcar(admin, idUsuario(nucleo, emailProfe), false);
    await marcar(admin, idUsuario(nucleo, emailDuena), false);
  });

  test('un profesor sin marca deja de ser docente del curso', async ({ nucleo }) => {
    const alumno = idUsuario(nucleo, ALUMNO_AUSTRAL);
    expect((await profe.get(`/api/cursos/${id}/inscriptos`)).status).toBe(403);
    expect((await profe.post(`/api/cursos/${id}/inscriptos`, { emails: ['nuevo.marca@austral.edu.ar'], rol: 'alumno' })).status).toBe(403);
    expect((await profe.get(`/api/cursos/${id}/codigo`)).status).toBe(403);
    expect((await profe.post(`/api/cursos/${id}/codigo`, { dias: 5 })).status).toBe(403);
    expect((await profe.put(`/api/cursos/${id}/codigo`, { activo: true })).status).toBe(403);
    await reautenticar(profe);
    expect((await profe.delete(`/api/cursos/${id}/inscriptos/${alumno}`)).status).toBe(403);
    const curso = await profe.get(`/api/cursos/${id}`);
    expect(curso.json.rol).toBe('alumno');
    const mis = await profe.get('/api/mis-cursos');
    expect(mis.json.cursos.find((c: any) => c.id === id)?.rol).toBe('alumno');
    const titular = await sesion(nucleo, PROFE_AUSTRAL);
    const lista = await titular.get(`/api/cursos/${id}/inscriptos`);
    expect(lista.json.inscriptos.find((i: any) => i.email === emailProfe)).toMatchObject({ rol: 'alumno', profesor: false });
    expect(nucleo.consultar("SELECT * FROM auditoria WHERE accion = 'rol_en_curso' AND detalle LIKE ?", `%${emailProfe}%${id}%`).length).toBe(1);
  });

  test('el curso recibe la identidad firmada como alumno', async ({ nucleo }) => {
    const yo = await getCurso(profe, id, '/api/yo');
    expect(yo.status, yo.texto).toBe(200);
    expect(yo.json).toMatchObject({ email: emailProfe, rol: 'alumno' });
    expect(nucleo.proceso!.exitCode).toBeNull();
  });

  test('una dueña sin marca no administra su curso', async ({ nucleo }) => {
    expect((await duena.get(`/api/cursos/${propio}/inscriptos`)).status).toBe(403);
    expect((await duena.post(`/api/cursos/${propio}/inscriptos`, { emails: [ALUMNO_AUSTRAL], rol: 'alumno' })).status).toBe(403);
    expect((await duena.post(`/api/cursos/${propio}/inscriptos`, { emails: [PROFE_AUSTRAL], rol: 'profesor' })).status).toBe(403);
    expect((await duena.post(`/api/cursos/${propio}/codigo`, {})).status).toBe(403);
    await reautenticar(duena);
    expect((await duena.post(`/api/cursos/${propio}/transferir`, { usuario_id: idUsuario(nucleo, PROFE_AUSTRAL) })).status).toBe(403);
    expect((await duena.put(`/api/cursos/${propio}/inscriptos/${idUsuario(nucleo, ALUMNO_AUSTRAL)}`, { rol: 'profesor' })).status).toBe(403);
    expect((await duena.get(`/api/cursos/${propio}`)).json.rol).toBe('alumno');
    expect(nucleo.consultar('SELECT rol FROM inscripciones WHERE curso_id = ? AND usuario_id = ?', propio, idUsuario(nucleo, emailDuena))[0].rol).toBe('dueño');
  });

  test('si la marca vuelve, la dueña recupera su curso', async ({ nucleo }) => {
    await reautenticar(admin);
    await marcar(admin, idUsuario(nucleo, emailDuena), true);
    expect((await duena.get(`/api/cursos/${propio}/inscriptos`)).status).toBe(200);
    expect((await duena.get(`/api/cursos/${propio}`)).json.rol).toBe('dueño');
  });
});
