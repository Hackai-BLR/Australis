import { crearTestAcciones, expect, TIEMPO_FASE3, OWNER, TOKENS_POR_RESPUESTA } from '../fixtures.ts';
import { inscribirOk } from '../../fase-2/lib/cursos.ts';
import { cuerpoMensaje, cursoConEspacio, llamarModelo, tokenModelo, urlModelo } from '../../fase-3/lib/agente.ts';
import {
  filasUsoDesde,
  ponerCupoProfesor,
  ponerCupoUniversidad,
  tokensUsados,
  ultimoIdUso,
  universidadConProfesores,
  type UniversidadConProfesores,
} from '../lib.ts';

const test = crearTestAcciones();
test.describe.configure({ mode: 'serial', timeout: TIEMPO_FASE3 });

let u: UniversidadConProfesores;
let id = '';

function llamar(nucleo: any, op: { ruta?: string; cuerpo?: any; encabezados?: Record<string, string> } = {}) {
  const base = urlModelo(nucleo, id);
  return llamarModelo(base, `${new URL(base).pathname}${op.ruta ?? '/v1/messages'}`, {
    token: tokenModelo(nucleo, id),
    cuerpo: op.cuerpo ?? cuerpoMensaje('hola'),
    encabezados: op.encabezados,
  });
}

async function enParalelo(nucleo: any, cantidad: number) {
  const cuerpo = cuerpoMensaje('[lento] gastá todo', { model: 'claude-haiku-5-5', max_tokens: 4096, stream: true });
  return Promise.all(Array.from({ length: cantidad }, () => llamar(nucleo, { cuerpo })));
}

test.describe('nadie consume más que su cupo', () => {
  test.beforeAll(async ({ nucleo }) => {
    test.setTimeout(TIEMPO_FASE3);
    u = await universidadConProfesores(nucleo, OWNER, 2);
    await ponerCupoUniversidad(u.owner, u.uni.id, 50_000_000);
    id = await cursoConEspacio(u.profesores[0]!.cliente, { nombre: 'Curso Gastador' });
    await inscribirOk(u.profesores[0]!.cliente, id, [u.profesores[1]!.email], 'profesor');
  });

  test('los encabezados y el cuerpo del cliente no cambian a quién se descuenta', async ({ nucleo }) => {
    const otro = u.profesores[1]!;
    const desde = ultimoIdUso(nucleo);
    const r = await llamar(nucleo, {
      cuerpo: cuerpoMensaje('hola', { metadata: { user_id: String(otro.id) } }),
      encabezados: {
        'x-campus-usuario': String(otro.id),
        'x-campus-profesor': otro.email,
        'x-campusia-usuario': String(otro.id),
        'x-campus-curso': 'otro-curso',
        'x-campus-universidad': '1',
      },
    });
    expect(r.status).toBe(200);
    const filas = filasUsoDesde(nucleo, desde);
    expect(filas).toHaveLength(1);
    expect(Number(filas[0].usuario_id)).toBe(u.profesores[0]!.id);
    expect(Number(filas[0].universidad_id)).toBe(u.uni.id);
    expect(filas[0].curso_id).toBe(id);
    expect(Number(filas[0].tokens)).toBe(TOKENS_POR_RESPUESTA);
  });

  test('con el cupo del profesor agotado no se reenvía nada, ni en paralelo ni por count_tokens', async ({ nucleo }) => {
    const duena = u.profesores[0]!;
    await ponerCupoProfesor(u.admin, duena.id, tokensUsados(nucleo, { usuario: duena.id }));
    const antes = nucleo.modelo.pedidos.length;
    const desde = ultimoIdUso(nucleo);
    const respuestas = await enParalelo(nucleo, 10);
    for (const r of respuestas) {
      expect(r.status).toBe(429);
      expect(r.json?.error?.type).toBe('rate_limit_error');
      expect(r.encabezados['x-should-retry']).toBe('false');
    }
    const conteo = await llamar(nucleo, { ruta: '/v1/messages/count_tokens' });
    expect(conteo.status).toBe(429);
    expect(nucleo.modelo.pedidos.length).toBe(antes);
    expect(filasUsoDesde(nucleo, desde)).toHaveLength(0);
    await ponerCupoProfesor(u.admin, duena.id, null);
  });

  test('muchos pedidos en paralelo no pasan el cupo del profesor de más', async ({ nucleo }) => {
    const duena = u.profesores[0]!;
    const usado = tokensUsados(nucleo, { usuario: duena.id });
    const cupo = usado + Math.floor(TOKENS_POR_RESPUESTA * 1.5);
    await ponerCupoProfesor(u.admin, duena.id, cupo);
    const antes = nucleo.modelo.pedidos.length;
    const respuestas = await enParalelo(nucleo, 25);
    const reenviadas = nucleo.modelo.pedidos.length - antes;
    expect(reenviadas, 'se reenviaron más pedidos de los que entraban en el cupo').toBeLessThanOrEqual(2);
    expect(reenviadas).toBeGreaterThanOrEqual(1);
    expect(respuestas.filter((r) => r.status === 200)).toHaveLength(reenviadas);
    for (const r of respuestas.filter((x) => x.status !== 200)) {
      expect(r.status).toBe(429);
      expect(r.json?.error?.message).toContain('cupo');
    }
    expect(tokensUsados(nucleo, { usuario: duena.id })).toBeLessThanOrEqual(cupo + TOKENS_POR_RESPUESTA);
    await ponerCupoProfesor(u.admin, duena.id, null);
  });

  test('muchos pedidos en paralelo no pasan el cupo de la universidad de más', async ({ nucleo }) => {
    const usado = tokensUsados(nucleo, { universidad: u.uni.id });
    const cupo = usado + Math.floor(TOKENS_POR_RESPUESTA * 1.5);
    await ponerCupoUniversidad(u.owner, u.uni.id, cupo);
    const antes = nucleo.modelo.pedidos.length;
    const respuestas = await enParalelo(nucleo, 25);
    const reenviadas = nucleo.modelo.pedidos.length - antes;
    expect(reenviadas).toBeLessThanOrEqual(2);
    expect(respuestas.filter((r) => r.status === 200)).toHaveLength(reenviadas);
    for (const r of respuestas.filter((x) => x.status !== 200)) {
      expect(r.status).toBe(429);
      expect(r.json?.error?.message).toContain('universidad');
    }
    expect(tokensUsados(nucleo, { universidad: u.uni.id })).toBeLessThanOrEqual(cupo + TOKENS_POR_RESPUESTA);
    await ponerCupoUniversidad(u.owner, u.uni.id, 50_000_000);
  });

  test('el cupo no se saltea cambiando el límite en USD ni por la base de otra universidad', async ({ nucleo }) => {
    const usado = tokensUsados(nucleo, { universidad: u.uni.id });
    await ponerCupoUniversidad(u.owner, u.uni.id, usado);
    const db = nucleo.base();
    try {
      db.prepare('UPDATE universidades SET limite_usd = 100000 WHERE id = ?').run(u.uni.id);
    } finally {
      db.close();
    }
    const admin = u.admin;
    const viejo = await admin.put('/api/admin/limite', { limite_usd: 100000 });
    expect(viejo.status).toBe(404);
    const antes = nucleo.modelo.pedidos.length;
    expect((await llamar(nucleo)).status).toBe(429);
    expect(nucleo.modelo.pedidos.length).toBe(antes);
    await ponerCupoUniversidad(u.owner, u.uni.id, 50_000_000);
    expect((await llamar(nucleo)).status).toBe(200);
  });
});
