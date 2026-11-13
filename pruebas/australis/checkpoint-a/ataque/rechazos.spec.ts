import { expect, test } from '@playwright/test';
import { Cliente, tokenDeInvitacion } from '../../comun/cliente.ts';
import {
  CLAVE,
  alumnoConSesion,
  crearCampus,
  crearClaseDeHoy,
  crearDocente,
  crearEvaluacion,
  importarAlumnos,
  secretaria,
  subirPdf,
} from '../../comun/escenario.ts';

test.describe.configure({ mode: 'serial' });

test.describe('Checkpoint A: lo que debe rechazarse', () => {
  let sec: Cliente;
  let duena: Cliente;
  let intruso: Cliente;
  let campus: number;
  let otroCampus: number;
  let item: number;
  let claseId: number;
  let presentacion: number;
  let alumnoA: { cliente: Cliente; id: number; correo: string };
  let alumnoB: { cliente: Cliente; id: number; correo: string };
  let ajeno: Cliente;

  test.beforeAll(async () => {
    sec = await secretaria();
    duena = (await crearDocente(sec, 'Docente Dueña')).cliente;
    intruso = (await crearDocente(sec, 'Docente Intruso')).cliente;
    campus = await crearCampus(duena, 'Campus de la dueña');
    otroCampus = await crearCampus(intruso, 'Campus del intruso');
    const lista = await importarAlumnos(duena, campus, 'Nombre,Correo\nAlumna Uno,uno@alumnos.test\nAlumno Dos,dos@alumnos.test');
    const [a, b] = lista;
    alumnoA = { cliente: await alumnoConSesion(duena, campus, a.correo), id: a.id, correo: a.correo };
    alumnoB = { cliente: await alumnoConSesion(duena, campus, b.correo), id: b.id, correo: b.correo };
    item = await crearEvaluacion(duena, campus, 'Parcial', 1);
    await duena.put(`/api/campuses/${campus}/gradebook/entries`, {
      entries: [
        { item_id: item, student_id: a.id, score: 7 },
        { item_id: item, student_id: b.id, score: 5 },
      ],
    });
    claseId = await crearClaseDeHoy(duena, campus);
    presentacion = (await subirPdf(duena, campus, 2)).id;
    ajeno = await Cliente.nuevo();
  });

  test.afterAll(async () => {
    for (const c of [sec, duena, intruso, ajeno, alumnoA?.cliente, alumnoB?.cliente]) await c?.cerrar();
  });

  test('sin sesión no se ve nada', async () => {
    for (const ruta of [
      '/api/campuses',
      `/api/campuses/${campus}`,
      `/api/campuses/${campus}/gradebook`,
      '/api/grades/mine',
      '/api/classes/today',
      `/api/classes/${claseId}`,
      `/api/presentations/${presentacion}/file`,
      '/api/users',
    ]) {
      expect((await ajeno.get(ruta)).estado, ruta).toBe(401);
    }
  });

  test('una contraseña equivocada no inicia sesión', async () => {
    const r = await (await Cliente.nuevo()).post('/api/auth/login', { email: alumnoA.correo, password: 'no-es-la-clave' });
    expect(r.estado).toBe(401);
    const inexistente = await (await Cliente.nuevo()).post('/api/auth/login', { email: 'nadie@alumnos.test', password: CLAVE });
    expect(inexistente.estado).toBe(401);
  });

  test('un docente no entra al campus de otro docente', async () => {
    const lecturas = [
      `/api/campuses/${campus}`,
      `/api/campuses/${campus}/revisions`,
      `/api/campuses/${campus}/gradebook`,
      `/api/campuses/${campus}/gradebook/audit`,
      `/api/campuses/${campus}/members`,
      `/api/campuses/${campus}/ai/usage`,
      `/api/classes/${claseId}`,
      `/api/presentations/${presentacion}/file`,
    ];
    for (const ruta of lecturas) expect((await intruso.get(ruta)).estado, ruta).toBe(403);

    const escrituras: [string, unknown][] = [
      [`/api/campuses/${campus}/gradebook/items`, { title: 'Intruso', weight: 1 }],
      [`/api/campuses/${campus}/ai/proposals`, { instruction: 'Agregá una semana sobre ética' }],
      [`/api/campuses/${campus}/roster/imports`, { text: 'x@alumnos.test' }],
      [`/api/campuses/${campus}/classes`, { title: 'Clase intrusa', starts_at: '2099-01-01 10:00:00', duration_min: 60 }],
      [`/api/campuses/${campus}/revisions/1/restore`, {}],
      [`/api/campuses/${campus}/members/${alumnoA.id}/suspend`, { reason: 'intruso' }],
      [`/api/presentations/${presentacion}/live`, {}],
      [`/api/classes/${claseId}/end`, {}],
    ];
    for (const [ruta, cuerpo] of escrituras) expect((await intruso.post(ruta, cuerpo)).estado, ruta).toBe(403);

    const nota = await intruso.put(`/api/campuses/${campus}/gradebook/entries`, { entries: [{ item_id: item, student_id: alumnoA.id, score: 10 }] });
    expect(nota.estado).toBe(403);
    const documento = await intruso.put(`/api/campuses/${campus}/document`, { version: 1, document: { schema: 1, sections: [] } });
    expect(nota.estado).toBe(403);
    expect(documento.estado).toBe(403);

    const libro = (await duena.get(`/api/campuses/${campus}/gradebook`)).json;
    expect(JSON.stringify(libro)).not.toContain('"score":10');
  });

  test('un docente no ve los campus de otro en su lista', async () => {
    const lista = (await intruso.get('/api/campuses')).json;
    expect(lista.map((c: any) => c.id)).toEqual([otroCampus]);
  });

  test('un alumno no escribe notas ni cambia el campus', async () => {
    const nota = await alumnoA.cliente.put(`/api/campuses/${campus}/gradebook/entries`, {
      entries: [{ item_id: item, student_id: alumnoA.id, score: 10 }],
    });
    expect(nota.estado).toBe(403);
    expect((await alumnoA.cliente.post(`/api/campuses/${campus}/gradebook/items`, { title: 'Mío', weight: 1 })).estado).toBe(403);
    expect((await alumnoA.cliente.patch(`/api/gradebook/items/${item}`, { title: 'Mío', reason: 'quiero' })).estado).toBe(403);
    expect((await alumnoA.cliente.post(`/api/gradebook/items/${item}/archive`, { reason: 'quiero' })).estado).toBe(403);
    expect((await alumnoA.cliente.post(`/api/campuses/${campus}/ai/proposals`, { instruction: 'Agregá una semana sobre ética' })).estado).toBe(403);
    expect((await alumnoA.cliente.put(`/api/campuses/${campus}/document`, { version: 1, document: { schema: 1, sections: [] } })).estado).toBe(403);
    expect((await alumnoA.cliente.post(`/api/campuses/${campus}/revisions/1/restore`, {})).estado).toBe(403);
    expect((await alumnoA.cliente.post(`/api/campuses/${campus}/roster/imports`, { text: 'x@alumnos.test' })).estado).toBe(403);
    expect((await alumnoA.cliente.post(`/api/presentations/${presentacion}/live`, {})).estado).toBe(403);
    expect((await alumnoA.cliente.post(`/api/classes/${claseId}/end`, {})).estado).toBe(403);
    expect((await alumnoA.cliente.post('/api/users', { email: 'x@alumnos.test', full_name: 'X', role: 'secretary' })).estado).toBe(403);

    const mias = (await alumnoA.cliente.get('/api/grades/mine')).json;
    expect(mias.courses[0].items[0].score).toBe(7);
  });

  test('un alumno no lee el libro de calificaciones ni las notas de otro alumno', async () => {
    expect((await alumnoA.cliente.get(`/api/campuses/${campus}/gradebook`)).estado).toBe(403);
    expect((await alumnoA.cliente.get(`/api/campuses/${campus}/gradebook/audit`)).estado).toBe(403);
    expect((await alumnoA.cliente.get(`/api/campuses/${campus}/members`)).estado).toBe(403);

    const mias = await alumnoA.cliente.get('/api/grades/mine');
    expect(mias.estado).toBe(200);
    expect(mias.texto).not.toContain(alumnoB.correo);
    expect(JSON.stringify(mias.json)).not.toContain(`"student_id":${alumnoB.id}`);
    const lasDeB = await alumnoB.cliente.get('/api/grades/mine');
    expect(lasDeB.json.courses[0].items[0].score).toBe(5);
    expect(mias.json.courses[0].items[0].score).toBe(7);
  });

  test('un alumno de otro campus no entra a este', async () => {
    const lista = await importarAlumnos(intruso, otroCampus, 'Nombre,Correo\nAlumna Ajena,ajena@alumnos.test');
    const otro = await alumnoConSesion(intruso, otroCampus, lista[0].correo);
    for (const ruta of [`/api/campuses/${campus}`, `/api/classes/${claseId}`, `/api/presentations/${presentacion}/file`]) {
      expect((await otro.get(ruta)).estado, ruta).toBe(403);
    }
    expect((await otro.get('/api/grades/mine')).json.courses.every((c: any) => c.campus_id !== campus)).toBe(true);
    await otro.cerrar();
  });

  test('el alumno no recibe el enlace de anfitrión de la clase', async () => {
    const clase = await alumnoA.cliente.get(`/api/classes/${claseId}`);
    expect(clase.estado).toBe(200);
    expect(clase.json.start_url ?? null).toBeNull();
    expect(clase.json.join_url).toContain('/simulado/zoom/');
    const hoy = (await alumnoA.cliente.get('/api/classes/today')).json;
    expect(hoy.every((c: any) => c.start_url === null)).toBe(true);
  });

  test('un pedido a la IA para cambiar una nota se rechaza y no cambia nada', async () => {
    const antes = (await duena.get(`/api/campuses/${campus}`)).json;
    const filasAntes = (await duena.get(`/api/campuses/${campus}/gradebook/audit`)).json.length;
    const propuesta = await duena.post(`/api/campuses/${campus}/ai/proposals`, { instruction: 'Cambiá la nota de Alumno Dos a 10' });
    expect(propuesta.estado, propuesta.texto).toBe(201);
    expect(propuesta.json.ops).toEqual([]);
    expect(propuesta.json.preview ?? null).toBeNull();
    expect(propuesta.texto).toContain('No puedo cambiar notas');

    const despues = (await duena.get(`/api/campuses/${campus}`)).json;
    expect(despues.version).toBe(antes.version);
    expect(despues.document).toEqual(antes.document);
    const notasB = (await alumnoB.cliente.get('/api/grades/mine')).json;
    expect(notasB.courses[0].items[0].score).toBe(5);
    const auditoria = (await duena.get(`/api/campuses/${campus}/gradebook/audit`)).json;
    expect(auditoria.length).toBe(filasAntes);
  });

  test('cambiar una nota ya cargada exige un motivo y queda auditado', async () => {
    const sinMotivo = await duena.put(`/api/campuses/${campus}/gradebook/entries`, {
      entries: [{ item_id: item, student_id: alumnoB.id, score: 6 }],
    });
    expect(sinMotivo.estado).toBe(422);
    const conMotivo = await duena.put(`/api/campuses/${campus}/gradebook/entries`, {
      entries: [{ item_id: item, student_id: alumnoB.id, score: 6 }],
      reason: 'Recuperatorio',
    });
    expect(conMotivo.estado, conMotivo.texto).toBe(200);
    const auditoria = (await duena.get(`/api/campuses/${campus}/gradebook/audit`)).json;
    expect(auditoria[0].reason).toBe('Recuperatorio');
  });

  test('un alumno suspendido pierde el acceso y no se borra', async () => {
    const suspendida = await duena.post(`/api/campuses/${campus}/members/${alumnoB.id}/suspend`, { reason: 'Baja a pedido' });
    expect(suspendida.estado, suspendida.texto).toBe(200);

    for (const ruta of [`/api/campuses/${campus}`, `/api/classes/${claseId}`, `/api/presentations/${presentacion}/file`]) {
      expect((await alumnoB.cliente.get(ruta)).estado, ruta).toBe(403);
    }
    const mias = await alumnoB.cliente.get('/api/grades/mine');
    expect(mias.json.courses.every((c: any) => c.campus_id !== campus)).toBe(true);
    const hoy = await alumnoB.cliente.get('/api/classes/today');
    expect(hoy.json.every((c: any) => c.campus_id !== campus)).toBe(true);

    const miembros = (await duena.get(`/api/campuses/${campus}/members`)).json;
    const fila = miembros.find((m: any) => m.user_id === alumnoB.id);
    expect(fila.status).toBe('suspended');
    expect(fila.suspended_reason).toBe('Baja a pedido');
    expect((await duena.delete(`/api/campuses/${campus}/members/${alumnoB.id}`)).estado).not.toBe(200);
    expect((await duena.get(`/api/campuses/${campus}/members`)).json.length).toBe(miembros.length);

    const reactivada = await duena.post(`/api/campuses/${campus}/members/${alumnoB.id}/reactivate`, { reason: 'Se reincorpora' });
    expect(reactivada.estado, reactivada.texto).toBe(200);
    expect((await alumnoB.cliente.get(`/api/campuses/${campus}`)).estado).toBe(200);
  });

  test('una invitación usada no sirve de nuevo', async () => {
    const creado = await sec.post('/api/users', { email: 'una-vez@pruebas.example', full_name: 'Una Vez', role: 'professor' });
    const token = tokenDeInvitacion(creado.json.invite_url);
    const primera = await (await Cliente.nuevo()).post(`/api/auth/invites/${token}/accept`, { password: CLAVE });
    expect(primera.estado).toBe(200);
    const segunda = await (await Cliente.nuevo()).post(`/api/auth/invites/${token}/accept`, { password: 'otra-clave-larga-2' });
    expect(segunda.estado).toBeGreaterThanOrEqual(400);
    const entra = await (await Cliente.nuevo()).post('/api/auth/login', { email: 'una-vez@pruebas.example', password: 'otra-clave-larga-2' });
    expect(entra.estado).toBe(401);
  });
});
