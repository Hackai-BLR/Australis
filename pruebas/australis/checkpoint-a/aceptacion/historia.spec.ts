import { expect, test, type Browser, type Page } from '@playwright/test';
import { Cliente, pdf, tokenDeInvitacion } from '../../comun/cliente.ts';
import {
  CLAVE,
  ETICA,
  XLSX,
  correoUnico,
  importarAlumnos,
  listaDeAlumnos,
  secretaria,
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
  let paginaDocente: Page;
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
    await paginaDocente?.context().close();
  });

  test('1. La secretaria entra por la pantalla y crea al docente', async () => {
    const contexto = await navegador.newContext({ baseURL: urlPila() });
    const pagina = await contexto.newPage();
    await ingresar(pagina, CORREO_SECRETARIA, CLAVE_SECRETARIA);
    await pagina.goto('/admin/users');
    await expect(pagina.getByRole('heading', { name: /Usuarios/ }).first()).toBeVisible();
    await pagina.getByRole('button', { name: 'Invitar usuario' }).click();
    const dialogo = pagina.getByRole('dialog');
    await dialogo.getByLabel('Nombre completo').fill('Docente Demo');
    await dialogo.getByLabel('Correo electrónico').fill(correoDocente);
    await dialogo.getByLabel('Rol').selectOption('professor');
    await dialogo.getByRole('button', { name: 'Crear' }).click();
    const enlace = pagina.getByLabel('Enlace', { exact: true });
    await expect(enlace).toBeVisible();
    const invitacion = await enlace.inputValue();
    await expect(pagina.getByRole('cell', { name: correoDocente })).toBeVisible();
    await contexto.close();

    const lista = await sec.get('/api/users');
    expect(lista.json.find((u: any) => u.email === correoDocente)?.role).toBe('professor');
    docente = await Cliente.nuevo();
    const aceptada = await docente.post(`/api/auth/invites/${tokenDeInvitacion(invitacion)}/accept`, { password: CLAVE });
    expect(aceptada.estado, aceptada.texto).toBe(200);
  });

  test('2. El docente entra por la pantalla y crea un campus desde una plantilla', async () => {
    const contexto = await navegador.newContext({ baseURL: urlPila() });
    const pagina = await contexto.newPage();
    paginaDocente = pagina;
    await ingresar(pagina, correoDocente, CLAVE);
    await pagina.goto('/campuses/new');
    await pagina.getByLabel('Nombre del campus').fill('Seminario de Demo');
    await pagina.getByRole('button', { name: 'Crear campus' }).click();
    await expect(pagina).toHaveURL(/\/campuses\/\d+/);
    campus = Number(new URL(pagina.url()).pathname.split('/')[2]);
    await expect(pagina.getByRole('heading', { name: 'Seminario de Demo' }).first()).toBeVisible();

    const campusJson = await docente.get(`/api/campuses/${campus}`);
    expect(campusJson.estado).toBe(200);
    expect(campusJson.json.version).toBe(1);
    expect(campusJson.json.document.sections.length).toBeGreaterThan(0);
  });

  test('3. La IA propone un cambio, el docente lo previsualiza, lo acepta y restaura la revisión anterior', async () => {
    const original = (await docente.get(`/api/campuses/${campus}`)).json;
    const pagina = paginaDocente;
    await pagina.goto(`/campuses/${campus}`);
    await pagina.getByLabel('¿Qué querés cambiar en el campus?').fill(ETICA);
    await pagina.getByRole('button', { name: 'Pedir propuesta' }).click();
    const propuesta = pagina.getByRole('region', { name: 'Propuesta', exact: true });
    await expect(propuesta).toBeVisible({ timeout: 30_000 });
    await expect(propuesta.getByRole('heading', { name: 'Semana de ética profesional' })).toBeVisible();
    await expect(pagina.getByText('Simulado').first()).toBeVisible();
    await propuesta.getByRole('button', { name: 'Ver campus actual' }).click();
    await expect(propuesta.getByRole('heading', { name: 'Semana de ética profesional' })).toHaveCount(0);
    await propuesta.getByRole('button', { name: 'Ver propuesta' }).click();
    expect((await docente.get(`/api/campuses/${campus}`)).json.version).toBe(1);

    await propuesta.getByRole('button', { name: 'Aceptar', exact: true }).click();
    await expect(pagina.getByRole('region', { name: 'Propuesta', exact: true })).toHaveCount(0);
    const aceptado = (await docente.get(`/api/campuses/${campus}`)).json;
    expect(aceptado.version).toBe(2);
    expect(aceptado.document.sections.map((s: any) => s.title)).toContain('Semana de ética profesional');

    await pagina.goto(`/campuses/${campus}/history`);
    await expect(pagina.getByText('Versión 2')).toBeVisible();
    await pagina.getByRole('button', { name: 'Restaurar' }).click();
    await pagina.getByRole('dialog').getByRole('button', { name: 'Restaurar' }).click();
    await expect(pagina.getByText('Versión 3').first()).toBeVisible();
    const restaurada = (await docente.get(`/api/campuses/${campus}`)).json;
    expect(restaurada.version).toBe(3);
    expect(restaurada.document.sections.map((s: any) => s.title)).toEqual(original.document.sections.map((s: any) => s.title));
    const revisiones = (await docente.get(`/api/campuses/${campus}/revisions`)).json;
    expect(revisiones.length).toBe(3);
    expect(revisiones.map((r: any) => r.via)).toContain('ai');

    const uso = await docente.get(`/api/campuses/${campus}/ai/usage`);
    expect(uso.estado).toBe(200);
  });

  test('4. El docente importa alumnos desde un Excel, revisa la vista previa y confirma', async () => {
    const pagina = paginaDocente;
    await pagina.goto(`/campuses/${campus}/students`);
    await pagina.getByRole('button', { name: 'Importar estudiantes' }).click();
    await pagina.getByLabel('Archivo de Excel o CSV').setInputFiles({ name: 'alumnos.xlsx', mimeType: 'application/octet-stream', buffer: XLSX });
    await pagina.getByRole('button', { name: 'Ver vista previa' }).click();
    await expect(pagina.getByText('2 filas leídas, 2 se pueden importar.')).toBeVisible();
    await expect(pagina.getByRole('table', { name: 'Vista previa de la importación' })).toBeVisible();
    await expect(pagina.getByText('30111222')).toHaveCount(0);
    await pagina.getByRole('button', { name: 'Confirmar importación' }).click();
    await expect(pagina.getByText(/Se crearon 2 cuentas nuevas/)).toBeVisible();
    const filas = pagina.getByRole('table', { name: 'Enlaces de invitación' }).getByRole('row');
    const invitaciones = new Map<string, string>();
    for (let i = 1; i < (await filas.count()); i++) {
      const celdas = filas.nth(i).getByRole('cell');
      invitaciones.set((await celdas.nth(1).innerText()).trim(), (await celdas.nth(2).innerText()).trim());
    }
    expect(invitaciones.size).toBe(2);

    await importarAlumnos(docente, campus, listaDeAlumnos(28));
    const miembros = (await docente.get(`/api/campuses/${campus}/members`)).json.filter((m: any) => m.role === 'student');
    expect(miembros.length).toBe(30);
    alumnos = miembros.map((m: any) => ({ correo: m.email, id: m.user_id, invitacion: invitaciones.get(m.email) ?? null }));
  });

  test('5. El docente agrega evaluaciones y pega 30 notas', async () => {
    const pagina = paginaDocente;
    await pagina.goto(`/campuses/${campus}/grades`);
    for (const [nombre, peso] of [['Parcial', '0,6'], ['TP final', '0,4']]) {
      await pagina.getByRole('button', { name: 'Agregar evaluación' }).click();
      const dialogo = pagina.getByRole('dialog');
      await dialogo.getByLabel('Nombre').fill(nombre);
      await dialogo.getByLabel('Peso').fill(peso);
      await dialogo.getByRole('button', { name: 'Guardar' }).click();
      await expect(pagina.getByRole('dialog')).toHaveCount(0);
    }
    await expect(pagina.locator('[data-cell="29-0"]')).toBeVisible();

    const valores = alumnos.map((_, i) => 4 + (i % 7));
    await pagina.locator('[data-cell="0-0"]').evaluate((el, texto) => {
      const datos = new DataTransfer();
      datos.setData('text', texto);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: datos, bubbles: true, cancelable: true }));
    }, valores.join('\n'));
    await expect(pagina.getByText('30 cambios sin guardar.')).toBeVisible();
    await pagina.getByRole('button', { name: 'Guardar', exact: true }).click();
    await expect(pagina.getByText('Sin cambios pendientes.')).toBeVisible();

    await pagina.locator('[data-cell="0-1"]').fill('9');
    await pagina.getByRole('button', { name: 'Guardar', exact: true }).click();
    await expect(pagina.getByText('Sin cambios pendientes.')).toBeVisible();

    const libro = (await docente.get(`/api/campuses/${campus}/gradebook`)).json;
    evaluaciones = libro.items.map((i: any) => i.id);
    expect(libro.items.map((i: any) => i.title)).toEqual(['Parcial', 'TP final']);
    libro.students.forEach((estudianteFila: any, i: number) => {
      const nota = libro.entries.find((e: any) => e.item_id === evaluaciones[0] && e.student_id === estudianteFila.user_id);
      expect(nota?.score, estudianteFila.full_name).toBe(valores[i]);
    });
    expect(libro.entries.filter((e: any) => e.item_id === evaluaciones[1]).map((e: any) => e.score)).toEqual([9]);
    const auditoria = await docente.get(`/api/campuses/${campus}/gradebook/audit`);
    expect(auditoria.estado).toBe(200);
    expect(auditoria.json.length).toBeGreaterThanOrEqual(31);
  });

  test('6. El docente crea la clase de hoy y sube una presentación en PDF', async () => {
    const pagina = paginaDocente;
    await pagina.goto(`/campuses/${campus}/classes`);
    const ahora = await pagina.evaluate(() => {
      const d = new Date();
      const dos = (n: number) => String(n).padStart(2, '0');
      return { fecha: `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}`, hora: `${dos(d.getHours())}:${dos(d.getMinutes())}` };
    });
    await pagina.getByLabel('Título', { exact: true }).fill('Clase 1');
    await pagina.getByLabel('Fecha').fill(ahora.fecha);
    await pagina.getByLabel('Hora').fill(ahora.hora);
    await pagina.getByRole('button', { name: 'Crear clase' }).click();
    await expect(pagina.getByText('Clase 1').first()).toBeVisible();
    const clases = (await docente.get(`/api/campuses/${campus}/classes`)).json;
    expect(clases.length).toBe(1);
    claseId = clases[0].id;
    const clase = (await docente.get(`/api/classes/${claseId}`)).json;
    expect(clase.simulated).toBe(true);
    expect(clase.join_url).toContain('/simulado/zoom/');

    await pagina.goto(`/campuses/${campus}/slides`);
    await pagina.getByLabel('Título (opcional)').fill('Clase 1');
    await pagina.getByLabel('Archivo PDF').setInputFiles({ name: 'clase.pdf', mimeType: 'application/pdf', buffer: pdf(3) });
    await pagina.getByRole('button', { name: 'Subir', exact: true }).click();
    await expect(pagina.getByText(/clase\.pdf · 3 páginas/)).toBeVisible();
    const lista = (await docente.get(`/api/campuses/${campus}/presentations`)).json;
    expect(lista.length).toBe(1);
    presentacion = lista[0];
    expect(presentacion.page_count).toBe(3);
  });

  test('7. Un alumno acepta la invitación, entra y ve el curso, las notas y el botón de la clase de hoy', async () => {
    const lucia = alumnos.find((a) => a.invitacion)!;
    const libro = (await docente.get(`/api/campuses/${campus}/gradebook`)).json;
    const notaLucia = libro.entries.find((e: any) => e.item_id === evaluaciones[0] && e.student_id === lucia.id).score;
    const contexto = await navegador.newContext({ baseURL: urlPila() });
    paginaEstudiante = await contexto.newPage();
    await paginaEstudiante.goto(`/invite/${tokenDeInvitacion(lucia.invitacion!)}`);
    await paginaEstudiante.getByLabel('Contraseña', { exact: true }).fill(CLAVE);
    await paginaEstudiante.getByLabel('Repetir contraseña').fill(CLAVE);
    await paginaEstudiante.getByRole('button', { name: 'Guardar y entrar' }).click();
    await expect(paginaEstudiante.getByRole('button', { name: 'Cerrar sesión' })).toBeVisible();

    await expect(paginaEstudiante.getByText('Clase de hoy').first()).toBeVisible();
    const unirme = paginaEstudiante.getByRole('button', { name: 'Unirme a la clase de hoy' });
    await expect(unirme).toBeVisible();
    const enlace = await paginaEstudiante.getByRole('link').filter({ has: unirme }).getAttribute('href');
    expect(enlace).toContain('/simulado/zoom/');
    await paginaEstudiante.goto(new URL(enlace!).pathname + new URL(enlace!).search);
    await expect(paginaEstudiante.getByText('Reunión de Zoom simulada')).toBeVisible();
    await expect(paginaEstudiante.getByText('Participante')).toBeVisible();
    await paginaEstudiante.goto('/');
    await expect(unirme).toBeVisible();
    await expect(paginaEstudiante.getByText('Simulado').first()).toBeVisible();

    await paginaEstudiante.goto('/grades');
    await expect(paginaEstudiante.getByText('Seminario de Demo')).toBeVisible();
    await expect(paginaEstudiante.getByText('Parcial')).toBeVisible();
    await expect(paginaEstudiante.getByText(/Final:/)).toBeVisible();
    await expect(paginaEstudiante.getByRole('row', { name: /Parcial/ })).toContainText(String(notaLucia));
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
