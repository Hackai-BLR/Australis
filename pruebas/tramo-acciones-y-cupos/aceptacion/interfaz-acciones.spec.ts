import type { Page } from '@playwright/test';
import { crearTestAcciones, expect, TIEMPO_FASE3, OWNER, TOKENS_POR_RESPUESTA } from '../fixtures.ts';
import type { Cliente } from '../../comun/http.ts';
import { aleatorio } from '../../comun/sesion.ts';
import { inscribirOk } from '../../fase-2/lib/cursos.ts';
import { ESPERA_AGENTE_MS, cursoConEspacio, guion, pedirAlAgente } from '../../fase-3/lib/agente.ts';
import {
  PRELUDIO_SCRIPT,
  cupoDelCurso,
  idDe,
  ok,
  ponerCupoProfesor,
  ponerCupoUniversidad,
  rolEnCurso,
  sesionDe,
  universidadConProfesores,
  type UniversidadConProfesores,
} from '../lib.ts';

const test = crearTestAcciones();
test.describe.configure({ mode: 'serial', timeout: TIEMPO_FASE3 });

let u: UniversidadConProfesores;
let id = '';
let duena: Cliente;
let profe: Cliente;
let alumnos: string[] = [];

async function abrirEditar(page: Page, nucleo: any) {
  await page.goto(nucleo.url(id));
  await expect(page.locator('.barra')).toContainText('Curso de Confirmaciones');
  await page.locator('[data-panel="p-agente"]').click();
  await expect(page.locator('#p-agente')).toBeVisible();
}

function guionQuitar(nucleo: any, nombre: string, usuario: number) {
  const archivo = `acciones-prueba/${nombre}.mjs`;
  guion(nucleo, nombre, [
    { herramientas: [{ nombre: 'Write', entrada: { file_path: `/repo/${archivo}`, content: `${PRELUDIO_SCRIPT}\nawait intentar('quitar', () => c.pedirQuitar('${usuario}'));\n` } }] },
    { herramientas: [{ nombre: 'Bash', entrada: { command: `node ${archivo}`, description: 'Pide quitar' } }] },
    { texto: 'Pedí quitarlo; falta que lo confirmes.' },
  ]);
}

async function pedirDesdeElChat(page: Page, texto: string) {
  await page.locator('#pedido').fill(texto);
  await page.locator('#enviar-pedido').click();
  await expect(page.locator('#chat .msg.yo').last()).toContainText(texto.replace(/ \[guion:[a-z0-9-]+\]$/, ''));
  await expect(page.locator('#enviar-pedido')).toBeEnabled({ timeout: ESPERA_AGENTE_MS });
}

test.describe('panel Editar: confirmaciones y cupo', () => {
  test.beforeAll(async ({ nucleo }) => {
    test.setTimeout(TIEMPO_FASE3);
    u = await universidadConProfesores(nucleo, OWNER, 2);
    duena = u.profesores[0]!.cliente;
    profe = u.profesores[1]!.cliente;
    id = await cursoConEspacio(duena, { nombre: 'Curso de Confirmaciones' });
    await inscribirOk(duena, id, [u.profesores[1]!.email], 'profesor');
    alumnos = [`${aleatorio('a')}@${u.uni.dominio}`, `${aleatorio('b')}@${u.uni.dominio}`];
    await inscribirOk(duena, id, alumnos);
  });

  test('la confirmación aparece en el panel Editar y al confirmarla se quita a la persona', async ({ nucleo, paginaComo }) => {
    const alumno = idDe(nucleo, alumnos[0]!);
    guionQuitar(nucleo, 'quitarui', alumno);
    const page = await paginaComo(duena);
    await abrirEditar(page, nucleo);
    await pedirDesdeElChat(page, 'Sacá al primer alumno [guion:quitarui]');
    const pendiente = ok(await duena.get(`/api/cursos/${id}/confirmaciones`), 'confirmaciones').confirmaciones.find((x: any) => x.persona.id === alumno);
    expect(pendiente).toBeTruthy();
    const fila = page.locator(`#confirmaciones .confirmacion[data-confirmacion="${pendiente.id}"]`);
    await expect(fila).toBeVisible({ timeout: 30_000 });
    await expect(fila).toContainText('Quitar');
    expect(rolEnCurso(nucleo, id, alumnos[0]!)).toBe('alumno');
    await fila.locator(`[data-aprobar="${pendiente.id}"]`).click();
    await expect(fila).toHaveCount(0);
    await expect(page.locator('#aviso')).toContainText('Listo');
    expect(rolEnCurso(nucleo, id, alumnos[0]!)).toBeNull();
  });

  test('cancelar una confirmación deja todo como estaba', async ({ nucleo, paginaComo }) => {
    const alumno = idDe(nucleo, alumnos[1]!);
    guionQuitar(nucleo, 'cancelarui', alumno);
    const r = await pedirAlAgente(duena, id, 'Sacá al segundo alumno [guion:cancelarui]');
    expect(r.status).toBe(200);
    const pendiente = ok(await duena.get(`/api/cursos/${id}/confirmaciones`), 'confirmaciones').confirmaciones.find((x: any) => x.persona.id === alumno);
    expect(pendiente).toBeTruthy();
    const page = await paginaComo(duena);
    await abrirEditar(page, nucleo);
    const fila = page.locator(`#confirmaciones .confirmacion[data-confirmacion="${pendiente.id}"]`);
    await expect(fila).toBeVisible();
    const otra = await paginaComo(profe);
    await abrirEditar(otra, nucleo);
    await expect(otra.locator(`#confirmaciones .confirmacion[data-confirmacion="${pendiente.id}"]`)).toBeVisible();
    await expect(otra.locator(`[data-aprobar="${pendiente.id}"]`)).toHaveCount(0);
    await fila.locator(`[data-rechazar="${pendiente.id}"]`).click();
    await expect(fila).toHaveCount(0);
    expect(rolEnCurso(nucleo, id, alumnos[1]!)).toBe('alumno');
    expect(nucleo.consultar('SELECT estado FROM confirmaciones_agente WHERE id = ?', pendiente.id)[0].estado).toBe('rechazada');
  });

  test('el panel Editar muestra lo que queda del cupo y avisa al 80 %', async ({ nucleo, paginaComo }) => {
    const yo = await cupoDelCurso(duena, id);
    expect(yo.usado).toBeGreaterThan(0);
    const cupo = Math.ceil((yo.usado * 100) / 85);
    await ponerCupoProfesor(u.admin, u.profesores[0]!.id, cupo);
    const ahora = await cupoDelCurso(duena, id);
    expect(ahora.cupo).toBe(cupo);
    expect(ahora.aviso).toBe(true);
    const page = await paginaComo(duena);
    await abrirEditar(page, nucleo);
    const caja = page.locator('#cupo');
    await expect(caja).toHaveAttribute('data-restante', String(ahora.restante));
    await expect(caja).toHaveAttribute('data-porcentaje', String(ahora.porcentaje));
    await expect(caja).toHaveClass(/\baviso\b/);
    await expect(caja).toContainText('%');
    await expect(page.locator('#enviar-pedido')).toBeEnabled();
    const profePage = await paginaComo(profe);
    await abrirEditar(profePage, nucleo);
    await expect(profePage.locator('#cupo')).not.toHaveClass(/\baviso\b/);
  });

  test('con el cupo agotado el panel Editar lo dice y no deja pedir', async ({ nucleo, paginaComo }) => {
    const yo = await cupoDelCurso(duena, id);
    await ponerCupoProfesor(u.admin, u.profesores[0]!.id, yo.usado);
    const page = await paginaComo(duena);
    await abrirEditar(page, nucleo);
    await expect(page.locator('#cupo')).toContainText('cupo');
    await expect(page.locator('#cupo')).toHaveAttribute('data-restante', '0');
    await expect(page.locator('#enviar-pedido')).toBeDisabled();
    const r = await pedirAlAgente(duena, id, 'Un cambio más');
    expect(r.status).toBe(429);
    expect(r.json.error).toBe('cupo_agotado');
    await ponerCupoProfesor(u.admin, u.profesores[0]!.id, null);
    await ponerCupoUniversidad(u.owner, u.uni.id, (await cupoDelCurso(duena, id)).universidad.usado);
    const page2 = await paginaComo(profe);
    await abrirEditar(page2, nucleo);
    await expect(page2.locator('#cupo')).toContainText('universidad');
    await expect(page2.locator('#enviar-pedido')).toBeDisabled();
    await ponerCupoUniversidad(u.owner, u.uni.id, 1_000_000_000);
    await page2.reload();
    await page2.locator('[data-panel="p-agente"]').click();
    await expect(page2.locator('#enviar-pedido')).toBeEnabled();
    expect(Number((await cupoDelCurso(profe, id)).restante)).toBeGreaterThan(TOKENS_POR_RESPUESTA);
  });
});
