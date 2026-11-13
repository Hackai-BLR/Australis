import type { Page } from '@playwright/test';
import { testCodigo as test, expect, ADMIN_AUSTRAL, PROFE_AUSTRAL } from '../fixtures.ts';
import { Cliente } from '../../comun/http.ts';
import type { Nucleo } from '../../comun/nucleo.ts';
import { aleatorio, entrar, esperarCodigo, verificar } from '../../comun/sesion.ts';

async function sesionDe(nucleo: Nucleo, email: string) {
  const c = new Cliente(nucleo);
  await entrar(c, email);
  return c;
}

async function abrirPerfil(page: Page) {
  await page.locator('button[data-menu^="m-perfil"]:visible').click();
}

async function reautenticarEnDialogo(page: Page, nucleo: Nucleo, email: string, desde: number) {
  await expect(page.locator('#reaut-digitos input')).toHaveCount(6);
  const codigo = await esperarCodigo(nucleo, email, desde);
  await page.locator('#reaut-digitos input').first().click();
  await page.keyboard.type(codigo);
  await expect(page.locator('#reaut-digitos')).toBeHidden();
}

test.describe('interfaz: tokens personales y sesiones', () => {
  test('el login de la interfaz ata el código a su solicitud, así un tercero no lo anula', async ({ paginaComo, nucleo }) => {
    const page = await paginaComo(null);
    await page.goto(nucleo.url());
    const email = `${aleatorio('ui.')}@austral.edu.ar`;
    const desde = nucleo.cantidadMails();
    await page.locator('#mail').fill(email);
    await page.locator('#enviar').click();
    await expect(page.locator('#paso-codigo')).toBeVisible();
    const codigo = await esperarCodigo(nucleo, email, desde);
    const fila = nucleo.consultar("SELECT solicitud FROM codigos_login WHERE email = ? AND proposito = 'login'", email);
    expect(fila).toHaveLength(1);
    expect(fila[0].solicitud).toBeTruthy();
    const otro = String((Number(codigo) + 1) % 1_000_000).padStart(6, '0');
    for (let i = 0; i < 5; i++) expect((await verificar(new Cliente(nucleo), email, otro)).status).toBe(400);
    await page.locator('#digitos input').first().click();
    await page.keyboard.type(codigo);
    await expect(page.getByRole('heading', { name: 'Mis cursos' })).toBeVisible();
  });
});
