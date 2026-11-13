import type { Page } from '@playwright/test';
import { crearTestSinDocker, expect, OWNER, ADMIN_AUSTRAL, PROFE_AUSTRAL, ALUMNO_AUSTRAL } from '../fixtures.ts';
import { Cliente } from '../../comun/http.ts';
import { AUSTRAL, auditoriaDe, idDe, login, mailNuevo, ok, sesionDe, universidadDe } from '../lib.ts';

const test = crearTestSinDocker();

const CHROME_LINUX = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const FIREFOX_WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0';

async function abrirPerfil(page: Page) {
  await page.locator('button[data-menu^="m-perfil"]:visible').click();
}

test.describe('sin tokens personales ni "Cerrar las demás sesiones" en la interfaz', () => {
  test('el menú de perfil no ofrece tokens ni cerrar las demás sesiones', async ({ nucleo, paginaComo }) => {
    for (const email of [ALUMNO_AUSTRAL, PROFE_AUSTRAL, ADMIN_AUSTRAL, OWNER]) {
      const c = await sesionDe(nucleo, email);
      const page = await paginaComo(c);
      await page.goto(nucleo.url());
      await abrirPerfil(page);
      await expect(page.locator('button[data-menu^="m-perfil"]:visible')).toBeVisible();
      await expect(page.locator('[data-accion="tokens"]')).toHaveCount(0);
      await expect(page.locator('[data-accion="cerrar-otras"]')).toHaveCount(0);
      await expect(page.getByText('Tokens de API')).toHaveCount(0);
      await expect(page.getByText('Cerrar las demás sesiones')).toHaveCount(0);
      await page.close();
    }
  });
});

test.describe('el owner ve y cierra las sesiones de una persona', () => {
  test('ve las sesiones activas con dispositivo, IP y último uso', async ({ nucleo }) => {
    const email = mailNuevo('austral.edu.ar', 'ses');
    const a = await login(nucleo, email, CHROME_LINUX);
    const b = await login(nucleo, email, FIREFOX_WINDOWS);
    const c = await login(nucleo, email);
    expect((await c.post('/api/logout')).status).toBe(204);
    expect((await a.get('/api/mis-cursos')).status).toBe(200);
    const id = idDe(nucleo, email);
    const owner = await sesionDe(nucleo, OWNER);
    const r = ok(await owner.get(`/api/owner/personas/${id}/sesiones`), 'sesiones');
    expect(r.sesiones).toHaveLength(2);
    const porIp = new Map(r.sesiones.map((s: any) => [s.ip, s]));
    const sa: any = porIp.get(a.ip);
    const sb: any = porIp.get(b.ip);
    expect(sa, 'falta la sesión de Chrome').toBeTruthy();
    expect(sb, 'falta la sesión de Firefox').toBeTruthy();
    expect(sa.dispositivo).toContain('Chrome');
    expect(sa.dispositivo).toContain('Linux');
    expect(sa.agente).toBe(CHROME_LINUX);
    expect(sb.dispositivo).toContain('Firefox');
    expect(sb.dispositivo).toContain('Windows');
    for (const s of [sa, sb]) {
      expect(typeof s.id).toBe('number');
      expect(Date.parse(s.creada)).not.toBeNaN();
      expect(Date.parse(s.ultimo_uso)).toBeGreaterThanOrEqual(Date.parse(s.creada));
      expect(Date.parse(s.vence)).toBeGreaterThan(Date.now());
    }
    const fila = nucleo.consultar('SELECT ultimo_uso, creada_en FROM sesiones WHERE id = ?', sa.id)[0];
    expect(fila.ultimo_uso).toBeTruthy();
    const desconocido = await login(nucleo, mailNuevo('austral.edu.ar', 'ua'), 'algo-raro/1');
    const otra = ok(await owner.get(`/api/owner/personas/${idDe(nucleo, desconocido.email!)}/sesiones`), 'sesiones');
    expect(otra.sesiones[0].dispositivo).toBe('Dispositivo desconocido');
  });

  test('cierra una sesión o todas, y queda en la auditoría', async ({ nucleo }) => {
    const email = mailNuevo('austral.edu.ar', 'cer');
    const a = await login(nucleo, email, CHROME_LINUX);
    const b = await login(nucleo, email, FIREFOX_WINDOWS);
    const c = await login(nucleo, email);
    const id = idDe(nucleo, email);
    const owner = await sesionDe(nucleo, OWNER);
    const lista = ok(await owner.get(`/api/owner/personas/${id}/sesiones`), 'sesiones');
    const sa = lista.sesiones.find((s: any) => s.ip === a.ip);
    const borrar = await owner.delete(`/api/owner/personas/${id}/sesiones/${sa.id}`);
    expect(borrar.status, borrar.texto).toBe(204);
    expect((await a.get('/api/yo')).status).toBe(401);
    expect((await b.get('/api/yo')).status).toBe(200);
    expect((await c.get('/api/yo')).status).toBe(200);
    const ev = auditoriaDe(nucleo, 'sesion_cerrada', email).pop();
    expect(ev).toBeTruthy();
    expect(Number(ev.actor_id)).toBe(idDe(nucleo, OWNER));
    expect(Number(ev.universidad_id)).toBe(universidadDe(nucleo, AUSTRAL));

    const todas = ok(await owner.post(`/api/owner/personas/${id}/sesiones/cerrar`, {}), 'cerrar todas');
    expect(todas.cerradas).toBe(2);
    expect((await b.get('/api/yo')).status).toBe(401);
    expect((await c.get('/api/yo')).status).toBe(401);
    expect(ok(await owner.get(`/api/owner/personas/${id}/sesiones`), 'sesiones').sesiones).toEqual([]);
    expect(auditoriaDe(nucleo, 'sesiones_cerradas', email).pop()).toBeTruthy();
    expect((await owner.get('/api/yo')).status).toBe(200);
    const vuelve = await login(nucleo, email);
    expect((await vuelve.get('/api/yo')).status).toBe(200);
  });

  test('desde Administración › Personas el owner ve las sesiones de una persona y las cierra', async ({ nucleo, paginaComo }) => {
    const email = mailNuevo('austral.edu.ar', 'pan');
    const a = await login(nucleo, email, CHROME_LINUX);
    const b = await login(nucleo, email, FIREFOX_WINDOWS);
    const id = idDe(nucleo, email);
    const owner = await sesionDe(nucleo, OWNER);
    const sesiones = ok(await owner.get(`/api/owner/personas/${id}/sesiones`), 'sesiones').sesiones;
    const sa = sesiones.find((s: any) => s.ip === a.ip);
    const page = await paginaComo(owner);
    await page.goto(nucleo.url(undefined, `/administracion?universidad=${universidadDe(nucleo, AUSTRAL)}`));
    await page.locator('#tabs-admin [data-tab="personas"]').click();
    await page.locator('#busca').fill(email);
    const fila = page.locator(`tr[data-persona="${id}"]`);
    await expect(fila).toBeVisible();
    await fila.locator(`[data-sesiones="${id}"]`).click();
    const panel = page.locator('#sesiones-persona');
    await expect(panel).toBeVisible();
    await expect(panel.locator('tr[data-sesion]')).toHaveCount(2);
    const filaA = panel.locator(`tr[data-sesion="${sa.id}"]`);
    await expect(filaA).toContainText('Chrome');
    await expect(filaA).toContainText(a.ip);
    await filaA.locator(`[data-cerrarsesion="${sa.id}"]`).click();
    await expect(filaA).toHaveCount(0);
    await expect(page.locator('#aviso')).toContainText('Sesión cerrada');
    expect((await a.get('/api/yo')).status).toBe(401);
    expect((await b.get('/api/yo')).status).toBe(200);
    await panel.locator('[data-accion="cerrar-sesiones"]').click();
    const confirmar = page.locator('[data-confirmar]');
    if (await confirmar.count()) await confirmar.click();
    await expect(page.locator('#aviso')).toContainText('Se cerr');
    await expect(panel).toContainText('No tiene sesiones activas');
    expect((await b.get('/api/yo')).status).toBe(401);
  });

  test('un administrador que no es owner no ve las sesiones de las personas', async ({ nucleo, paginaComo }) => {
    const email = mailNuevo('austral.edu.ar', 'adm');
    await login(nucleo, email);
    const admin = await sesionDe(nucleo, ADMIN_AUSTRAL);
    const page = await paginaComo(admin);
    await page.goto(nucleo.url(undefined, '/administracion'));
    await page.locator('#tabs-admin [data-tab="personas"]').click();
    await page.locator('#busca').fill(email);
    await expect(page.locator(`tr[data-persona="${idDe(nucleo, email)}"]`)).toBeVisible();
    await expect(page.locator('[data-sesiones]')).toHaveCount(0);
    const r = await admin.get(`/api/owner/personas/${idDe(nucleo, email)}/sesiones`);
    expect(r.status).toBe(403);
    expect((await new Cliente(nucleo).get('/api/yo')).status).toBe(401);
  });
});
