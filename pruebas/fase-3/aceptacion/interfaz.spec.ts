import type { Page } from '@playwright/test';
import { crearTestAgente, expect, TIEMPO_FASE3, LIMITE_AUSTRAL, PROFE_AUSTRAL, ALUMNO_AUSTRAL } from '../fixtures.ts';
import { DOMINIO } from '../../comun/entorno.ts';
import { ejecutarSql, inscribirOk, sesion } from '../../fase-2/lib/cursos.ts';
import type { Cliente } from '../../comun/http.ts';
import {
  ESPERA_AGENTE_MS,
  ESPERA_PUBLICACION_MS,
  ESPERA_RECARGA_MS,
  cursoConEspacio,
  enPublicado,
  esperarRespuesta,
  guion,
  guionAgregarRuta,
  guionCambiarValor,
  limiteUniversidad,
  pedidoOk,
  publicarOk,
} from '../lib/agente.ts';

const test = crearTestAgente();
test.describe.configure({ mode: 'serial', timeout: TIEMPO_FASE3 });

const RE_DOMINIO = DOMINIO.replace(/\./g, '\\.');

let id = '';
let profe: Cliente;
let alumno: Cliente;

async function abrirCurso(page: Page, nucleo: any) {
  await page.goto(nucleo.url(id));
  await expect(page.locator('.barra')).toContainText('Curso de la Interfaz');
}

function valor(r: { status: number; json: any }) {
  return r.status === 200 ? r.json?.valor : undefined;
}

test.describe('interfaz del agente, publicar y versiones', () => {
  test.beforeAll(async ({ nucleo }) => {
    test.setTimeout(TIEMPO_FASE3);
    profe = await sesion(nucleo, PROFE_AUSTRAL);
    alumno = await sesion(nucleo, ALUMNO_AUSTRAL);
    id = await cursoConEspacio(profe, { nombre: 'Curso de la Interfaz' });
    await inscribirOk(profe, id, [ALUMNO_AUSTRAL]);
  });

  test('los modos cambian el iframe y la prueba lleva el borde ámbar', async ({ nucleo, paginaComo }) => {
    const page = await paginaComo(profe);
    await abrirCurso(page, nucleo);
    await expect(page.locator('[data-modo="publicado"]')).toHaveClass(/\bon\b/);
    await expect(page.locator('#lienzo')).not.toHaveClass(/\bprueba\b/);
    await expect(page.locator('iframe#curso')).toHaveAttribute('src', new RegExp(`^http://${id}-curso\\.${RE_DOMINIO}:${nucleo.puerto}/`));
    await page.locator('[data-modo="prueba"]').click();
    await expect(page.locator('[data-modo="prueba"]')).toHaveClass(/\bon\b/);
    await expect(page.locator('[data-modo="prueba"]')).toHaveClass(/\bprueba\b/);
    await expect(page.locator('#lienzo')).toHaveClass(/\bprueba\b/);
    await expect(page.locator('iframe#curso')).toHaveAttribute('src', new RegExp(`^http://${id}-prueba\\.${RE_DOMINIO}:${nucleo.puerto}/`), { timeout: ESPERA_RECARGA_MS });
    await expect(page.frameLocator('iframe#curso').locator('[data-prueba="curso-nombre"]')).toHaveText('Curso de la Interfaz', { timeout: ESPERA_RECARGA_MS });
    const sandbox = ((await page.locator('iframe#curso').getAttribute('sandbox')) ?? '').split(/\s+/);
    for (const f of ['allow-scripts', 'allow-same-origin', 'allow-forms']) expect(sandbox).toContain(f);
    expect(sandbox).not.toContain('allow-top-navigation');
    await page.locator('[data-modo="publicado"]').click();
    await expect(page.locator('#lienzo')).not.toHaveClass(/\bprueba\b/);
    await expect(page.locator('iframe#curso')).toHaveAttribute('src', new RegExp(`^http://${id}-curso\\.`));
  });

  test('el panel Editar muestra el chat en vivo y los archivos cambiados, y Publicar publica', async ({ nucleo, paginaComo }) => {
    guion(nucleo, 'ui', guionAgregarRuta('/ui', 'UNO', 'Agregué la ruta ui.'));
    const page = await paginaComo(profe);
    await abrirCurso(page, nucleo);
    await expect(page.locator('#publicar')).toBeDisabled();
    await page.locator('[data-panel="p-agente"]').click();
    await expect(page.locator('#p-agente')).toBeVisible();
    await expect(page.locator('[data-modo="prueba"]')).toHaveClass(/\bon\b/);
    await expect(page.locator('#lienzo')).toHaveClass(/\bprueba\b/);
    await expect(page.locator('#chat .msg.ag')).toContainText('¿Qué querés cambiar del curso?');
    await page.locator('#pedido').fill('Agregá la ruta ui [guion:ui]');
    await page.locator('#enviar-pedido').click();
    await expect(page.locator('#chat .msg.yo')).toContainText('Agregá la ruta ui');
    await expect(page.locator('#chat .msg.ag.en-curso')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#enviar-pedido')).toBeDisabled();
    const respuesta = page.locator('#chat .msg.ag').last();
    await expect(respuesta).toContainText('Agregué la ruta ui.', { timeout: ESPERA_AGENTE_MS });
    await expect(page.locator('#chat .msg.ag.en-curso')).toHaveCount(0);
    const fila = respuesta.locator('.cambio [data-archivo="servidor/app.ts"]');
    await expect(fila).toBeVisible();
    await expect(fila).toHaveClass(/\bm\b/);
    await expect(fila).toContainText('~');
    await expect(page.locator('#enviar-pedido')).toBeEnabled();

    await expect(page.locator('#publicar')).toBeEnabled();
    await page.locator('#publicar').click();
    await expect(page.locator('#publicar')).toBeDisabled();
    await expect(page.locator('#publicar')).toContainText('Publicando');
    await expect(page.locator('#aviso')).toContainText('Publicada la v1', { timeout: ESPERA_PUBLICACION_MS });
    await expect(page.locator('[data-modo="publicado"]')).toHaveClass(/\bon\b/);
    await expect(page.locator('#lienzo')).not.toHaveClass(/\bprueba\b/);
    expect(valor(await enPublicado(alumno, id, '/ui'))).toBe('UNO');

    await page.reload();
    await page.locator('[data-panel="p-agente"]').click();
    await expect(page.locator('#chat .msg.yo')).toHaveCount(1);
    await expect(page.locator('#chat .msg.ag')).toHaveCount(1);
    await expect(page.locator('#chat [data-archivo="servidor/app.ts"]')).toBeVisible();
  });

  test('el panel Versiones lista las versiones y Volver publica una anterior', async ({ nucleo, paginaComo }) => {
    guion(nucleo, 'ui2', guionCambiarValor('/ui', 'UNO', 'DOS'));
    await pedidoOk(profe, id, 'Cambiá la ruta ui [guion:ui2]');
    const page = await paginaComo(profe);
    await abrirCurso(page, nucleo);
    await page.locator('[data-panel="p-versiones"]').click();
    await expect(page.locator('#p-versiones')).toBeVisible();
    await expect(page.locator('#ver-lista .ver.pru')).toContainText('Cambios sin publicar');
    await expect(page.locator('#ver-lista .ver.pub[data-version="1"]')).toContainText('Publicada · v1');

    await publicarOk(profe, id, { descripcion: 'Ruta ui en DOS' });
    await page.reload();
    await page.locator('[data-panel="p-versiones"]').click();
    await expect(page.locator('#ver-lista .ver.pru')).toHaveCount(0);
    await expect(page.locator('#ver-lista .ver.pub[data-version="2"]')).toContainText('Publicada · v2');
    await expect(page.locator('#ver-lista .ver[data-version="1"]')).toContainText('v1');
    const items = page.locator('#ver-lista .ver[data-version]');
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toHaveAttribute('data-version', '2');
    await page.locator('#ver-lista [data-volver="1"]').click();
    await expect(page.locator('#aviso')).toContainText('Volviste a la v1. Se publicó como v3', { timeout: ESPERA_PUBLICACION_MS });
    await expect(page.locator('#ver-lista .ver.pub[data-version="3"]')).toBeVisible({ timeout: 30_000 });
    await esperarRespuesta(() => enPublicado(alumno, id, '/ui'), (r) => valor(r) === 'UNO', 30_000, 'publicado vuelve a UNO');
  });

  test('si la publicación falla se ve el error y el tráfico sigue en la versión anterior', async ({ nucleo, paginaComo }) => {
    guion(nucleo, 'romper', [
      { herramientas: [{ nombre: 'Read', entrada: { file_path: '/repo/servidor/index.ts' } }] },
      {
        herramientas: [
          {
            nombre: 'Edit',
            entrada: {
              file_path: '/repo/servidor/index.ts',
              old_string: 'const base = abrirBase(configuracion.datos);',
              new_string: 'if (process.env.PORT) process.exit(3);\nconst base = abrirBase(configuracion.datos);',
            },
          },
        ],
      },
      { texto: 'Listo.' },
    ]);
    await pedidoOk(profe, id, 'Rompé el arranque [guion:romper]');
    const page = await paginaComo(profe);
    await abrirCurso(page, nucleo);
    await page.locator('[data-modo="prueba"]').click();
    await expect(page.locator('#publicar')).toBeEnabled({ timeout: 30_000 });
    await page.locator('#publicar').click();
    await expect(page.locator('#aviso')).toContainText('No se pudo publicar', { timeout: ESPERA_PUBLICACION_MS });
    await expect(page.locator('#p-versiones')).toBeVisible();
    await expect(page.locator('#ver-error')).toContainText(/arranque/i);
    await expect(page.locator('#ver-error pre')).toBeVisible();
    await expect(page.locator('#ver-lista .ver.pub[data-version="3"]')).toBeVisible();
    expect(valor(await enPublicado(alumno, id, '/ui'))).toBe('UNO');
  });

  test('al agotarse el cupo de uso el chat muestra el error', async ({ nucleo, paginaComo }) => {
    ejecutarSql(nucleo, "UPDATE universidades SET cupo_tokens = 0 WHERE nombre = 'Universidad Austral'");
    try {
      const page = await paginaComo(profe);
      await abrirCurso(page, nucleo);
      await page.locator('[data-panel="p-agente"]').click();
      await page.locator('#pedido').fill('Un cambio más');
      await page.locator('#enviar-pedido').click();
      await expect(page.locator('#chat .msg.ag.error').last()).toContainText('cupo', { timeout: 30_000 });
    } finally {
      ejecutarSql(nucleo, "UPDATE universidades SET cupo_tokens = 40000000 WHERE nombre = 'Universidad Austral'");
    }
  });

  test('los alumnos no ven los controles de edición', async ({ nucleo, paginaComo }) => {
    const page = await paginaComo(alumno);
    await abrirCurso(page, nucleo);
    await expect(page.frameLocator('iframe#curso').locator('[data-prueba="curso-nombre"]')).toHaveText('Curso de la Interfaz', { timeout: ESPERA_RECARGA_MS });
    for (const sel of ['[data-modo="prueba"]', '[data-modo="publicado"]', '[data-panel="p-agente"]', '[data-panel="p-versiones"]', '#publicar']) {
      await expect(page.locator(sel), sel).toBeHidden();
    }
    await expect(page.locator('iframe#curso')).toHaveAttribute('src', new RegExp(`^http://${id}-curso\\.`));
  });
});
