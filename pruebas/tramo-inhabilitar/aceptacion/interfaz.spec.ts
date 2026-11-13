import type { Page } from '@playwright/test';
import { crearTestTramo, expect, ADMIN_AUSTRAL, ADMIN2_AUSTRAL, OWNER, PROFE_AUSTRAL, PROFE2_AUSTRAL } from '../fixtures.ts';
import { esperarCodigo } from '../../comun/sesion.ts';
import type { Nucleo } from '../../comun/nucleo.ts';
import {
  AUSTRAL,
  archivar,
  cuentaNueva,
  cursoDePrueba,
  estadoCuenta,
  fila,
  idUniversidad,
  idUsuario,
  sesion,
  sesionReautenticada,
  universidadNueva,
} from '../lib.ts';
import { MODO_CODIGO } from '../../comun/nucleo.ts';

const test = crearTestTramo({ entorno: MODO_CODIGO });

async function reautenticarEnDialogo(page: Page, nucleo: Nucleo, email: string, desde: number) {
  await expect(page.locator('#reaut-digitos input')).toHaveCount(6);
  const codigo = await esperarCodigo(nucleo, email, desde);
  await page.locator('#reaut-digitos input').first().click();
  await page.keyboard.type(codigo);
  await expect(page.locator('#reaut-digitos')).toBeHidden();
}

async function confirmar(page: Page, verbo: RegExp) {
  const boton = page.locator('[data-confirmar]');
  await expect(boton).toBeVisible();
  await expect(boton).toHaveText(verbo);
  await boton.click();
}

test.describe('interfaz: administrador', () => {
  test('Personas: estado, filtro, suspender, reactivar y dar de baja con confirmación y reautenticación', async ({ paginaComo, nucleo }) => {
    const persona = await cuentaNueva(nucleo, 'austral.edu.ar', 'ui');
    const otra = await cuentaNueva(nucleo, 'austral.edu.ar', 'ui');
    const admin = await sesion(nucleo, ADMIN_AUSTRAL);
    const page = await paginaComo(admin);
    await page.goto(nucleo.url(undefined, '/administracion'));
    await expect(page.locator('#tabs-admin [data-tab="personas"]')).toBeVisible();

    const filaPersona = page.locator(`tr[data-persona="${persona.id}"]`);
    await expect(filaPersona).toBeVisible();
    await expect(filaPersona.locator('td.estado')).toContainText('Activa');
    await expect(page.locator(`tr[data-persona="${idUsuario(nucleo, 'cpendiente@austral.edu.ar')}"] td.estado`)).toContainText('Pendiente');

    for (const email of [ADMIN_AUSTRAL, ADMIN2_AUSTRAL, 'rectora@austral.edu.ar']) {
      const f = page.locator(`tr[data-persona="${idUsuario(nucleo, email)}"]`);
      await expect(f).toBeVisible();
      await expect(f.locator('[data-suspender], [data-baja], [data-reactivar]')).toHaveCount(0);
    }

    await filaPersona.locator(`[data-suspender="${persona.id}"]`).click();
    await expect(page.locator('#modal')).toContainText('Suspender');
    await page.locator('[data-cerrarmodal]').click();
    expect(estadoCuenta(nucleo, persona.id).suspendida_en).toBeNull();

    await filaPersona.locator(`[data-suspender="${persona.id}"]`).click();
    const desde = nucleo.cantidadMails();
    await confirmar(page, /Suspender/);
    await reautenticarEnDialogo(page, nucleo, ADMIN_AUSTRAL, desde);
    await expect(filaPersona.locator('td.estado')).toContainText('Suspendida');
    await expect(filaPersona.locator(`[data-reactivar="${persona.id}"]`)).toBeVisible();
    await expect(filaPersona.locator(`[data-suspender="${persona.id}"]`)).toHaveCount(0);
    expect(estadoCuenta(nucleo, persona.id).suspendida_en).toBeTruthy();
    expect((await persona.cliente.get('/api/yo')).status).toBe(401);

    await page.locator('[data-estado="suspendidas"]').click();
    await expect(filaPersona).toBeVisible();
    await expect(page.locator(`tr[data-persona="${otra.id}"]`)).toHaveCount(0);
    await expect(page.locator(`tr[data-persona="${idUsuario(nucleo, ADMIN_AUSTRAL)}"]`)).toHaveCount(0);
    await page.locator('[data-estado="activas"]').click();
    await expect(page.locator(`tr[data-persona="${otra.id}"]`)).toBeVisible();
    await expect(filaPersona).toHaveCount(0);
    await page.locator('[data-estado="todas"]').click();

    await filaPersona.locator(`[data-reactivar="${persona.id}"]`).click();
    await confirmar(page, /Reactivar/);
    await expect(filaPersona.locator('td.estado')).toContainText('Activa');
    expect(estadoCuenta(nucleo, persona.id).suspendida_en).toBeNull();

    const curso = cursoDePrueba(nucleo, { universidad: idUniversidad(nucleo, AUSTRAL), dueno: PROFE_AUSTRAL, alumnos: [otra.email] });
    const filaOtra = page.locator(`tr[data-persona="${otra.id}"]`);
    await filaOtra.locator(`[data-baja="${otra.id}"]`).click();
    await expect(page.locator('#modal')).toContainText(/baja/i);
    await confirmar(page, /Dar de baja/);
    await expect(filaOtra.locator('td.estado')).toContainText('Suspendida');
    await expect(filaOtra).toContainText('Baja');
    expect(estadoCuenta(nucleo, otra.id).baja_en).toBeTruthy();
    expect(fila(nucleo, 'SELECT COUNT(*) AS n FROM inscripciones WHERE usuario_id = ? AND curso_id = ?', otra.id, curso).n).toBe(0);
  });

  test('Cursos: archivar y desarchivar con confirmación y reautenticación', async ({ paginaComo, nucleo }) => {
    const alumno = await cuentaNueva(nucleo);
    const curso = cursoDePrueba(nucleo, { universidad: idUniversidad(nucleo, AUSTRAL), dueno: PROFE_AUSTRAL, alumnos: [alumno.email] });
    const admin = await sesion(nucleo, ADMIN_AUSTRAL);
    const page = await paginaComo(admin);
    await page.goto(nucleo.url(undefined, '/administracion'));
    await page.locator('#tabs-admin [data-tab="cursos"]').click();
    const f = page.locator(`tr[data-fila-curso="${curso}"]`);
    await expect(f).toBeVisible();
    await expect(f).not.toContainText('Archivado');

    await f.locator(`[data-archivar="${curso}"]`).click();
    const desde = nucleo.cantidadMails();
    await confirmar(page, /Archivar/);
    await reautenticarEnDialogo(page, nucleo, ADMIN_AUSTRAL, desde);
    await expect(f).toContainText('Archivado');
    await expect(f.locator(`[data-desarchivar="${curso}"]`)).toBeVisible();
    expect(fila(nucleo, 'SELECT archivado_en FROM cursos WHERE id = ?', curso).archivado_en).toBeTruthy();
    expect((await alumno.cliente.get('/api/mis-cursos')).json.cursos.map((c: any) => c.id)).not.toContain(curso);

    await f.locator(`[data-desarchivar="${curso}"]`).click();
    await confirmar(page, /Desarchivar/);
    await expect(f).not.toContainText('Archivado');
    await expect(f.locator(`[data-archivar="${curso}"]`)).toBeVisible();
    expect(fila(nucleo, 'SELECT archivado_en FROM cursos WHERE id = ?', curso).archivado_en).toBeNull();
  });
});

test.describe('interfaz: owner', () => {
  test('Universidades: deshabilitar y rehabilitar con confirmación y reautenticación', async ({ paginaComo, nucleo }) => {
    const preparar = await sesionReautenticada(nucleo, OWNER);
    const uni = await universidadNueva(preparar);
    const owner = await sesion(nucleo, OWNER);
    const page = await paginaComo(owner);
    await page.goto(nucleo.url(undefined, '/owner'));
    await expect(page.locator('#tabs-owner [data-otab="unis"]')).toBeVisible();
    const f = page.locator(`tr[data-universidad="${uni.id}"]`);
    await expect(f).toBeVisible();
    await expect(f).not.toContainText('Deshabilitada');

    await f.locator(`[data-deshabilitar="${uni.id}"]`).click();
    await expect(page.locator('#modal')).toContainText(uni.nombre);
    const desde = nucleo.cantidadMails();
    await confirmar(page, /Deshabilitar/);
    await reautenticarEnDialogo(page, nucleo, OWNER, desde);
    await expect(f).toContainText('Deshabilitada');
    await expect(f.locator(`[data-rehabilitar="${uni.id}"]`)).toBeVisible();
    expect(fila(nucleo, 'SELECT deshabilitada_en FROM universidades WHERE id = ?', uni.id).deshabilitada_en).toBeTruthy();

    await f.locator(`[data-rehabilitar="${uni.id}"]`).click();
    await confirmar(page, /Rehabilitar/);
    await expect(f).not.toContainText('Deshabilitada');
    await expect(f.locator(`[data-deshabilitar="${uni.id}"]`)).toBeVisible();
    expect(fila(nucleo, 'SELECT deshabilitada_en FROM universidades WHERE id = ?', uni.id).deshabilitada_en).toBeNull();
  });
});

test.describe('interfaz: curso archivado', () => {
  test('el dueño archiva desde el menú del curso y lo desarchiva', async ({ paginaComo, nucleo }) => {
    const curso = cursoDePrueba(nucleo, { universidad: idUniversidad(nucleo, AUSTRAL), dueno: PROFE_AUSTRAL });
    const dueno = await sesion(nucleo, PROFE_AUSTRAL);
    const page = await paginaComo(dueno);
    await page.goto(nucleo.url(curso));
    await expect(page.locator('iframe#curso')).toBeVisible();
    await page.locator('[data-menu="m-cursos"]').click();
    await page.locator('#m-cursos [data-accion="archivar-curso"]').click();
    const desde = nucleo.cantidadMails();
    await confirmar(page, /Archivar/);
    await reautenticarEnDialogo(page, nucleo, PROFE_AUSTRAL, desde);
    await expect(page.locator('#curso-archivado')).toBeVisible();
    await expect(page.locator('iframe#curso')).toHaveCount(0);
    await expect(page.getByText('Curso archivado').first()).toBeVisible();
    expect(fila(nucleo, 'SELECT archivado_en FROM cursos WHERE id = ?', curso).archivado_en).toBeTruthy();

    await page.locator('[data-menu="m-cursos"]').click();
    await expect(page.locator('#m-cursos [data-accion="archivar-curso"]')).toHaveCount(0);
    await page.locator('#m-cursos [data-accion="desarchivar-curso"]').click();
    await confirmar(page, /Desarchivar/);
    await expect(page.locator('#curso-archivado')).toHaveCount(0);
    await expect(page.locator('iframe#curso')).toBeVisible();
    expect(fila(nucleo, 'SELECT archivado_en FROM cursos WHERE id = ?', curso).archivado_en).toBeNull();
  });

  test('profesores y alumnos no ven la acción de archivar', async ({ paginaComo, nucleo }) => {
    const alumno = await cuentaNueva(nucleo);
    const curso = cursoDePrueba(nucleo, { universidad: idUniversidad(nucleo, AUSTRAL), dueno: PROFE_AUSTRAL, profesores: [PROFE2_AUSTRAL], alumnos: [alumno.email] });
    const pDueno = await paginaComo(await sesion(nucleo, PROFE_AUSTRAL));
    await pDueno.goto(nucleo.url(curso));
    await pDueno.locator('[data-menu="m-cursos"]').click();
    await expect(pDueno.locator('#m-cursos [data-accion="archivar-curso"]')).toBeVisible();
    for (const c of [await sesion(nucleo, PROFE2_AUSTRAL), alumno.cliente]) {
      const page = await paginaComo(c);
      await page.goto(nucleo.url(curso));
      await expect(page.locator('iframe#curso')).toBeVisible();
      await page.locator('[data-menu="m-cursos"]').click();
      await expect(page.locator('#m-cursos [data-curso]').first()).toBeVisible();
      await expect(page.locator('[data-accion="archivar-curso"], [data-accion="desarchivar-curso"]')).toHaveCount(0);
    }
  });

  test('Mis cursos y la barra con un curso archivado, para docentes y para alumnos', async ({ paginaComo, nucleo }) => {
    const alumno = await cuentaNueva(nucleo);
    const curso = cursoDePrueba(nucleo, { universidad: idUniversidad(nucleo, AUSTRAL), dueno: PROFE_AUSTRAL, profesores: [PROFE2_AUSTRAL], alumnos: [alumno.email] });
    const dueno = await sesionReautenticada(nucleo, PROFE_AUSTRAL);
    expect((await archivar(dueno, curso)).status).toBe(200);

    const profe = await sesion(nucleo, PROFE2_AUSTRAL);
    const pProfe = await paginaComo(profe);
    await pProfe.goto(nucleo.url());
    const tarjeta = pProfe.locator(`#grilla [data-curso="${curso}"]`);
    await expect(tarjeta).toBeVisible();
    await expect(tarjeta).toContainText('Archivado');
    await expect(pProfe.locator('#grilla [data-curso="redes"]')).not.toContainText('Archivado');
    await pProfe.goto(nucleo.url(curso));
    await expect(pProfe.locator('#curso-archivado')).toBeVisible();
    await expect(pProfe.locator('iframe#curso')).toHaveCount(0);
    await pProfe.locator('[data-menu="m-cursos"]').click();
    await expect(pProfe.locator('[data-accion="desarchivar-curso"]')).toHaveCount(0);

    const pAlumno = await paginaComo(alumno.cliente);
    await pAlumno.goto(nucleo.url());
    await expect(pAlumno.locator('#v-cursos')).toBeVisible();
    await expect(pAlumno.locator(`[data-curso="${curso}"]`)).toHaveCount(0);
    await pAlumno.goto(nucleo.url(curso));
    await expect(pAlumno.getByText('No tenés acceso a este curso')).toBeVisible();
    await expect(pAlumno.locator('iframe#curso')).toHaveCount(0);
    await expect(pAlumno.getByText(`Curso de prueba ${curso}`)).toHaveCount(0);
  });
});
