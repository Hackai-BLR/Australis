import { expect, test, type Browser, type Page } from '@playwright/test';
import { Cliente, tokenDeInvitacion } from '../../comun/cliente.ts';
import {
  CLAVE,
  ETICA,
  XLSX,
  correoUnico,
  crearClaseDeHoy,
  crearEvaluacion,
  importarAlumnos,
  listaDeAlumnos,
  secretaria,
  subirPdf,
} from '../../comun/escenario.ts';
import { CLAVE_SECRETARIA, CORREO_SECRETARIA, urlPila } from '../../comun/pila.ts';

test.describe.configure({ mode: 'serial' });

async function ingresar(pagina: Page, correo: string, clave: string) {
  await pagina.goto('/login');
  await pagina.getByLabel('Correo electrónico').fill(correo);
  await pagina.getByLabel('Contraseña').fill(clave);
  await pagina.getByRole('button', { name: 'Ingresar' }).click();
  await expect(pagina.getByRole('button', { name: 'Cerrar sesión' })).toBeVisible();
}

test.describe('Checkpoint A: la historia de la demo', () => {
  let navegador: Browser;
  let sec: Cliente;
  let docente: Cliente;
  let correoDocente: string;
  let campus: number;
  let alumnos: { correo: string; id: number; invitacion: string | null }[];
  let evaluaciones: number[];
  let claseId: number;
  let presentacion: { id: number; page_count: number };
  let vivo: { id: number };
  let estudiante: Cliente;
  let paginaEstudiante: Page;

  test.beforeAll(async ({ browser }) => {
    navegador = browser;
    sec = await secretaria();
    correoDocente = correoUnico('docente');
  });

  test.afterAll(async () => {
    await sec?.cerrar();
    await docente?.cerrar();
    await estudiante?.cerrar();
  });

  test('1. La secretaria entra por la pantalla y crea al docente', async () => {
    const contexto = await navegador.newContext({ baseURL: urlPila() });
    const pagina = await contexto.newPage();
    await ingresar(pagina, CORREO_SECRETARIA, CLAVE_SECRETARIA);
    await pagina.goto('/admin/users');
    await expect(pagina.getByRole('heading', { name: /Usuarios/ }).first()).toBeVisible();
    await contexto.close();

    const creado = await sec.post('/api/users', { email: correoDocente, full_name: 'Docente Demo', role: 'professor' });
    expect(creado.estado, creado.texto).toBe(201);
    expect(creado.json.user.role).toBe('professor');
    docente = await Cliente.nuevo();
    const aceptada = await docente.post(`/api/auth/invites/${tokenDeInvitacion(creado.json.invite_url)}/accept`, { password: CLAVE });
    expect(aceptada.estado, aceptada.texto).toBe(200);
  });

  test('2. El docente entra por la pantalla y crea un campus desde una plantilla', async () => {
    const contexto = await navegador.newContext({ baseURL: urlPila() });
    const pagina = await contexto.newPage();
    await ingresar(pagina, correoDocente, CLAVE);
    await pagina.goto('/campuses/new');
    await pagina.getByLabel('Nombre del campus').fill('Seminario de Demo');
    await pagina.getByRole('button', { name: 'Crear campus' }).click();
    await expect(pagina).toHaveURL(/\/campuses\/\d+/);
    campus = Number(new URL(pagina.url()).pathname.split('/')[2]);
    await contexto.close();

    const campusJson = await docente.get(`/api/campuses/${campus}`);
    expect(campusJson.estado).toBe(200);
    expect(campusJson.json.version).toBe(1);
    expect(campusJson.json.document.sections.length).toBeGreaterThan(0);
  });

  test('3. La IA propone un cambio, el docente lo previsualiza, lo acepta y restaura la revisión anterior', async () => {
    const original = (await docente.get(`/api/campuses/${campus}`)).json;
    const propuesta = await docente.post(`/api/campuses/${campus}/ai/proposals`, { instruction: ETICA });
    expect(propuesta.estado, propuesta.texto).toBe(201);
    expect(propuesta.json.status).toBe('pending');
    expect(propuesta.json.simulated).toBe(true);
    expect(propuesta.json.preview.sections.length).toBe(original.document.sections.length + 1);
    expect((await docente.get(`/api/campuses/${campus}`)).json.version).toBe(1);

    const aceptada = await docente.post(`/api/campuses/${campus}/ai/proposals/${propuesta.json.id}/accept`, {});
    expect(aceptada.estado, aceptada.texto).toBe(200);
    expect(aceptada.json.version).toBe(2);
    expect(aceptada.json.document.sections.map((s: any) => s.title)).toContain('Semana de ética profesional');

    const restaurada = await docente.post(`/api/campuses/${campus}/revisions/1/restore`, {});
    expect(restaurada.estado, restaurada.texto).toBe(200);
    expect(restaurada.json.version).toBe(3);
    expect(restaurada.json.document.sections.map((s: any) => s.title)).toEqual(original.document.sections.map((s: any) => s.title));
    const revisiones = (await docente.get(`/api/campuses/${campus}/revisions`)).json;
    expect(revisiones.length).toBe(3);
    expect(revisiones.map((r: any) => r.via)).toContain('ai');

    const uso = await docente.get(`/api/campuses/${campus}/ai/usage`);
    expect(uso.estado).toBe(200);
  });

  test('4. El docente importa alumnos desde un Excel, revisa la vista previa y confirma', async () => {
    const vista = await docente.subir(`/api/campuses/${campus}/roster/imports`, {
      file: { name: 'alumnos.xlsx', mimeType: 'application/octet-stream', buffer: XLSX },
    });
    expect(vista.estado, vista.texto).toBe(201);
    expect(vista.json.total).toBe(2);
    expect(vista.json.importable).toBe(2);
    expect(vista.texto).not.toContain('30111222');

    const confirmada = await docente.post(`/api/campuses/${campus}/roster/imports/${vista.json.id}/confirm`, {});
    expect(confirmada.estado, confirmada.texto).toBe(200);
    expect(confirmada.json.created).toBe(2);
    expect(confirmada.json.invites.length).toBe(2);

    await importarAlumnos(docente, campus, listaDeAlumnos(28));
    const miembros = (await docente.get(`/api/campuses/${campus}/members`)).json.filter((m: any) => m.role === 'student');
    expect(miembros.length).toBe(30);
    const invitaciones = new Map<string, string>(confirmada.json.invites.map((i: any) => [i.email, i.invite_url]));
    alumnos = miembros.map((m: any) => ({ correo: m.email, id: m.user_id, invitacion: invitaciones.get(m.email) ?? null }));
  });

  test('5. El docente agrega evaluaciones y pega 30 notas', async () => {
    evaluaciones = [await crearEvaluacion(docente, campus, 'Parcial', 0.6), await crearEvaluacion(docente, campus, 'TP final', 0.4)];
    const notas = alumnos.map((a, i) => ({ item_id: evaluaciones[0], student_id: a.id, score: 4 + (i % 7) }));
    const guardadas = await docente.put(`/api/campuses/${campus}/gradebook/entries`, { entries: notas });
    expect(guardadas.estado, guardadas.texto).toBe(200);
    expect(guardadas.json.changed).toBe(30);
    await docente.put(`/api/campuses/${campus}/gradebook/entries`, {
      entries: [{ item_id: evaluaciones[1], student_id: alumnos[0].id, score: 9 }],
    });
    const libro = await docente.get(`/api/campuses/${campus}/gradebook`);
    expect(libro.estado).toBe(200);
    const auditoria = await docente.get(`/api/campuses/${campus}/gradebook/audit`);
    expect(auditoria.estado).toBe(200);
    expect(auditoria.json.length).toBeGreaterThanOrEqual(31);
  });

  test('6. El docente crea la clase de hoy y sube una presentación en PDF', async () => {
    claseId = await crearClaseDeHoy(docente, campus);
    const clase = (await docente.get(`/api/classes/${claseId}`)).json;
    expect(clase.simulated).toBe(true);
    expect(clase.join_url).toContain('/simulado/zoom/');
    presentacion = await subirPdf(docente, campus, 3);
    expect(presentacion.page_count).toBe(3);
  });

  test('7. Un alumno acepta la invitación, entra y ve el curso, las notas y el botón de la clase de hoy', async () => {
    const lucia = alumnos.find((a) => a.invitacion)!;
    const contexto = await navegador.newContext({ baseURL: urlPila() });
    paginaEstudiante = await contexto.newPage();
    await paginaEstudiante.goto(`/invite/${tokenDeInvitacion(lucia.invitacion!)}`);
    await paginaEstudiante.getByLabel('Contraseña', { exact: true }).fill(CLAVE);
    await paginaEstudiante.getByLabel('Repetir contraseña').fill(CLAVE);
    await paginaEstudiante.getByRole('button', { name: 'Guardar y entrar' }).click();
    await expect(paginaEstudiante.getByRole('button', { name: 'Cerrar sesión' })).toBeVisible();

    await expect(paginaEstudiante.getByText('Clase de hoy').first()).toBeVisible();
    await expect(paginaEstudiante.getByRole('button', { name: 'Unirme a la clase de hoy' })).toBeVisible();
    await expect(paginaEstudiante.getByText('Simulado').first()).toBeVisible();

    await paginaEstudiante.goto('/grades');
    await expect(paginaEstudiante.getByText('Seminario de Demo')).toBeVisible();
    await expect(paginaEstudiante.getByText('Parcial')).toBeVisible();
    await expect(paginaEstudiante.getByText(/Final:/)).toBeVisible();
    await expect(paginaEstudiante.getByText(/no fue confirmada/)).toBeVisible();

    estudiante = await Cliente.nuevo();
    await estudiante.post('/api/auth/login', { email: lucia.correo, password: CLAVE });
    const propias = await estudiante.get('/api/grades/mine');
    expect(propias.estado).toBe(200);
    expect(propias.json.courses.length).toBe(1);
  });

  test('8. El docente presenta y la página del alumno sigue cada diapositiva, se despega y vuelve al vivo', async () => {
    const proyeccion = await docente.post(`/api/presentations/${presentacion.id}/live`, {});
    expect(proyeccion.estado, proyeccion.texto).toBe(201);
    vivo = proyeccion.json;

    await paginaEstudiante.goto(`/campuses/${campus}/slides`);
    await expect(paginaEstudiante.getByText('Siguiendo al docente')).toBeVisible();
    await expect(paginaEstudiante.getByText('Página 1 de 3')).toBeVisible();

    expect((await docente.post(`/api/live/${vivo.id}/goto`, { page: 2 })).estado).toBe(200);
    await expect(paginaEstudiante.getByText('Página 2 de 3')).toBeVisible();

    await paginaEstudiante.getByRole('button', { name: 'Siguiente' }).click();
    await expect(paginaEstudiante.getByText('Página 3 de 3')).toBeVisible();
    await expect(paginaEstudiante.getByRole('button', { name: 'Volver al vivo' })).toBeVisible();

    await paginaEstudiante.getByRole('button', { name: 'Volver al vivo' }).click();
    await expect(paginaEstudiante.getByText('Página 2 de 3')).toBeVisible();
    await expect(paginaEstudiante.getByText('Siguiendo al docente')).toBeVisible();
  });

  test('9. El docente termina la clase y aparecen la grabación y la transcripción', async () => {
    expect((await docente.post(`/api/live/${vivo.id}/end`, {})).estado).toBe(200);
    const terminada = await docente.post(`/api/classes/${claseId}/end`, {});
    expect(terminada.estado, terminada.texto).toBe(200);
    expect(terminada.json.recording_status).toBe('transcript_ready');

    await paginaEstudiante.goto(`/classes/${claseId}`);
    await expect(paginaEstudiante.getByText('Grabación y transcripción').first()).toBeVisible();
    await expect(paginaEstudiante.getByText('Simulado').first()).toBeVisible();
    await expect(paginaEstudiante.getByLabel('Transcripción').first()).toBeVisible();

    const grabacion = await estudiante.get(`/api/classes/${claseId}/recording`);
    expect(grabacion.json.simulated).toBe(true);
    const transcripcion = await estudiante.get(`/api/classes/${claseId}/transcript`);
    expect(transcripcion.estado).toBe(200);
  });
});
