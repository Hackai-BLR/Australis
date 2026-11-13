import { crearTestConDestino, expect, TIEMPO_FASE3, OWNER, TOKENS_POR_RESPUESTA } from '../fixtures.ts';
import { inscribirOk } from '../../fase-2/lib/cursos.ts';
import { cuerpoMensaje, cursoConEspacio, finDe, guion, guionBash, llamarModelo, pedidoOk, pedirAlAgente, tokenModelo, urlModelo } from '../../fase-3/lib/agente.ts';
import {
  cupoDelCurso,
  cuposAdmin,
  filasUsoDesde,
  ok,
  ponerCupoProfesor,
  ponerCupoUniversidad,
  profesorEn,
  tokensUsados,
  ultimoIdUso,
  universidadConProfesores,
  type UniversidadConProfesores,
} from '../lib.ts';

const test = crearTestConDestino();
test.describe.configure({ mode: 'serial', timeout: TIEMPO_FASE3 });

let u: UniversidadConProfesores;
let id = '';

function duena() {
  return u.profesores[0]!;
}

function profe() {
  return u.profesores[1]!;
}

function directo(nucleo: any, texto = 'hola', extra: Record<string, unknown> = {}, encabezados: Record<string, string> = {}) {
  const base = urlModelo(nucleo, id);
  return llamarModelo(base, `${new URL(base).pathname}/v1/messages`, { token: tokenModelo(nucleo, id), cuerpo: cuerpoMensaje(texto, extra), encabezados });
}

test.describe('consumo de tokens del modelo', () => {
  test.beforeAll(async ({ nucleo }) => {
    test.setTimeout(TIEMPO_FASE3);
    u = await universidadConProfesores(nucleo, OWNER, 2);
    await ponerCupoUniversidad(u.owner, u.uni.id, 10_000_000);
    id = await cursoConEspacio(duena().cliente, { nombre: 'Curso que Consume' });
    await inscribirOk(duena().cliente, id, [profe().email], 'profesor');
    guion(nucleo, 'corto', guionBash(['true']));
  });

  test('cada pedido al modelo descuenta sus tokens del profesor y de la universidad', async ({ nucleo }) => {
    const desde = ultimoIdUso(nucleo);
    for (const extra of [{}, { model: 'claude-haiku-9-1' }, { stream: true }]) {
      const r = await directo(nucleo, 'hola', extra);
      expect(r.status, r.texto).toBe(200);
    }
    const filas = filasUsoDesde(nucleo, desde);
    expect(filas).toHaveLength(3);
    for (const f of filas) {
      expect(Number(f.tokens)).toBe(TOKENS_POR_RESPUESTA);
      expect(Number(f.usuario_id)).toBe(duena().id);
      expect(Number(f.universidad_id)).toBe(u.uni.id);
      expect(f.curso_id).toBe(id);
    }
    const usadoDuena = tokensUsados(nucleo, { usuario: duena().id });
    const usadoUni = tokensUsados(nucleo, { universidad: u.uni.id });
    expect(usadoDuena).toBeGreaterThanOrEqual(3 * TOKENS_POR_RESPUESTA);
    const yo = await cupoDelCurso(duena().cliente, id);
    expect(yo).toMatchObject({ usado: usadoDuena, cupo: null, porcentaje: null, aviso: false, agotado: null, modelo_disponible: true });
    expect(yo.universidad).toMatchObject({ cupo: 10_000_000, usado: usadoUni, restante: 10_000_000 - usadoUni });
    expect(yo.restante).toBe(10_000_000 - usadoUni);
    const c = await cuposAdmin(u.admin);
    expect(profesorEn(c, duena().id).usado).toBe(usadoDuena);
    expect(c.universidad.usado).toBe(usadoUni);
    const o = ok(await u.owner.get('/api/owner/cupos'), 'owner').universidades.find((x: any) => x.id === u.uni.id);
    expect(o.usado).toBe(usadoUni);
  });

  test('el agente descuenta al profesor que hace el pedido', async ({ nucleo }) => {
    const desde = ultimoIdUso(nucleo);
    const antesDuena = tokensUsados(nucleo, { usuario: duena().id });
    await pedidoOk(profe().cliente, id, 'Nada [guion:corto]');
    const filas = filasUsoDesde(nucleo, desde);
    expect(filas.length).toBeGreaterThanOrEqual(2);
    for (const f of filas) expect(Number(f.usuario_id)).toBe(profe().id);
    expect(tokensUsados(nucleo, { usuario: duena().id })).toBe(antesDuena);
    const yo = await cupoDelCurso(profe().cliente, id);
    expect(yo.usado).toBe(tokensUsados(nucleo, { usuario: profe().id }));
    expect(yo.usado).toBe(filas.reduce((s, f) => s + Number(f.tokens), 0));
  });

  test('el aviso del 80 % llega al profesor y al administrador sin mandar mails', async ({ nucleo }) => {
    const mails = nucleo.cantidadMails();
    const usado = tokensUsados(nucleo, { usuario: profe().id });
    const cupo = Math.ceil((usado * 100) / 85);
    await ponerCupoProfesor(u.admin, profe().id, cupo);
    const yo = await cupoDelCurso(profe().cliente, id);
    expect(yo).toMatchObject({ cupo, usado, aviso: true, agotado: null, restante: cupo - usado });
    expect(yo.porcentaje).toBeGreaterThanOrEqual(80);
    expect(profesorEn(await cuposAdmin(u.admin), profe().id)).toMatchObject({ aviso: true, cupo, propio: true });
    expect(nucleo.cantidadMails()).toBe(mails);
    await ponerCupoProfesor(u.admin, profe().id, null);
  });

  test('al agotarse el cupo del profesor se corta su agente y el intermediario sin reenviar; otro profesor sigue', async ({ nucleo }) => {
    const usado = tokensUsados(nucleo, { usuario: duena().id });
    await ponerCupoProfesor(u.admin, duena().id, usado);
    expect((await cupoDelCurso(duena().cliente, id)).agotado).toBe('profesor');
    const antes = nucleo.modelo.pedidos.length;
    const desde = ultimoIdUso(nucleo);
    const mensajes = ok(await duena().cliente.get(`/api/cursos/${id}/agente`), 'agente').mensajes.length;
    const r = await pedirAlAgente(duena().cliente, id, 'Otro cambio [guion:corto]');
    expect(r.status).toBe(429);
    expect(r.json.error).toBe('cupo_agotado');
    expect(r.json.cupo).toBe('profesor');
    expect(r.json.mensaje).toContain('cupo');
    expect(ok(await duena().cliente.get(`/api/cursos/${id}/agente`), 'agente').mensajes.length).toBe(mensajes);
    const m = await directo(nucleo);
    expect(m.status).toBe(429);
    expect(m.json.type).toBe('error');
    expect(m.json.error.type).toBe('rate_limit_error');
    expect(m.json.error.message).toContain('cupo');
    expect(m.encabezados['x-should-retry']).toBe('false');
    expect(nucleo.modelo.pedidos.length).toBe(antes);
    expect(filasUsoDesde(nucleo, desde)).toHaveLength(0);

    await pedidoOk(profe().cliente, id, 'Sigo yo [guion:corto]');
    for (const f of filasUsoDesde(nucleo, desde)) expect(Number(f.usuario_id)).toBe(profe().id);
    expect(tokensUsados(nucleo, { usuario: duena().id })).toBe(usado);

    await ponerCupoProfesor(u.admin, duena().id, null);
    expect((await directo(nucleo)).status).toBe(200);
  });

  test('al agotarse el cupo de la universidad se corta para todos y subirlo lo habilita', async ({ nucleo }) => {
    const usado = tokensUsados(nucleo, { universidad: u.uni.id });
    await ponerCupoUniversidad(u.owner, u.uni.id, usado);
    const antes = nucleo.modelo.pedidos.length;
    for (const p of [duena(), profe()]) {
      const r = await pedirAlAgente(p.cliente, id, 'Un cambio [guion:corto]');
      expect(r.status, p.email).toBe(429);
      expect(r.json.error).toBe('cupo_agotado');
      expect(r.json.cupo).toBe('universidad');
      expect(r.json.mensaje).toContain('universidad');
      expect((await cupoDelCurso(p.cliente, id)).agotado).toBe('universidad');
    }
    const m = await directo(nucleo);
    expect(m.status).toBe(429);
    expect(m.json.error.message).toContain('universidad');
    expect(nucleo.modelo.pedidos.length).toBe(antes);
    await ponerCupoUniversidad(u.owner, u.uni.id, 10_000_000);
    await pedidoOk(profe().cliente, id, 'De nuevo [guion:corto]');
  });

  test('si el cupo se agota durante una ejecución, termina con un error claro', async ({ nucleo }) => {
    guion(nucleo, 'muchos', guionBash(['true', 'true', 'true', 'true']));
    const usado = tokensUsados(nucleo, { usuario: profe().id });
    await ponerCupoProfesor(u.admin, profe().id, usado + Math.floor(TOKENS_POR_RESPUESTA * 1.5));
    const antes = nucleo.modelo.pedidos.length;
    const r = await pedirAlAgente(profe().cliente, id, 'Muchos pasos [guion:muchos]');
    expect(r.status).toBe(200);
    const fin = finDe(r);
    expect(fin.estado).toBe('error');
    expect(fin.texto).toContain('cupo');
    expect(nucleo.modelo.pedidos.length - antes).toBe(2);
    const a = ok(await profe().cliente.get(`/api/cursos/${id}/agente`), 'agente');
    expect(a.en_curso).toBe(false);
    expect(a.mensajes[a.mensajes.length - 1].estado).toBe('error');
    await ponerCupoProfesor(u.admin, profe().id, null);
  });

  test('con la suscripción sin uso disponible el panel Editar lo muestra y nada se reenvía hasta que vuelve', async ({ nucleo, paginaComo }) => {
    const destino = nucleo.conmutable;
    destino.agotado = true;
    destino.retryAfter = 20;
    const rechazados = destino.rechazados;
    const m = await directo(nucleo);
    expect(m.status).toBe(429);
    expect(m.json.error.type).toBe('rate_limit_error');
    expect(m.json.error.message).toContain('No hay uso disponible');
    expect(m.encabezados['x-should-retry']).toBe('false');
    expect(m.texto).not.toContain('Usage limit reached');
    expect(destino.rechazados).toBe(rechazados + 1);
    destino.agotado = false;

    const yo = await cupoDelCurso(duena().cliente, id);
    expect(yo.modelo_disponible).toBe(false);
    const antes = nucleo.modelo.pedidos.length;
    const r = await pedirAlAgente(duena().cliente, id, 'Algo [guion:corto]');
    expect(r.status).toBe(503);
    expect(r.json.error).toBe('sin_uso_disponible');
    expect(r.json.mensaje).toContain('No hay uso disponible');
    const otra = await directo(nucleo);
    expect(otra.status).toBe(429);
    expect(nucleo.modelo.pedidos.length).toBe(antes);

    const page = await paginaComo(duena().cliente);
    await page.goto(nucleo.url(id));
    await page.locator('[data-panel="p-agente"]').click();
    await expect(page.locator('#cupo')).toContainText('No hay uso disponible por el momento');
    await expect(page.locator('#enviar-pedido')).toBeDisabled();

    await expect.poll(async () => (await cupoDelCurso(duena().cliente, id)).modelo_disponible, { timeout: 40_000 }).toBe(true);
    await pedidoOk(duena().cliente, id, 'Ya hay uso [guion:corto]');
  });

  test('si el proveedor se queda sin uso durante una ejecución, termina con un error claro', async ({ nucleo, paginaComo }) => {
    const destino = nucleo.conmutable;
    destino.agotado = true;
    destino.retryAfter = 3;
    try {
      const r = await pedirAlAgente(duena().cliente, id, 'Algo más [guion:corto]');
      expect(r.status).toBe(200);
      const fin = finDe(r);
      expect(fin.estado).toBe('error');
      expect(fin.texto).toContain('No hay uso disponible');
    } finally {
      destino.agotado = false;
    }
    const page = await paginaComo(duena().cliente);
    await page.goto(nucleo.url(id));
    await page.locator('[data-panel="p-agente"]').click();
    await expect(page.locator('#chat .msg.ag.error').last()).toContainText('No hay uso disponible');
    await expect.poll(async () => (await cupoDelCurso(duena().cliente, id)).modelo_disponible, { timeout: 30_000 }).toBe(true);
  });
});
