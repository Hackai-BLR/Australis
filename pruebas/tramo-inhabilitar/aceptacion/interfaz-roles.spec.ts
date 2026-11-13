import type { Page } from '@playwright/test';
import { crearTestTramo, expect, ADMIN_AUSTRAL, OWNER } from '../fixtures.ts';
import { aleatorio, esperarCodigo } from '../../comun/sesion.ts';
import type { Nucleo } from '../../comun/nucleo.ts';
import {
  AUSTRAL,
  cuentaNueva,
  cursoDePrueba,
  esperarOk,
  estadoCuenta,
  fila,
  idUniversidad,
  idUsuario,
  profesorNuevo,
  sesion,
  sesionReautenticada,
  suspender,
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

test.describe('interfaz: roles del owner', () => {
  test('Universidades: quitar un administrador con confirmación y reautenticación', async ({ paginaComo, nucleo }) => {
    const preparar = await sesionReautenticada(nucleo, OWNER);
    const uni = await universidadNueva(preparar);
    const segundo = `admin2@${uni.dominio}`;
    esperarOk(await preparar.post(`/api/owner/universidades/${uni.id}/administradores`, { email: segundo }), 'invitar', 201);
    const idSegundo = idUsuario(nucleo, segundo);
    const owner = await sesion(nucleo, OWNER);
    const page = await paginaComo(owner);
    await page.goto(nucleo.url(undefined, '/owner'));
    const f = page.locator(`tr[data-universidad="${uni.id}"]`);
    await expect(f.locator(`[data-quitaradmin="${idSegundo}"]`)).toBeVisible();

    await f.locator(`[data-quitaradmin="${idSegundo}"]`).click();
    await expect(page.locator('#modal')).toContainText('administrador');
    await page.locator('[data-cerrarmodal]').click();
    expect(Number(fila(nucleo, 'SELECT administrador FROM usuarios WHERE id = ?', idSegundo).administrador)).toBe(1);

    await f.locator(`[data-quitaradmin="${idSegundo}"]`).click();
    const desde = nucleo.cantidadMails();
    await confirmar(page, /Quitar/);
    await reautenticarEnDialogo(page, nucleo, OWNER, desde);
    await expect(f.locator(`[data-quitaradmin="${idSegundo}"]`)).toHaveCount(0);
    expect(Number(fila(nucleo, 'SELECT administrador FROM usuarios WHERE id = ?', idSegundo).administrador)).toBe(0);

    const ultimo = idUsuario(nucleo, uni.admin);
    await f.locator(`[data-quitaradmin="${ultimo}"]`).click();
    await confirmar(page, /Quitar/);
    await expect(page.locator('#aviso')).toContainText(/último administrador/i);
    expect(Number(fila(nucleo, 'SELECT administrador FROM usuarios WHERE id = ?', ultimo).administrador)).toBe(1);
  });

  test('Owners: lista, invitar owner y quitar', async ({ paginaComo, nucleo }) => {
    const owner = await sesion(nucleo, OWNER);
    const page = await paginaComo(owner);
    await page.goto(nucleo.url(undefined, '/owner'));
    await page.locator('#tabs-owner [data-otab="owners"]').click();
    await expect(page.locator(`tr[data-owner="${idUsuario(nucleo, OWNER)}"]`)).toBeVisible();

    const email = `${aleatorio('o')}@equipo.campusia.prueba`;
    await page.locator('[data-accion="invitar-owner"]').click();
    await page.locator('#o-mail').fill(email);
    const desde = nucleo.cantidadMails();
    await page.locator('[data-invok="owner"]').click();
    await reautenticarEnDialogo(page, nucleo, OWNER, desde);
    await expect.poll(() => fila(nucleo, 'SELECT id FROM usuarios WHERE email = ? AND owner = 1', email)?.id ?? null).not.toBeNull();
    const id = idUsuario(nucleo, email);
    const filaNuevo = page.locator(`tr[data-owner="${id}"]`);
    await expect(filaNuevo).toBeVisible();
    await expect(filaNuevo).toContainText(email);

    await filaNuevo.locator(`[data-quitarowner="${id}"]`).click();
    await expect(page.locator('#modal')).toContainText('owner');
    await confirmar(page, /Quitar/);
    await expect(filaNuevo).toHaveCount(0);
    expect(Number(fila(nucleo, 'SELECT owner FROM usuarios WHERE id = ?', id).owner)).toBe(0);
  });

  test('Administrar abre el panel de una universidad con selector y el menú de perfil ofrece Administración', async ({ paginaComo, nucleo }) => {
    const preparar = await sesionReautenticada(nucleo, OWNER);
    const a = await universidadNueva(preparar);
    const b = await universidadNueva(preparar);
    const pa = await cuentaNueva(nucleo, a.dominio);
    const pb = await cuentaNueva(nucleo, b.dominio);
    const owner = await sesion(nucleo, OWNER);
    const page = await paginaComo(owner);
    await page.goto(nucleo.url(undefined, '/owner'));
    await page.locator(`tr[data-universidad="${a.id}"] [data-administrar="${a.id}"]`).click();
    await expect(page.locator('#v-admin')).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/administracion\\?universidad=${a.id}$`));
    await expect(page.locator('#selector-universidad')).toHaveValue(String(a.id));
    await expect(page.locator(`tr[data-persona="${pa.id}"]`)).toBeVisible();
    await expect(page.locator(`tr[data-persona="${pb.id}"]`)).toHaveCount(0);

    await page.locator('#selector-universidad').selectOption(String(b.id));
    await expect(page.locator(`tr[data-persona="${pb.id}"]`)).toBeVisible();
    await expect(page.locator(`tr[data-persona="${pa.id}"]`)).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/administracion\\?universidad=${b.id}$`));

    await page.locator('#tabs-admin [data-tab="config"]').click();
    await expect(page.locator('#admin-cont')).toContainText(`@${b.dominio}`);

    await page.goto(nucleo.url(undefined, '/owner'));
    await page.locator('[data-menu="m-perfil-o"]').click();
    await page.locator('#m-perfil-o [data-accion="administracion"]').click();
    await expect(page.locator('#v-admin')).toBeVisible();
    await expect(page.locator('#selector-universidad')).toBeVisible();
  });

  test('el owner suspende y reactiva a un administrador desde Personas', async ({ paginaComo, nucleo }) => {
    const preparar = await sesionReautenticada(nucleo, OWNER);
    const uni = await universidadNueva(preparar);
    const idAdmin = idUsuario(nucleo, uni.admin);
    const owner = await sesion(nucleo, OWNER);
    const page = await paginaComo(owner);
    await page.goto(nucleo.url(undefined, `/administracion?universidad=${uni.id}`));
    const f = page.locator(`tr[data-persona="${idAdmin}"]`);
    await expect(f).toBeVisible();
    await f.locator(`[data-suspender="${idAdmin}"]`).click();
    const desde = nucleo.cantidadMails();
    await confirmar(page, /Suspender/);
    await reautenticarEnDialogo(page, nucleo, OWNER, desde);
    await expect(f.locator('td.estado')).toContainText('Suspendida');
    expect(estadoCuenta(nucleo, idAdmin).suspendida_en).toBeTruthy();
    await f.locator(`[data-reactivar="${idAdmin}"]`).click();
    await confirmar(page, /Reactivar/);
    await expect(f.locator('td.estado')).not.toContainText('Suspendida');
    expect(estadoCuenta(nucleo, idAdmin).suspendida_en).toBeNull();
  });
});

test.describe('interfaz: transferir un curso', () => {
  test('el administrador transfiere el curso de un dueño suspendido desde Cursos', async ({ paginaComo, nucleo }) => {
    const anaApi = await sesionReautenticada(nucleo, ADMIN_AUSTRAL);
    const dueno = await profesorNuevo(nucleo, anaApi);
    const nuevo = await profesorNuevo(nucleo, anaApi);
    const curso = cursoDePrueba(nucleo, { universidad: idUniversidad(nucleo, AUSTRAL), dueno: dueno.email });
    esperarOk(await suspender(anaApi, dueno.id), 'suspender dueño');

    const ana = await sesion(nucleo, ADMIN_AUSTRAL);
    const page = await paginaComo(ana);
    await page.goto(nucleo.url(undefined, '/administracion'));
    await page.locator('#tabs-admin [data-tab="cursos"]').click();
    const f = page.locator(`tr[data-fila-curso="${curso}"]`);
    await expect(f).toBeVisible();
    await f.locator(`[data-transferir="${curso}"]`).click();
    await expect(page.locator('#transferir-a')).toBeVisible();
    await expect(page.locator(`#transferir-a option[value="${dueno.id}"]`)).toHaveCount(0);
    await page.locator('#transferir-a').selectOption(String(nuevo.id));
    const desde = nucleo.cantidadMails();
    await confirmar(page, /Transferir/);
    await reautenticarEnDialogo(page, nucleo, ADMIN_AUSTRAL, desde);
    await expect(page.locator('#transferir-a')).toHaveCount(0);
    await expect(f).toContainText(fila(nucleo, 'SELECT nombre FROM usuarios WHERE id = ?', nuevo.id).nombre);
    expect(fila(nucleo, 'SELECT rol FROM inscripciones WHERE curso_id = ? AND usuario_id = ?', curso, nuevo.id).rol).toBe('dueño');
    expect(fila(nucleo, 'SELECT rol FROM inscripciones WHERE curso_id = ? AND usuario_id = ?', curso, dueno.id).rol).toBe('profesor');
  });
});
