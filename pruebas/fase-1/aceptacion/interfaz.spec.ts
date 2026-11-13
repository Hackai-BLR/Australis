import type { Page } from '@playwright/test';
import { testCodigo as test, expect, ADMIN_AUSTRAL, ALUMNO_AUSTRAL, OWNER, PROFE_AUSTRAL, UNI_AUSTRAL } from '../fixtures.ts';
import { Cliente } from '../../comun/http.ts';
import type { Nucleo } from '../../comun/nucleo.ts';
import { aleatorio, entrar, esperarCodigo, pedirCodigo } from '../../comun/sesion.ts';
import { DOMINIO } from '../../comun/entorno.ts';

async function pegarCodigo(page: Page, selector: string, codigo: string) {
  await page.locator(selector).first().evaluate((el, texto) => {
    (el as HTMLInputElement).focus();
    const dt = new DataTransfer();
    dt.setData('text/plain', texto);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, codigo);
}

async function entrarConInterfaz(page: Page, nucleo: Nucleo, email: string) {
  await page.goto(nucleo.url());
  await expect(page.locator('#mail')).toBeVisible();
  const desde = nucleo.cantidadMails();
  await page.locator('#mail').fill(email);
  await page.locator('#enviar').click();
  await expect(page.locator('#paso-codigo')).toBeVisible();
  const codigo = await esperarCodigo(nucleo, email, desde);
  await pegarCodigo(page, '#digitos input', codigo);
}

async function reautenticarEnDialogo(page: Page, nucleo: Nucleo, email: string, desde: number) {
  await expect(page.locator('#reaut-digitos input')).toHaveCount(6);
  const codigo = await esperarCodigo(nucleo, email, desde);
  await page.locator('#reaut-digitos input').first().click();
  await page.keyboard.type(codigo);
  await expect(page.locator('#reaut-digitos')).toBeHidden();
}

async function abrirPerfil(page: Page) {
  await page.locator('button[data-menu^="m-perfil"]:visible').click();
}

async function sesionDe(nucleo: Nucleo, email: string) {
  const c = new Cliente(nucleo);
  await entrar(c, email);
  return c;
}

test.describe('interfaz: login', () => {
  test('pantalla de login como el prototipo, sin cuentas de prueba', async ({ paginaComo, nucleo }) => {
    const page = await paginaComo(null);
    await page.goto(nucleo.url());
    await expect(page.locator('#mail')).toBeVisible();
    await expect(page.locator('#enviar')).toHaveText('Enviar código');
    await expect(page.locator('#paso-codigo')).toBeHidden();
    await expect(page.locator('#cuentas')).toHaveCount(0);
    await expect(page).toHaveTitle(/Campus IA/);
  });

  test('login pegando el código lleva a Mis cursos con tarjetas y rol', async ({ paginaComo, nucleo }) => {
    const page = await paginaComo(null);
    await entrarConInterfaz(page, nucleo, PROFE_AUSTRAL);
    await expect(page.getByRole('heading', { name: 'Mis cursos' })).toBeVisible();
    const redes = page.locator('#grilla [data-curso="redes"]');
    await expect(redes).toBeVisible();
    await expect(redes).toContainText('Redes de Computadoras');
    await expect(redes).toContainText('2.º cuatrimestre 2026');
    await expect(redes).toContainText('Dueño');
    await expect(page.locator('#grilla [data-curso="etica"]')).toBeVisible();
    await expect(page.locator('#grilla [data-curso="etica"]')).not.toContainText('Dueño');
    await expect(page.locator('#grilla [data-curso="quimica"]')).toHaveCount(0);
    await page.reload();
    await expect(page.locator('#grilla [data-curso="redes"]')).toBeVisible();
  });

  test('tipear el código avanza solo de casilla y entra al completar', async ({ paginaComo, nucleo }) => {
    const page = await paginaComo(null);
    await page.goto(nucleo.url());
    const desde = nucleo.cantidadMails();
    await page.locator('#mail').fill(ALUMNO_AUSTRAL);
    await page.locator('#mail').press('Enter');
    await expect(page.locator('#paso-codigo')).toBeVisible();
    await expect(page.locator('#mail-enviado')).toHaveText(ALUMNO_AUSTRAL);
    await expect(page.locator('#digitos input')).toHaveCount(6);
    const codigo = await esperarCodigo(nucleo, ALUMNO_AUSTRAL, desde);
    await page.locator('#digitos input').first().click();
    await page.keyboard.type(codigo, { delay: 30 });
    await expect(page.locator('#grilla [data-curso="redes"]')).toBeVisible();
    await expect(page.locator('#grilla [data-curso="redes"]')).not.toContainText('Dueño');
    await expect(page.locator('#grilla [data-curso="redes"]')).not.toContainText('Profesor');
  });

  test('un código equivocado muestra error y se puede usar otro mail o reenviar', async ({ paginaComo, nucleo }) => {
    const page = await paginaComo(null);
    await page.goto(nucleo.url());
    await page.locator('#mail').fill(ALUMNO_AUSTRAL);
    await page.locator('#enviar').click();
    await expect(page.locator('#paso-codigo')).toBeVisible();
    await pegarCodigo(page, '#digitos input', '000000');
    await expect(page.locator('#err-codigo')).not.toBeEmpty();
    const desde = nucleo.cantidadMails();
    await page.locator('#reenviar').click();
    const codigo = await esperarCodigo(nucleo, ALUMNO_AUSTRAL, desde);
    await page.locator('#otro-mail').click();
    await expect(page.locator('#paso-mail')).toBeVisible();
    await expect(page.locator('#paso-codigo')).toBeHidden();
    await page.locator('#mail').fill(ALUMNO_AUSTRAL);
    const desde2 = nucleo.cantidadMails();
    await page.locator('#enviar').click();
    const codigo2 = await esperarCodigo(nucleo, ALUMNO_AUSTRAL, desde2);
    expect(codigo2).toMatch(/^\d{6}$/);
    expect(codigo.length).toBe(6);
    await pegarCodigo(page, '#digitos input', codigo2);
    await expect(page.locator('#grilla')).toBeVisible();
  });

  test('un mail mal escrito muestra error sin pasar al código', async ({ paginaComo, nucleo }) => {
    const page = await paginaComo(null);
    await page.goto(nucleo.url());
    await page.locator('#mail').fill('esto no es un mail');
    await page.locator('#enviar').click();
    await expect(page.locator('#err-mail')).not.toBeEmpty();
    await expect(page.locator('#paso-codigo')).toBeHidden();
  });

  test('una cuenta nueva ve el estado vacío', async ({ paginaComo, nucleo }) => {
    const page = await paginaComo(null);
    await entrarConInterfaz(page, nucleo, `${aleatorio('vacio.')}@austral.edu.ar`);
    await expect(page.locator('#grilla .vacio')).toBeVisible();
    await expect(page.locator('#grilla .vacio')).toContainText('Todavía no estás en ningún curso');
  });

  test('Turnstile aparece cuando el núcleo lo pide y el login sigue', async ({ contextoNuevo, nucleo }) => {
    const api = new Cliente(nucleo);
    for (let i = 0; i < 5; i++) expect((await pedirCodigo(api, `${aleatorio('ts.')}@austral.edu.ar`)).status).toBe(200);
    const ctx = await contextoNuevo(api.ip);
    const page = await ctx.newPage();
    await page.goto(nucleo.url());
    const desde = nucleo.cantidadMails();
    await page.locator('#mail').fill(ALUMNO_AUSTRAL);
    await page.locator('#enviar').click();
    await expect(page.locator('#turnstile[data-turnstile-falso="1"]')).toBeAttached();
    if (await page.locator('#paso-mail').isVisible()) await page.locator('#enviar').click();
    await expect(page.locator('#paso-codigo')).toBeVisible();
    const codigo = await esperarCodigo(nucleo, ALUMNO_AUSTRAL, desde);
    await pegarCodigo(page, '#digitos input', codigo);
    await expect(page.locator('#grilla')).toBeVisible();
  });

  test('cerrar sesión vuelve al login y la sesión deja de valer', async ({ paginaComo, nucleo }) => {
    const c = await sesionDe(nucleo, ALUMNO_AUSTRAL);
    const page = await paginaComo(c);
    await page.goto(nucleo.url());
    await expect(page.locator('#grilla')).toBeVisible();
    await abrirPerfil(page);
    await expect(page.getByRole('button', { name: 'Administración' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Owner' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Cerrar sesión' }).click();
    await expect(page.locator('#mail')).toBeVisible();
    expect((await c.get('/api/yo')).status).toBe(401);
  });
});

test.describe('interfaz: barra del curso', () => {
  test('el profesor abre su curso en el subdominio y ve la barra completa', async ({ paginaComo, nucleo }) => {
    const c = await sesionDe(nucleo, PROFE_AUSTRAL);
    const page = await paginaComo(c);
    await page.goto(nucleo.url());
    await page.locator('#grilla [data-curso="redes"]').click();
    await expect(page).toHaveURL(new RegExp(`^http://redes\\.${DOMINIO.replace('.', '\\.')}:${nucleo.puerto}/`));
    const barra = page.locator('.barra');
    await expect(barra).toBeVisible();
    const alto = await barra.evaluate((e) => e.getBoundingClientRect().height);
    expect(Math.round(alto)).toBe(48);
    await expect(barra).toContainText('Redes de Computadoras');
    for (const sel of ['[data-panel="p-agente"]', '[data-panel="p-inscriptos"]', '[data-panel="p-versiones"]', '#publicar', '[data-modo="publicado"]', '[data-modo="prueba"]']) {
      await expect(page.locator(sel), sel).toBeVisible();
    }
    await expect(page.locator('iframe#curso')).toHaveAttribute('src', new RegExp(`redes-curso\\.${DOMINIO.replace('.', '\\.')}`));
    await page.locator('[data-menu="m-cursos"]').click();
    await expect(page.locator('#m-cursos [data-curso="algoritmos"]')).toBeVisible();
    await page.locator('#m-cursos [data-curso="algoritmos"]').click();
    await expect(page).toHaveURL(new RegExp(`^http://algoritmos\\.`));
    await expect(page.locator('.barra')).toContainText('Algoritmos y Estructuras de Datos');
    await page.locator('.barra .marca').click();
    await expect(page).toHaveURL(nucleo.url());
    await expect(page.locator('#grilla')).toBeVisible();
  });

  test('el alumno ve la barra sin los botones de profesor', async ({ paginaComo, nucleo }) => {
    const c = await sesionDe(nucleo, ALUMNO_AUSTRAL);
    const page = await paginaComo(c);
    await page.goto(nucleo.url('redes'));
    await expect(page.locator('.barra')).toContainText('Redes de Computadoras');
    for (const sel of ['[data-panel="p-agente"]', '[data-panel="p-inscriptos"]', '[data-panel="p-versiones"]', '#publicar', '[data-modo="prueba"]']) {
      await expect(page.locator(sel), sel).toBeHidden();
    }
    await expect(page.locator('iframe#curso')).toBeVisible();
  });

  test('en un curso ajeno no se muestra el curso', async ({ paginaComo, nucleo }) => {
    const c = await sesionDe(nucleo, ALUMNO_AUSTRAL);
    const page = await paginaComo(c);
    await page.goto(nucleo.url('quimica'));
    await expect(page.locator('body')).not.toContainText('Química General');
    await expect(page.locator('iframe#curso')).toHaveCount(0);
  });

  test('sin sesión el subdominio del curso pide entrar', async ({ paginaComo, nucleo }) => {
    const page = await paginaComo(null);
    await page.goto(nucleo.url('redes'));
    await expect(page.locator('#mail')).toBeVisible();
  });
});

test.describe('interfaz: panel de administrador', () => {
  test('personas, marcar profesor con reautenticación, cursos, configuración y actividad', async ({ paginaComo, nucleo }) => {
    const nuevo = `${aleatorio('ui.')}@austral.edu.ar`;
    const persona = new Cliente(nucleo);
    const u = await entrar(persona, nuevo);
    const c = await sesionDe(nucleo, ADMIN_AUSTRAL);
    const page = await paginaComo(c);
    await page.goto(nucleo.url());
    await abrirPerfil(page);
    await page.getByRole('button', { name: /Administración/ }).click();
    await expect(page).toHaveURL(nucleo.url(undefined, '/administracion'));
    await expect(page.locator('#tabs-admin [data-tab="personas"]')).toBeVisible();
    await expect(page.getByText(UNI_AUSTRAL).first()).toBeVisible();
    await expect(page.getByText(PROFE_AUSTRAL)).toBeVisible();
    await expect(page.getByText('admin@demo.edu.ar')).toHaveCount(0);

    await page.locator('#busca').fill('herrera');
    await expect(page.getByText('dherrera@austral.edu.ar')).toBeVisible();
    await expect(page.getByText(PROFE_AUSTRAL)).toHaveCount(0);
    await page.locator('#busca').fill('');
    await page.locator('[data-filtro="prof"]').click();
    await expect(page.getByText(PROFE_AUSTRAL)).toBeVisible();
    await expect(page.getByText(ALUMNO_AUSTRAL)).toHaveCount(0);
    await page.locator('[data-filtro="todos"]').click();

    const sw = page.locator(`button[data-marca="${u.id}"]`);
    await expect(sw).toHaveAttribute('aria-pressed', 'false');
    const desde = nucleo.cantidadMails();
    await sw.click();
    await reautenticarEnDialogo(page, nucleo, ADMIN_AUSTRAL, desde);
    await expect(sw).toHaveAttribute('aria-pressed', 'true');
    expect((await persona.get('/api/yo')).json.usuario.profesor).toBe(true);

    const invitado = `${aleatorio('uinv.')}@austral.edu.ar`;
    await page.locator('[data-accion="invitar-prof"]').click();
    await page.locator('#i-mail').fill(invitado);
    await page.locator('[data-invok]').click();
    await expect(page.locator('tr', { hasText: invitado })).toContainText('Invitación enviada');

    await page.locator('#tabs-admin [data-tab="cursos"]').click();
    await expect(page.locator('tr', { hasText: 'Redes de Computadoras' })).toContainText('Lucía Fernández');
    await expect(page.locator('tr', { hasText: 'Redes de Computadoras' })).toContainText('v12');
    await expect(page.getByText('Química General')).toHaveCount(0);

    await page.locator('#tabs-admin [data-tab="config"]').click();
    await expect(page.locator('[data-quitardom="austral.edu.ar"]')).toBeVisible();
    const dominio = `${aleatorio('ui')}.austral.edu.ar`;
    await page.locator('#nuevo-dom').fill(dominio);
    await page.locator('[data-accion="agregar-dom"]').click();
    await expect(page.locator(`[data-quitardom="${dominio}"]`)).toBeVisible();
    await page.locator(`[data-quitardom="${dominio}"]`).click();
    await expect(page.locator(`[data-quitardom="${dominio}"]`)).toHaveCount(0);
    expect((await c.get('/api/admin/universidad')).json.dominios).not.toContain(dominio);
    await expect(page.locator('#limite')).toHaveCount(0);

    await page.locator('#tabs-admin [data-tab="actividad"]').click();
    await expect(page.getByText(nuevo).first()).toBeVisible();
  });

  test('alguien sin marca de administrador no entra al panel', async ({ paginaComo, nucleo }) => {
    const c = await sesionDe(nucleo, PROFE_AUSTRAL);
    const page = await paginaComo(c);
    await page.goto(nucleo.url(undefined, '/administracion'));
    await expect(page).toHaveURL(nucleo.url());
    await expect(page.locator('#tabs-admin')).toHaveCount(0);
    await page.goto(nucleo.url(undefined, '/owner'));
    await expect(page).toHaveURL(nucleo.url());
    await expect(page.locator('#tabs-owner')).toHaveCount(0);
  });
});

test.describe('interfaz: panel de owner', () => {
  test('universidades, nueva universidad con reautenticación, uso y proveedores', async ({ paginaComo, nucleo }) => {
    const c = await sesionDe(nucleo, OWNER);
    const page = await paginaComo(c);
    await page.goto(nucleo.url());
    await expect(page).toHaveURL(nucleo.url(undefined, '/owner'));
    await expect(page.locator('#tabs-owner [data-otab="unis"]')).toBeVisible();
    await expect(page.locator('tr', { hasText: UNI_AUSTRAL })).toContainText('Ana Morales');

    const dominio = `${aleatorio('ou')}.edu.ar`;
    const nombre = `Universidad ${dominio}`;
    await page.locator('[data-accion="nueva-uni"]').click();
    await page.locator('#n-nombre').fill(nombre);
    await page.locator('#n-dom').fill(dominio);
    await page.locator('#n-admin').fill(`admin@${dominio}`);
    const desde = nucleo.cantidadMails();
    await page.locator('[data-accion="uni-ok"]').click();
    await reautenticarEnDialogo(page, nucleo, OWNER, desde);
    const fila = page.locator('tr', { hasText: nombre });
    await expect(fila).toBeVisible();
    await expect(fila).toContainText('Invitación enviada');
    await expect(fila).toContainText(`@${dominio}`);

    await page.locator('#tabs-owner [data-otab="uso"]').click();
    await expect(page.locator('#op-modelo')).toBeVisible();
    await expect(page.locator('#op-mail')).toBeVisible();
    await expect(page.locator('tr', { hasText: UNI_AUSTRAL })).toContainText('USD 68');
    await page.locator('#op-mail button', { hasText: 'Resend' }).click();
    await expect.poll(async () => (await c.get('/api/owner/proveedores')).json.email).toBe('resend');
    await page.reload();
    await page.locator('#tabs-owner [data-otab="uso"]').click();
    await expect(page.locator('#op-mail button', { hasText: 'Resend' })).toHaveClass(/\bon\b/);
    await page.locator('#op-mail button', { hasText: 'Brevo' }).click();
    await expect.poll(async () => (await c.get('/api/owner/proveedores')).json.email).toBe('brevo');
  });
});
