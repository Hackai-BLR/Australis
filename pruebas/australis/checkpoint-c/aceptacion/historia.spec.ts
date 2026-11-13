import fs from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { entrar, origenDe, paginaDe, type Sesion } from '../../comun/escenario-b.ts';
import { ADMIN_AUSTRAL, PROFE_AUSTRAL } from '../../comun/datos-b.ts';
import {
  alumnosDePrueba,
  cargarNotas,
  crearCampusConAlumnos,
  crearClase,
  subirPdfPorPantalla,
  type Alumno,
  type CampusC,
} from '../../comun/escenario-c.ts';

test.describe.configure({ mode: 'serial' });

const ALUMNOS: Alumno[] = alumnosDePrueba(5);
const NOMBRE_CAMPUS = 'Seminario de registros';
const TITULO_CLASE = 'Clase de hoy de registros';
const NOTA_1 = 'La idea central es separar el dato del registro.';
const NOTA_2 = 'Repasar el ejemplo del segunda diapositiva antes del parcial.';

let profe: Sesion;
let admin: Sesion;
let alumna: Sesion;
let campus: CampusC;
let claseId = 0;
let presentacionId = 0;
let corregido: { id: number; nombre: string } = { id: 0, nombre: '' };

async function paginaDeAlumna(browser: Parameters<typeof paginaDe>[0]) {
  return paginaDe(browser, alumna);
}

async function hoja(claseNumero: number) {
  const r = await profe.campus('GET', `/api/classes/${claseNumero}/attendance`);
  expect(r.estado, r.texto).toBe(200);
  return r.json;
}

async function abrirClase(pagina: Page, id: number) {
  await pagina.goto(`${origenDe('campus')}/classes/${id}`);
  await expect(pagina.getByRole('heading', { name: TITULO_CLASE })).toBeVisible();
}

test.describe('checkpoint C: la historia de los registros con el núcleo, Australis y el modelo falso juntos', () => {
  test('preparación: un campus con cinco alumnos, la clase de hoy y notas cargadas', async () => {
    profe = await entrar(PROFE_AUSTRAL);
    admin = await entrar(ADMIN_AUSTRAL);
    campus = await crearCampusConAlumnos(profe, NOMBRE_CAMPUS, ALUMNOS);
    claseId = await crearClase(profe, campus, TITULO_CLASE, 5, 180);
    await cargarNotas(profe, campus, (i) => 6 + i);
    alumna = await entrar(ALUMNOS[0].correo);
    const propio = await alumna.campus('GET', `/api/campuses/${campus.australis}`);
    expect(propio.estado, propio.texto).toBe(200);
    expect(propio.json.access).toBe('view');
  });

  test('1. el inicio de la alumna muestra su próximo paso: la clase de hoy', async ({ browser }) => {
    const { ctx, pagina } = await paginaDeAlumna(browser);
    await pagina.goto(`${origenDe('campus')}/`);
    const tarjeta = pagina.locator('section.au-card').filter({ has: pagina.getByRole('heading', { name: 'Tu próximo paso' }) });
    await expect(tarjeta).toBeVisible();
    await expect(tarjeta).toContainText(TITULO_CLASE);
    await expect(tarjeta).toContainText(NOMBRE_CAMPUS);
    await expect(tarjeta.getByRole('button', { name: 'Unirme a la clase' })).toBeVisible();
    await expect(pagina.getByText('Estás al día')).toHaveCount(0);
    await ctx.close();
  });

  test('2. la profesora termina la clase, toma la asistencia de la sesión y corrige a una alumna con un motivo', async ({ browser }) => {
    const { ctx, pagina } = await paginaDe(browser, profe);
    await abrirClase(pagina, claseId);
    await pagina.getByRole('button', { name: 'Marcar como finalizada' }).click();
    await expect(pagina.getByText('Finalizada', { exact: true }).first()).toBeVisible();

    await pagina.getByRole('button', { name: 'Tomar de la sesión' }).click();
    await expect(pagina.getByText(/Asistencia tomada de la sesión/)).toBeVisible();
    await expect(pagina.getByText(/Invitado externo \(simulado\)/)).toBeVisible();

    const tomada = await hoja(claseId);
    expect(tomada.rows).toHaveLength(ALUMNOS.length);
    expect(tomada.rows.every((f: any) => f.status && f.source === 'session')).toBe(true);
    const ausente = tomada.rows.find((f: any) => f.status === 'absent');
    expect(ausente, 'la lista simulada deja a una alumna ausente').toBeTruthy();
    corregido = { id: ausente.user_id, nombre: ausente.full_name };

    const selector = pagina.getByLabel(`Estado de ${corregido.nombre}`);
    await expect(selector).toHaveValue('absent');
    await selector.selectOption('excused');
    await expect(pagina.getByRole('button', { name: 'Guardar asistencia' })).toBeDisabled();
    await pagina.getByLabel('Motivo del cambio').fill('Presentó certificado médico');
    await expect(pagina.getByRole('button', { name: 'Guardar asistencia' })).toBeEnabled();
    await pagina.getByRole('button', { name: 'Guardar asistencia' }).click();
    await expect(pagina.getByText('Asistencia guardada.')).toBeVisible();

    const corregida = await hoja(claseId);
    const fila = corregida.rows.find((f: any) => f.user_id === corregido.id);
    expect(fila.status).toBe('excused');
    expect(fila.source).toBe('manual');
    expect(fila.reason).toBe('Presentó certificado médico');
    expect(corregida.rows.filter((f: any) => f.source === 'session').length).toBe(ALUMNOS.length - 1);
    await ctx.close();
  });

  test('2 (alumna). cada alumna ve solo su propia asistencia y no tiene cómo cambiarla', async ({ browser }) => {
    const afectada = ALUMNOS.find((a) => a.nombre === corregido.nombre)!;
    const sesion = await entrar(afectada.correo);
    const { ctx, pagina } = await paginaDe(browser, sesion);
    await abrirClase(pagina, claseId);
    await expect(pagina.getByRole('heading', { name: 'Mi asistencia' })).toBeVisible();
    await expect(pagina.getByText('Justificado')).toBeVisible();
    await expect(pagina.getByText('Motivo: Presentó certificado médico')).toBeVisible();
    await expect(pagina.getByRole('button', { name: 'Guardar asistencia' })).toHaveCount(0);
    await expect(pagina.getByRole('button', { name: 'Tomar de la sesión' })).toHaveCount(0);
    const propia = await sesion.campus('GET', `/api/classes/${claseId}/attendance`);
    expect(propia.json.rows).toHaveLength(1);
    expect(propia.json.rows[0].user_id).toBe(corregido.id);
    await ctx.close();
  });

  test('3. la profesora genera el resumen de la clase, lo edita y lo aprueba; recién entonces la alumna lo ve', async ({ browser }) => {
    const propia = await paginaDe(browser, profe);
    const { ctx, pagina } = propia;
    await abrirClase(pagina, claseId);
    await expect(pagina.getByRole('heading', { name: 'Resumen de la clase' })).toBeVisible();
    await pagina.getByRole('button', { name: 'Generar borrador' }).click();
    const texto = pagina.getByLabel('Texto del resumen');
    await expect(texto).toBeVisible();
    await expect(pagina.getByText('Borrador: los estudiantes todavía no lo ven')).toBeVisible();
    await expect(pagina.getByText('Simulado').first()).toBeVisible();
    await expect(pagina.getByText('Generaciones de hoy: 1 de')).toBeVisible();
    const generado = await texto.inputValue();
    expect(generado.trim().length).toBeGreaterThan(0);

    const delAlumno = await paginaDeAlumna(browser);
    await abrirClase(delAlumno.pagina, claseId);
    await expect(delAlumno.pagina.getByText('Todavía no hay resumen')).toBeVisible();
    await expect(delAlumno.pagina.getByText(generado.slice(0, 40))).toHaveCount(0);
    const oculto = await alumna.campus('GET', `/api/classes/${claseId}/summary`);
    expect(oculto.json.status).toBe('none');
    expect(oculto.json.body).toBeNull();

    const editado = 'Puntos clave: el registro nace en la clase. Tarea: traer el caso resuelto.';
    await texto.fill(editado);
    await expect(pagina.getByRole('button', { name: 'Aprobar y publicar' })).toBeDisabled();
    await pagina.getByRole('button', { name: 'Guardar cambios' }).click();
    await expect(pagina.getByRole('button', { name: 'Aprobar y publicar' })).toBeEnabled();
    await delAlumno.pagina.reload();
    await expect(delAlumno.pagina.getByText('Todavía no hay resumen')).toBeVisible();

    await pagina.getByRole('button', { name: 'Aprobar y publicar' }).click();
    await expect(pagina.getByText('Aprobado: los estudiantes lo ven')).toBeVisible();

    await delAlumno.pagina.reload();
    await expect(delAlumno.pagina.getByText(editado)).toBeVisible();
    await expect(delAlumno.pagina.getByText('Todavía no hay resumen')).toHaveCount(0);
    const visible = await alumna.campus('GET', `/api/classes/${claseId}/summary`);
    expect(visible.json.status).toBe('approved');
    expect(visible.json.body).toBe(editado);
    await delAlumno.ctx.close();
    await ctx.close();
  });

  test('4. la alumna escribe notas en dos diapositivas y las exporta', async ({ browser }) => {
    const docente = await subirPdfPorPantalla(browser, profe, campus, 'Presentación de registros', 3);
    presentacionId = docente.presentacion;
    await docente.pagina.getByRole('button', { name: 'Proyectar' }).click();
    await expect(docente.pagina.getByText('Proyectando')).toBeVisible();

    const { ctx, pagina } = await paginaDeAlumna(browser);
    await pagina.goto(`${origenDe('campus')}/campuses/${campus.australis}/slides`);
    await expect(pagina.getByText('Siguiendo al docente')).toBeVisible();
    await expect(pagina.getByText('Página 1 de 3')).toBeVisible();
    await expect(pagina.getByText('Solo vos ves estas notas.')).toBeVisible();
    await pagina.getByLabel('Mis notas de la página 1').fill(NOTA_1);
    await pagina.getByRole('button', { name: 'Siguiente' }).click();
    await expect(pagina.getByText('Página 2 de 3')).toBeVisible();
    await pagina.getByLabel('Mis notas de la página 2').fill(NOTA_2);

    const [descarga] = await Promise.all([pagina.waitForEvent('download'), pagina.getByRole('button', { name: 'Exportar mis notas (.txt)' }).click()]);
    const ruta = await descarga.path();
    const contenido = fs.readFileSync(ruta, 'utf8');
    expect(contenido).toContain('Notas: Presentación de registros');
    expect(contenido).toContain('--- Página 1 ---');
    expect(contenido).toContain(NOTA_1);
    expect(contenido).toContain('--- Página 2 ---');
    expect(contenido).toContain(NOTA_2);
    expect(contenido.indexOf(NOTA_1)).toBeLessThan(contenido.indexOf(NOTA_2));

    const guardadas = await alumna.campus('GET', `/api/presentations/${presentacionId}/notes`);
    expect(guardadas.json.map((n: any) => [n.page, n.body])).toEqual([[1, NOTA_1], [2, NOTA_2]]);
    const delDocente = await profe.campus('GET', `/api/presentations/${presentacionId}/notes`);
    expect(delDocente.json).toEqual([]);
    await ctx.close();
    await docente.ctx.close();
  });

  test('5. la profesora cambia la escala de calificaciones solo para este campus y envía las notas a secretaría', async ({ browser }) => {
    const { ctx, pagina } = await paginaDe(browser, profe);
    await pagina.goto(`${origenDe('campus')}/campuses/${campus.australis}/settings`);
    await expect(pagina.getByRole('heading', { name: 'Configuración del campus' })).toBeVisible();
    await expect(pagina.getByText('De 1 a 10, aprueba con 4')).toBeVisible();
    await expect(pagina.getByText('Sin confirmar').first()).toBeVisible();
    await pagina.getByRole('button', { name: 'Modificar' }).first().click();
    const dialogo = pagina.getByRole('dialog');
    await dialogo.getByLabel('Nota mínima').fill('0');
    await dialogo.getByLabel('Nota máxima').fill('100');
    await dialogo.getByLabel('Nota de aprobación').fill('60');
    await dialogo.getByLabel('Motivo del cambio').fill('El programa califica sobre cien');
    await dialogo.getByRole('button', { name: 'Guardar' }).click();
    await expect(pagina.getByText('Se guardó el cambio.')).toBeVisible();
    await expect(pagina.getByText('De 0 a 100, aprueba con 60').first()).toBeVisible();
    await expect(pagina.getByText('Valor de este campus')).toBeVisible();
    await expect(pagina.getByText('Motivo: El programa califica sobre cien')).toBeVisible();

    const propias = await alumna.campus('GET', '/api/grades/mine');
    expect(propias.json.courses.find((c: any) => c.campus_id === campus.australis).scale.pass).toBe(60);
    const otro = await profe.post('/api/cursos-modulos', { nombre: 'Campus sin cambios de escala' });
    expect(otro.estado, otro.texto).toBe(201);
    const ajustesOtro = await profe.campus('GET', `/api/campuses/${otro.json.campus_externo}/settings`);
    expect(ajustesOtro.json.settings.find((s: any) => s.key === 'grading.scale').source).toBe('global');

    await pagina.goto(`${origenDe('campus')}/campuses/${campus.australis}/grades`);
    await expect(pagina.getByText('Borrador', { exact: true }).first()).toBeVisible();
    await expect(pagina.getByText(/0 a 100, aprobación 60/)).toBeVisible();
    await pagina.getByRole('button', { name: 'Enviar notas a secretaría' }).click();
    await expect(pagina.getByText('Enviadas a secretaría', { exact: true }).first()).toBeVisible();
    await expect(pagina.getByText('Esperando la verificación de secretaría.')).toBeVisible();
    await ctx.close();

    const estado = await profe.campus('GET', `/api/campuses/${campus.australis}/grades/submission`);
    expect(estado.json.status).toBe('sent');
  });

  test('6. la secretaría encuentra el campus en la lista de todos los campus, revisa las notas y las devuelve con una nota', async ({ browser }) => {
    const { ctx, pagina } = await paginaDe(browser, admin);
    await pagina.goto(`${origenDe('campus')}/`);
    await pagina.getByRole('link', { name: 'Directorio' }).click();
    await expect(pagina.getByRole('heading', { name: 'Todos los campus' })).toBeVisible();
    await pagina.getByLabel('Buscar').fill('registros');
    const enlace = pagina.getByRole('link', { name: NOMBRE_CAMPUS });
    await expect(enlace).toBeVisible();
    await expect(pagina.getByRole('row', { name: new RegExp(NOMBRE_CAMPUS) })).toContainText(String(ALUMNOS.length));
    await enlace.click();
    await pagina.getByRole('link', { name: 'Calificaciones' }).click();
    await expect(pagina.getByText('Enviadas a secretaría', { exact: true }).first()).toBeVisible();
    await expect(pagina.getByText(/0 a 100, aprobación 60/)).toBeVisible();
    await expect(pagina.getByRole('button', { name: 'Marcar como verificadas' })).toBeVisible();
    await expect(pagina.getByRole('button', { name: 'Devolver al docente' })).toBeDisabled();
    await pagina.getByLabel('Nota para devolver las notas al docente').fill('Falta cargar la recuperación del segundo parcial');
    await pagina.getByRole('button', { name: 'Devolver al docente' }).click();
    await expect(pagina.getByText('Borrador', { exact: true }).first()).toBeVisible();
    await expect(pagina.getByText('Secretaría devolvió las notas:')).toBeVisible();
    await ctx.close();

    const lista = await admin.campus('GET', '/api/grades/submissions');
    expect(lista.estado, lista.texto).toBe(200);
    const fila = lista.json.campuses.find((c: any) => c.campus_id === campus.australis);
    expect(fila.status).toBe('draft');
    expect(fila.note).toBe('Falta cargar la recuperación del segundo parcial');

    const delDocente = await paginaDe(browser, profe);
    await delDocente.pagina.goto(`${origenDe('campus')}/campuses/${campus.australis}/grades`);
    await expect(delDocente.pagina.getByText('Falta cargar la recuperación del segundo parcial')).toBeVisible();
    await expect(delDocente.pagina.getByRole('button', { name: 'Enviar notas a secretaría' })).toBeVisible();
    await delDocente.ctx.close();

    const auditoria = await admin.campus('GET', `/api/campuses/${campus.australis}/gradebook/audit`);
    expect(auditoria.estado, auditoria.texto).toBe(200);
  });

  test('7. una alumna reporta un problema desde la página del campus y la profesora lo ve en su bandeja', async ({ browser }) => {
    const texto = 'No puedo abrir el material de la semana dos';
    const { ctx, pagina } = await paginaDeAlumna(browser);
    await pagina.goto(`${origenDe('campus')}/campuses/${campus.australis}`);
    await pagina.getByRole('button', { name: 'Reportar un problema' }).click();
    const dialogo = pagina.getByRole('dialog');
    await expect(dialogo).toContainText(`/campuses/${campus.australis}`);
    await dialogo.getByLabel('¿Qué pasó?').fill(texto);
    await dialogo.getByRole('button', { name: 'Enviar' }).click();
    await expect(dialogo.getByText(/Lo van a ver los profesores de este campus/)).toBeVisible();
    await ctx.close();

    const delDocente = await paginaDe(browser, profe);
    await delDocente.pagina.goto(`${origenDe('campus')}/`);
    await delDocente.pagina.getByRole('link', { name: 'Reportes' }).click();
    await expect(delDocente.pagina.getByRole('heading', { name: 'Reportes' })).toBeVisible();
    await expect(delDocente.pagina.getByText(texto)).toBeVisible();
    await expect(delDocente.pagina.getByText(ALUMNOS[0].nombre)).toBeVisible();
    await delDocente.pagina.getByRole('button', { name: 'Marcar como resuelto' }).first().click();
    await expect(delDocente.pagina.getByText(texto)).toHaveCount(0);
    await delDocente.pagina.getByRole('button', { name: 'Resueltos' }).click();
    await expect(delDocente.pagina.getByText(texto)).toBeVisible();
    await delDocente.ctx.close();

    const abiertos = await profe.campus('GET', '/api/support/reports?status=open');
    expect(abiertos.json.some((r: any) => r.body === texto)).toBe(false);
  });
});
