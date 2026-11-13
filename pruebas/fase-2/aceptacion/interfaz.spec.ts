import { MODO_CODIGO } from '../../comun/nucleo.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { crearTestCursos, expect, PROFE_AUSTRAL, PROFE2_AUSTRAL, ALUMNO_AUSTRAL, ALUMNA2_AUSTRAL, SIN_MARCA_AUSTRAL } from '../fixtures.ts';
import { DOMINIO } from '../../comun/entorno.ts';
import { aleatorio, esperarCodigo } from '../../comun/sesion.ts';
import type { Nucleo } from '../../comun/nucleo.ts';
import { crearXlsx } from '../lib/xlsx.ts';
import {
  ESPERA_LISTO_MS,
  TIEMPO_PRUEBA_DOCKER,
  crearCurso,
  cursoListo,
  esperarListo,
  idAleatorio,
  idUsuario,
  inscribirOk,
  sesion,
} from '../lib/cursos.ts';

const test = crearTestCursos({ entorno: MODO_CODIGO });
test.describe.configure({ timeout: TIEMPO_PRUEBA_DOCKER });

const RE_DOMINIO = DOMINIO.replace(/\./g, '\\.');

async function reautenticarEnDialogo(page: Page, nucleo: Nucleo, email: string, desde: number) {
  await expect(page.locator('#reaut-digitos input')).toHaveCount(6);
  const codigo = await esperarCodigo(nucleo, email, desde);
  await page.locator('#reaut-digitos input').first().click();
  await page.keyboard.type(codigo);
  await expect(page.locator('#reaut-digitos')).toBeHidden();
}

async function abrirInscriptos(page: Page) {
  await page.locator('[data-panel="p-inscriptos"]').click();
  await expect(page.locator('#p-inscriptos')).toBeVisible();
}

test.describe('interfaz: crear curso', () => {
  test('el profesor crea un curso desde Mis cursos y lo ve en su subdominio', async ({ nucleo, paginaComo }) => {
    const profe = await sesion(nucleo, PROFE_AUSTRAL);
    const page = await paginaComo(profe);
    await page.goto(nucleo.url());
    await expect(page.locator('#grilla')).toBeVisible();
    await page.locator('[data-accion="crear"]:visible').first().click();
    await expect(page.locator('#c-nombre')).toBeVisible();
    await expect(page.locator('#modal')).toContainText(`.${DOMINIO}`);
    await page.locator('#c-nombre').fill('Análisis Matemático I');
    await expect(page.locator('#c-sub')).toHaveValue('analisis-matematico-i');
    const id = idAleatorio('am');
    await page.locator('#c-sub').fill(id);
    await page.locator('#c-nombre').fill('Análisis Matemático II');
    await expect(page.locator('#c-sub')).toHaveValue(id);
    expect(await page.locator('#c-per option').count()).toBeGreaterThanOrEqual(3);
    await page.locator('#c-per').selectOption({ index: 1 });
    const periodo = await page.locator('#c-per').inputValue();
    await page.locator('[data-accion="crear-ok"]').click();
    await expect(page).toHaveURL(new RegExp(`^http://${id}\\.${RE_DOMINIO}:${nucleo.puerto}/`), { timeout: 30_000 });
    await expect(page.locator('.barra')).toContainText('Análisis Matemático II');
    const marco = page.frameLocator('iframe#curso');
    await expect(marco.locator('[data-prueba="curso-nombre"]')).toHaveText('Análisis Matemático II', { timeout: ESPERA_LISTO_MS });
    await expect(marco.locator('[data-prueba="curso-periodo"]')).toContainText(periodo);
    await expect(marco.locator('[data-prueba="rol"]')).toHaveText('Dueño');
    await expect(page.locator('#curso-cargando')).toBeHidden();
    const sandbox = (await page.locator('iframe#curso').getAttribute('sandbox')) ?? '';
    const fichas = sandbox.split(/\s+/);
    for (const f of ['allow-scripts', 'allow-same-origin', 'allow-forms']) expect(fichas).toContain(f);
    for (const f of ['allow-top-navigation', 'allow-top-navigation-by-user-activation', 'allow-popups-to-escape-sandbox']) expect(fichas).not.toContain(f);
    const api = await profe.get(`/api/cursos/${id}`);
    expect(api.json).toMatchObject({ id, nombre: 'Análisis Matemático II', periodo, rol: 'dueño' });
  });

  test('el modal muestra los errores de dirección', async ({ nucleo, paginaComo }) => {
    const profe = await sesion(nucleo, PROFE_AUSTRAL);
    const page = await paginaComo(profe);
    await page.goto(nucleo.url());
    await page.locator('[data-accion="crear"]:visible').first().click();
    await page.locator('#c-nombre').fill('Administración');
    await page.locator('#c-sub').fill('admin');
    await page.locator('[data-accion="crear-ok"]').click();
    await expect(page.locator('#c-err')).not.toBeEmpty();
    await page.locator('#c-sub').fill('redes');
    await page.locator('[data-accion="crear-ok"]').click();
    await expect(page.locator('#c-err')).toContainText('ya está en uso');
    expect(nucleo.consultar("SELECT COUNT(*) AS n FROM cursos WHERE id = 'admin'")[0].n).toBe(0);
  });

  test('crear curso desde el selector de la barra', async ({ nucleo, paginaComo }) => {
    const profe = await sesion(nucleo, PROFE_AUSTRAL);
    const page = await paginaComo(profe);
    await page.goto(nucleo.url('redes'));
    await page.locator('[data-menu="m-cursos"]').click();
    await page.locator('#m-cursos [data-accion="crear"]').click();
    await expect(page.locator('#c-nombre')).toBeVisible();
  });

  test('quien no tiene marca de profesor no ve Crear curso', async ({ nucleo, paginaComo }) => {
    const c = await sesion(nucleo, ALUMNO_AUSTRAL);
    const page = await paginaComo(c);
    await page.goto(nucleo.url());
    await expect(page.locator('#grilla')).toBeVisible();
    await expect(page.locator('[data-accion="unirse"]:visible').first()).toBeVisible();
    await expect(page.locator('[data-accion="crear"]:visible')).toHaveCount(0);
    await page.goto(nucleo.url('redes'));
    await page.locator('[data-menu="m-cursos"]').click();
    await expect(page.locator('#m-cursos [data-accion="crear"]')).toHaveCount(0);
  });

  test('mientras el curso carga se ve el estado de carga', async ({ nucleo, paginaComo }) => {
    const profe = await sesion(nucleo, PROFE_AUSTRAL);
    const id = await cursoListo(profe, { nombre: 'Curso Lento' });
    const page = await paginaComo(profe);
    let soltar: () => void = () => {};
    const retenido = new Promise<void>((r) => (soltar = r));
    await page.route(new RegExp(`^http://${id}-curso\\.${RE_DOMINIO}:${nucleo.puerto}/$`), async (route) => {
      await retenido;
      await route.continue();
    });
    await page.goto(nucleo.url(id));
    await expect(page.locator('.barra')).toContainText('Curso Lento');
    await expect(page.locator('#curso-cargando')).toBeVisible();
    soltar();
    await expect(page.frameLocator('iframe#curso').locator('[data-prueba="curso-nombre"]')).toHaveText('Curso Lento', { timeout: 60_000 });
    await expect(page.locator('#curso-cargando')).toBeHidden();
  });
});

test.describe('interfaz: unirme con código', () => {
  test('una alumna se une con el código y entra al curso', async ({ nucleo, paginaComo }) => {
    const profe = await sesion(nucleo, PROFE_AUSTRAL);
    const id = await cursoListo(profe, { nombre: 'Curso con Código' });
    const codigo = (await profe.post(`/api/cursos/${id}/codigo`, {})).json.codigo as string;
    const email = `${aleatorio('unir.')}@mail.austral.edu.ar`;
    const alumna = await sesion(nucleo, email);
    const page = await paginaComo(alumna);
    await page.goto(nucleo.url());
    await expect(page.locator('.vacio')).toBeVisible();
    await page.locator('.vacio [data-accion="unirse"]').click();
    await page.locator('#u-cod').fill('XXX-ABCDEF');
    await page.locator('[data-accion="unirse-ok"]').click();
    await expect(page.locator('#u-err')).toContainText('Ese código no existe o ya no está activo.');
    await page.locator('#u-cod').fill(codigo.toLowerCase());
    await page.locator('[data-accion="unirse-ok"]').click();
    await expect(page).toHaveURL(new RegExp(`^http://${id}\\.${RE_DOMINIO}:${nucleo.puerto}/`), { timeout: 30_000 });
    await expect(page.locator('.barra')).toContainText('Curso con Código');
    await expect(page.frameLocator('iframe#curso').locator('[data-prueba="curso-nombre"]')).toHaveText('Curso con Código', { timeout: 60_000 });
    await expect(page.frameLocator('iframe#curso').locator('[data-prueba="rol"]')).toHaveCount(0);
    await expect(page.locator('[data-panel="p-inscriptos"]')).toBeHidden();
  });
});

test.describe('interfaz: panel Inscriptos', () => {
  test('el dueño agrega por mail, importa del SIU y maneja el código', async ({ nucleo, paginaComo }) => {
    const profe = await sesion(nucleo, PROFE_AUSTRAL);
    const id = idAleatorio('pan');
    expect((await crearCurso(profe, { id, nombre: 'Panel' })).status).toBe(201);
    const page = await paginaComo(profe);
    await page.goto(nucleo.url(id));
    await abrirInscriptos(page);
    await expect(page.locator('#ins-tit')).toHaveText('Inscriptos · 0 alumnos, 1 profesor');
    await expect(page.locator(`.persona[data-usuario="${idUsuario(nucleo, PROFE_AUSTRAL)}"]`)).toContainText('Dueño');

    await page.locator('[data-insf="f-mails"]').click();
    await expect(page.locator('#ins-rol option[value="profesor"]')).toBeEnabled();
    await page.locator('#ins-mails').fill(`${ALUMNO_AUSTRAL}, alumno@demo.edu.ar`);
    await page.locator('#ins-agregar').click();
    await expect(page.locator('#ins-err')).toContainText('alumno@demo.edu.ar');
    await expect(page.locator('#ins-tit')).toHaveText('Inscriptos · 0 alumnos, 1 profesor');
    await page.locator('#ins-mails').fill(`${ALUMNO_AUSTRAL}\n${ALUMNA2_AUSTRAL}`);
    await page.locator('#ins-agregar').click();
    await expect(page.locator('#ins-tit')).toHaveText('Inscriptos · 2 alumnos, 1 profesor');
    await expect(page.locator('#ins-lista')).toContainText(ALUMNA2_AUSTRAL);

    if (!(await page.locator('#f-mails').isVisible())) await page.locator('[data-insf="f-mails"]').click();
    await page.locator('#ins-rol').selectOption('profesor');
    await page.locator('#ins-mails').fill(SIN_MARCA_AUSTRAL);
    await page.locator('#ins-agregar').click();
    await expect(page.locator('#ins-err')).toContainText(SIN_MARCA_AUSTRAL);
    await page.locator('#ins-mails').fill(PROFE2_AUSTRAL);
    await page.locator('#ins-agregar').click();
    await expect(page.locator('#ins-tit')).toHaveText('Inscriptos · 2 alumnos, 2 profesores');

    const nuevo = `${aleatorio('siu.ui')}@austral.edu.ar`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siu-'));
    const archivo = path.join(dir, 'inscriptos.xlsx');
    fs.writeFileSync(archivo, crearXlsx([['Apellido y Nombre', 'Mail'], ['Nueva Persona', nuevo], ['De Afuera', 'z@otra.edu.ar']]));
    await page.locator('[data-insf="f-siu"]').click();
    await page.locator('#ins-archivo').setInputFiles(archivo);
    await expect(page.locator('#aviso')).toContainText('importados');
    await expect(page.locator('#ins-tit')).toHaveText('Inscriptos · 3 alumnos, 2 profesores');
    await expect(page.locator('#ins-lista')).toContainText(nuevo);

    await page.locator('[data-insf="f-codigo"]').click();
    const valor = page.locator('#cod-valor');
    await expect(valor).toHaveText(/^PAN-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
    const antes = (await valor.textContent())!.trim();
    await expect(page.locator('#cod-sw')).not.toHaveClass(/\bon\b/);
    await expect(page.locator('#cod-vence')).toContainText('Desactivado');
    await page.locator('#cod-nuevo').click();
    await expect(valor).not.toHaveText(antes);
    await expect(page.locator('#cod-sw')).toHaveClass(/\bon\b/);
    await expect(page.locator('#cod-vence')).toContainText('Vence');
    const api = await profe.get(`/api/cursos/${id}/codigo`);
    expect(api.json.codigo).toBe((await valor.textContent())!.trim());
    expect(api.json.activo).toBe(true);
    await page.locator('#cod-sw').click();
    await expect(page.locator('#cod-sw')).not.toHaveClass(/\bon\b/);
    await expect.poll(async () => (await profe.get(`/api/cursos/${id}/codigo`)).json.activo).toBe(false);
  });

  test('el dueño cambia roles, quita y transfiere con confirmación y reautenticación', async ({ nucleo, paginaComo }) => {
    const profe = await sesion(nucleo, PROFE_AUSTRAL);
    const id = idAleatorio('rol');
    expect((await crearCurso(profe, { id, nombre: 'Roles' })).status).toBe(201);
    await inscribirOk(profe, id, [ALUMNO_AUSTRAL, ALUMNA2_AUSTRAL, 'mruiz@austral.edu.ar']);
    await inscribirOk(profe, id, [PROFE2_AUSTRAL], 'profesor');
    const page = await paginaComo(profe);
    await page.goto(nucleo.url(id));
    await abrirInscriptos(page);
    const tomas = idUsuario(nucleo, ALUMNO_AUSTRAL);
    const martin = idUsuario(nucleo, 'mruiz@austral.edu.ar');
    const diego = idUsuario(nucleo, PROFE2_AUSTRAL);
    await expect(page.locator(`select[data-rol="${tomas}"] option[value="profesor"]`)).toBeDisabled();
    await expect(page.locator(`select[data-rol="${martin}"] option[value="profesor"]`)).toBeEnabled();

    let desde = nucleo.cantidadMails();
    await page.locator(`select[data-rol="${martin}"]`).selectOption('profesor');
    await reautenticarEnDialogo(page, nucleo, PROFE_AUSTRAL, desde);
    await expect(page.locator('#ins-tit')).toHaveText('Inscriptos · 2 alumnos, 3 profesores');
    await expect.poll(async () => (await profe.get(`/api/cursos/${id}/inscriptos`)).json.inscriptos.find((i: any) => i.id === martin)?.rol).toBe('profesor');

    await page.locator(`[data-quitar="${tomas}"]`).click();
    await expect(page.locator('.persona.conf')).toContainText('¿Quitar a Tomás García?');
    await page.locator('[data-noquitar]').click();
    await expect(page.locator('.persona.conf')).toHaveCount(0);
    await page.locator(`[data-quitar="${tomas}"]`).click();
    await page.locator(`[data-siquitar="${tomas}"]`).click();
    await expect(page.locator(`.persona[data-usuario="${tomas}"]`)).toHaveCount(0);
    await expect(page.locator('#ins-tit')).toHaveText('Inscriptos · 1 alumno, 3 profesores');

    await page.locator(`[data-transferir="${diego}"]`).click();
    await page.locator(`[data-sitransferir="${diego}"]`).click();
    await expect.poll(async () => (await profe.get(`/api/cursos/${id}`)).json.rol).toBe('profesor');
    await expect(page.locator(`.persona[data-usuario="${diego}"]`)).toContainText('Dueño');
  });

  test('un profesor no dueño solo maneja alumnos', async ({ nucleo, paginaComo }) => {
    const profe = await sesion(nucleo, PROFE_AUSTRAL);
    const id = idAleatorio('nod');
    expect((await crearCurso(profe, { id })).status).toBe(201);
    await inscribirOk(profe, id, [PROFE2_AUSTRAL, 'mruiz@austral.edu.ar'], 'profesor');
    await inscribirOk(profe, id, [ALUMNO_AUSTRAL]);
    const p2 = await sesion(nucleo, PROFE2_AUSTRAL);
    const page = await paginaComo(p2);
    await page.goto(nucleo.url(id));
    await abrirInscriptos(page);
    await page.locator('[data-insf="f-mails"]').click();
    await expect(page.locator('#ins-rol option[value="profesor"]')).toBeDisabled();
    await expect(page.locator(`[data-quitar="${idUsuario(nucleo, ALUMNO_AUSTRAL)}"]`)).toBeVisible();
    for (const email of [PROFE_AUSTRAL, PROFE2_AUSTRAL, 'mruiz@austral.edu.ar']) {
      await expect(page.locator(`[data-quitar="${idUsuario(nucleo, email)}"]`), email).toHaveCount(0);
      await expect(page.locator(`[data-transferir="${idUsuario(nucleo, email)}"]`), email).toHaveCount(0);
    }
  });

  test('el alumno ve el curso sin panel de inscriptos', async ({ nucleo, paginaComo }) => {
    const profe = await sesion(nucleo, PROFE_AUSTRAL);
    const id = await cursoListo(profe, { nombre: 'Vista Alumno' });
    await inscribirOk(profe, id, [ALUMNO_AUSTRAL]);
    const alumno = await sesion(nucleo, ALUMNO_AUSTRAL);
    const page = await paginaComo(alumno);
    await page.goto(nucleo.url());
    await page.locator(`#grilla [data-curso="${id}"]`).click();
    await expect(page).toHaveURL(new RegExp(`^http://${id}\\.${RE_DOMINIO}:${nucleo.puerto}/`));
    await expect(page.frameLocator('iframe#curso').locator('[data-prueba="curso-nombre"]')).toHaveText('Vista Alumno', { timeout: 60_000 });
    await expect(page.locator('[data-panel="p-inscriptos"]')).toBeHidden();
    await esperarListo(alumno, id);
  });
});
