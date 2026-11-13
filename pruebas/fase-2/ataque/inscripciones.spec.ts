import { MODO_CODIGO } from '../../comun/nucleo.ts';
import { crearTestCursos, expect, PROFE_AUSTRAL, PROFE2_AUSTRAL, PROFE3_AUSTRAL, ALUMNO_AUSTRAL, ALUMNA2_AUSTRAL, SIN_MARCA_AUSTRAL, ADMIN_AUSTRAL, OWNER, PROFE_DEMO, ALUMNO_DEMO, PENDIENTE_AUSTRAL } from '../fixtures.ts';
import { aleatorio, reautenticar } from '../../comun/sesion.ts';
import { Cliente } from '../../comun/http.ts';
import { crearCurso, idAleatorio, idUsuario, inscribir, inscribirOk, sesion } from '../lib/cursos.ts';

const test = crearTestCursos({ entorno: MODO_CODIGO });
test.describe.configure({ timeout: 300_000 });

async function escenario(nucleo: any) {
  const duena = await sesion(nucleo, PROFE_AUSTRAL);
  const id = idAleatorio('atq');
  expect((await crearCurso(duena, { id })).status).toBe(201);
  await inscribirOk(duena, id, [PROFE2_AUSTRAL], 'profesor');
  await inscribirOk(duena, id, [ALUMNO_AUSTRAL]);
  const profe = await sesion(nucleo, PROFE2_AUSTRAL);
  const alumno = await sesion(nucleo, ALUMNO_AUSTRAL);
  return { id, duena, profe, alumno };
}

function inscriptos(nucleo: any, id: string): Array<{ email: string; rol: string }> {
  return nucleo.consultar('SELECT u.email, i.rol FROM inscripciones i JOIN usuarios u ON u.id = i.usuario_id WHERE i.curso_id = ? ORDER BY u.email', id);
}

test.describe('ataques a las inscripciones', () => {
  test('alumnos y no inscriptos no usan las rutas de docentes', async ({ nucleo }) => {
    const { id, alumno } = await escenario(nucleo);
    const uid = idUsuario(nucleo, ALUMNO_AUSTRAL);
    const rutas: Array<[string, string, any?]> = [
      ['GET', `/api/cursos/${id}/inscriptos`],
      ['POST', `/api/cursos/${id}/inscriptos`, { emails: [ALUMNA2_AUSTRAL], rol: 'alumno' }],
      ['POST', `/api/cursos/${id}/inscriptos/siu`, { archivo: 'a.csv', contenido: Buffer.from(`Mail\n${ALUMNA2_AUSTRAL}\n`).toString('base64') }],
      ['PUT', `/api/cursos/${id}/inscriptos/${uid}`, { rol: 'profesor' }],
      ['DELETE', `/api/cursos/${id}/inscriptos/${idUsuario(nucleo, PROFE2_AUSTRAL)}`],
      ['POST', `/api/cursos/${id}/transferir`, { usuario_id: uid }],
      ['GET', `/api/cursos/${id}/codigo`],
      ['POST', `/api/cursos/${id}/codigo`, {}],
      ['PUT', `/api/cursos/${id}/codigo`, { activo: true }],
    ];
    await reautenticar(alumno);
    for (const [m, r, c] of rutas) {
      const res = await alumno.pedir(m, r, c);
      expect(res.status, `alumno ${m} ${r}`).toBe(403);
      expect(res.json?.error).toBe('prohibido');
    }
    for (const email of [ALUMNA2_AUSTRAL, ADMIN_AUSTRAL, OWNER, PROFE3_AUSTRAL, PROFE_DEMO]) {
      const c = await sesion(nucleo, email);
      await reautenticar(c);
      for (const [m, r, b] of rutas) {
        const res = await c.pedir(m, r, b);
        expect(res.status, `${email} ${m} ${r}`).toBe(404);
      }
      expect((await c.get(`/api/cursos/${id}`)).status).toBe(404);
    }
    const anon = new Cliente(nucleo);
    for (const [m, r, b] of rutas) expect((await anon.pedir(m, r, b)).status, `anónimo ${m} ${r}`).toBe(401);
    expect(inscriptos(nucleo, id).map((x) => x.email)).not.toContain(ALUMNA2_AUSTRAL);
  });

  test('nadie es profesor de un curso sin la marca de profesor', async ({ nucleo }) => {
    const { id, duena } = await escenario(nucleo);
    const nuevo = `${aleatorio('sinmarca')}@austral.edu.ar`;
    for (const emails of [[SIN_MARCA_AUSTRAL], [nuevo], [PROFE3_AUSTRAL, ALUMNA2_AUSTRAL]]) {
      const r = await inscribir(duena, id, emails, 'profesor');
      expect(r.status, emails.join(',')).toBe(400);
      expect(r.json.error).toBe('no_es_profesor');
    }
    expect(inscriptos(nucleo, id).map((x) => x.email)).not.toContain(PROFE3_AUSTRAL);
    expect(nucleo.consultar('SELECT COUNT(*) AS n FROM usuarios WHERE email = ?', nuevo)[0].n).toBe(0);
    await reautenticar(duena);
    const alumnoId = idUsuario(nucleo, ALUMNO_AUSTRAL);
    const r = await duena.put(`/api/cursos/${id}/inscriptos/${alumnoId}`, { rol: 'profesor' });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('no_es_profesor');
    const t = await duena.post(`/api/cursos/${id}/transferir`, { usuario_id: alumnoId });
    expect(t.status).toBe(400);
    expect(t.json.error).toBe('no_es_profesor');
    expect(inscriptos(nucleo, id).find((x) => x.email === ALUMNO_AUSTRAL)?.rol).toBe('alumno');
  });

  test('si le quitan la marca a alguien, no se lo puede transferir el curso', async ({ nucleo }) => {
    const { id, duena } = await escenario(nucleo);
    const admin = await sesion(nucleo, ADMIN_AUSTRAL);
    await reautenticar(admin);
    const p2 = idUsuario(nucleo, PROFE2_AUSTRAL);
    expect((await admin.put(`/api/admin/personas/${p2}/profesor`, { profesor: false })).status).toBe(200);
    try {
      await reautenticar(duena);
      const t = await duena.post(`/api/cursos/${id}/transferir`, { usuario_id: p2 });
      expect(t.status).toBe(400);
      expect(t.json.error).toBe('no_es_profesor');
      expect(inscriptos(nucleo, id).find((x) => x.email === PROFE_AUSTRAL)?.rol).toBe('dueño');
    } finally {
      await admin.put(`/api/admin/personas/${p2}/profesor`, { profesor: true });
    }
  });

  test('un profesor que no es dueño no maneja profesores, roles ni el curso', async ({ nucleo }) => {
    const { id, profe } = await escenario(nucleo);
    const r = await inscribir(profe, id, [PROFE3_AUSTRAL], 'profesor');
    expect(r.status).toBe(403);
    expect(r.json.error).toBe('prohibido');
    const rol = await profe.put(`/api/cursos/${id}/inscriptos/${idUsuario(nucleo, ALUMNO_AUSTRAL)}`, { rol: 'alumno' });
    expect(rol.status).toBe(403);
    expect(rol.json.error).toBe('prohibido');
    await reautenticar(profe);
    const t = await profe.post(`/api/cursos/${id}/transferir`, { usuario_id: idUsuario(nucleo, PROFE2_AUSTRAL) });
    expect(t.status).toBe(403);
    const mismo = await profe.put(`/api/cursos/${id}/inscriptos/${idUsuario(nucleo, PROFE2_AUSTRAL)}`, { rol: 'profesor' });
    expect(mismo.status).toBe(403);
    expect(inscriptos(nucleo, id).find((x) => x.email === PROFE_AUSTRAL)?.rol).toBe('dueño');
  });

  test('un profesor no quita profesores ni a sí mismo', async ({ nucleo }) => {
    const { id, duena, profe } = await escenario(nucleo);
    await inscribirOk(duena, id, [PROFE3_AUSTRAL], 'profesor');
    await reautenticar(profe);
    for (const email of [PROFE3_AUSTRAL, PROFE2_AUSTRAL]) {
      const r = await profe.delete(`/api/cursos/${id}/inscriptos/${idUsuario(nucleo, email)}`);
      expect(r.status, email).toBe(403);
      expect(r.json.error).toBe('prohibido');
    }
    const lista = inscriptos(nucleo, id).map((x) => x.email);
    expect(lista).toContain(PROFE3_AUSTRAL);
    expect(lista).toContain(PROFE2_AUSTRAL);
  });

  test('nadie quita al dueño', async ({ nucleo }) => {
    const { id, duena, profe } = await escenario(nucleo);
    const duenaId = idUsuario(nucleo, PROFE_AUSTRAL);
    await reautenticar(profe);
    const r1 = await profe.delete(`/api/cursos/${id}/inscriptos/${duenaId}`);
    expect(r1.status).toBe(409);
    expect(r1.json.error).toBe('es_dueno');
    await reautenticar(duena);
    const r2 = await duena.delete(`/api/cursos/${id}/inscriptos/${duenaId}`);
    expect(r2.status).toBe(409);
    expect(r2.json.error).toBe('es_dueno');
    const r3 = await duena.put(`/api/cursos/${id}/inscriptos/${duenaId}`, { rol: 'alumno' });
    expect(r3.status).toBe(409);
    expect(r3.json.error).toBe('es_dueno');
    const r4 = await inscribir(duena, id, [PROFE_AUSTRAL], 'alumno');
    expect(r4.status).toBe(200);
    expect(r4.json.ya_estaban).toEqual([PROFE_AUSTRAL]);
    expect(inscriptos(nucleo, id).find((x) => x.email === PROFE_AUSTRAL)?.rol).toBe('dueño');
    expect(nucleo.consultar("SELECT COUNT(*) AS n FROM inscripciones WHERE curso_id = ? AND rol = 'dueño'", id)[0].n).toBe(1);
  });

  test('no se inscriben mails de otra universidad ni de dominios parecidos', async ({ nucleo }) => {
    const { id, duena } = await escenario(nucleo);
    const malos = [
      ALUMNO_DEMO,
      `x${aleatorio()}@austral.edu.ar.evil.com`,
      `x${aleatorio()}@evilaustral.edu.ar`,
      `x${aleatorio()}@sub.austral.edu.ar`,
      OWNER,
      `x${aleatorio()}@gmail.com`,
    ];
    for (const m of malos) {
      const r = await inscribir(duena, id, [ALUMNA2_AUSTRAL, m]);
      expect(r.status, m).toBe(400);
      expect(r.json.error).toBe('dominio_no_habilitado');
      expect(r.json.emails).toEqual([m]);
    }
    const inval = await inscribir(duena, id, ['no es un mail', ALUMNA2_AUSTRAL]);
    expect(inval.status).toBe(400);
    expect(inval.json.error).toBe('email_invalido');
    expect(inscriptos(nucleo, id).map((x) => x.email)).not.toContain(ALUMNA2_AUSTRAL);
    for (const m of malos) expect(nucleo.consultar('SELECT COUNT(*) AS n FROM usuarios WHERE email = ?', m.toLowerCase())[0].n, m).toBe(m === OWNER || m === ALUMNO_DEMO ? 1 : 0);
    const demo = await sesion(nucleo, PROFE_DEMO);
    const idDemo = idAleatorio('demo');
    expect((await crearCurso(demo, { id: idDemo })).status).toBe(201);
    const cruz = await inscribir(demo, idDemo, [ALUMNO_AUSTRAL]);
    expect(cruz.status).toBe(400);
    expect(cruz.json.error).toBe('dominio_no_habilitado');
  });

  test('cuerpos inválidos no inscriben a nadie', async ({ nucleo }) => {
    const { id, duena } = await escenario(nucleo);
    for (const cuerpo of [
      { emails: [], rol: 'alumno' },
      { emails: [ALUMNA2_AUSTRAL], rol: 'dueño' },
      { emails: [ALUMNA2_AUSTRAL], rol: 'administrador' },
      { emails: ALUMNA2_AUSTRAL, rol: 'alumno' },
      { emails: Array.from({ length: 501 }, (_, i) => `a${i}@austral.edu.ar`), rol: 'alumno' },
    ]) {
      const r = await duena.post(`/api/cursos/${id}/inscriptos`, cuerpo);
      expect(r.status, JSON.stringify(cuerpo).slice(0, 80)).toBe(400);
    }
    expect(inscriptos(nucleo, id).length).toBe(3);
  });

  test('un docente no ve ni toca los inscriptos de otro curso', async ({ nucleo }) => {
    const { id } = await escenario(nucleo);
    const martin = await sesion(nucleo, PROFE3_AUSTRAL);
    const suyo = idAleatorio('suyo');
    expect((await crearCurso(martin, { id: suyo })).status).toBe(201);
    expect((await martin.get(`/api/cursos/${id}/inscriptos`)).status).toBe(404);
    expect((await inscribir(martin, id, [ALUMNA2_AUSTRAL])).status).toBe(404);
    expect((await martin.get(`/api/cursos/${id}/codigo`)).status).toBe(404);
    const otro = await martin.get(`/api/cursos/${suyo}/inscriptos`);
    expect(otro.json.inscriptos.map((i: any) => i.email)).toEqual([PROFE3_AUSTRAL]);
    await reautenticar(martin);
    expect((await martin.delete(`/api/cursos/${id}/inscriptos/${idUsuario(nucleo, ALUMNO_AUSTRAL)}`)).status).toBe(404);
    expect(inscriptos(nucleo, id).map((x) => x.email)).toContain(ALUMNO_AUSTRAL);
  });

  test('las acciones sensibles no se hacen con token ni sin reautenticación', async ({ nucleo }) => {
    const { id, duena } = await escenario(nucleo);
    const alumnoId = idUsuario(nucleo, ALUMNO_AUSTRAL);
    for (const [m, r, c] of [
      ['DELETE', `/api/cursos/${id}/inscriptos/${alumnoId}`, undefined],
      ['PUT', `/api/cursos/${id}/inscriptos/${alumnoId}`, { rol: 'alumno' }],
      ['POST', `/api/cursos/${id}/transferir`, { usuario_id: idUsuario(nucleo, PROFE2_AUSTRAL) }],
    ] as Array<[string, string, any]>) {
      const res = await duena.pedir(m, r, c);
      expect(res.status, `${m} ${r}`).toBe(403);
      expect(res.json.error).toBe('reautenticacion_requerida');
    }
    expect(inscriptos(nucleo, id).map((x) => x.email)).toContain(ALUMNO_AUSTRAL);
  });

  test('las modificaciones con cookie exigen Origin de la plataforma', async ({ nucleo }) => {
    const { id, duena } = await escenario(nucleo);
    for (const origen of [`http://${id}-curso.campusia.prueba:${nucleo.puerto}`, 'http://evil.com', null]) {
      const r = await duena.post(`/api/cursos/${id}/inscriptos`, { emails: [ALUMNA2_AUSTRAL], rol: 'alumno' }, { origen });
      expect(r.status, String(origen)).toBe(403);
      expect(r.json.error).toBe('origen_invalido');
    }
    expect(inscriptos(nucleo, id).map((x) => x.email)).not.toContain(ALUMNA2_AUSTRAL);
  });

  test('las cuentas pendientes no se vuelven profesores por inscribirlas', async ({ nucleo }) => {
    const { id, duena } = await escenario(nucleo);
    const r = await inscribir(duena, id, [PENDIENTE_AUSTRAL], 'profesor');
    expect(r.status).toBe(200);
    const nuevo = `${aleatorio('pend')}@austral.edu.ar`;
    await inscribirOk(duena, id, [nuevo]);
    expect(nucleo.consultar('SELECT profesor, administrador, owner FROM usuarios WHERE email = ?', nuevo)[0]).toEqual({ profesor: 0, administrador: 0, owner: 0 });
    const campos = await duena.post(`/api/cursos/${id}/inscriptos`, { emails: [`${aleatorio('extra')}@austral.edu.ar`], rol: 'alumno', profesor: true, administrador: true, universidad_id: 2 });
    expect(campos.status).toBe(200);
    const em = campos.json.agregados[0];
    expect(nucleo.consultar('SELECT profesor, administrador FROM usuarios WHERE email = ?', em)[0]).toEqual({ profesor: 0, administrador: 0 });
  });
});
