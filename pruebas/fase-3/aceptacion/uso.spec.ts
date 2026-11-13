import { crearTestAgente, expect, TIEMPO_FASE3, LIMITE_AUSTRAL, PROFE_AUSTRAL, ADMIN_AUSTRAL, OWNER } from '../fixtures.ts';
import { sesion } from '../../fase-2/lib/cursos.ts';
import type { Cliente } from '../../comun/http.ts';
import {
  costoEsperado,
  cuerpoMensaje,
  cursoConEspacio,
  filasUso,
  guion,
  guionBash,
  llamarModelo,
  mesActual,
  pedidoOk,
  tokenModelo,
  urlModelo,
  usoAgente,
} from '../lib/agente.ts';
import { USO_POR_RESPUESTA } from '../lib/modelo-falso.ts';

const test = crearTestAgente();
test.describe.configure({ mode: 'serial', timeout: TIEMPO_FASE3 });

let id = '';
let profe: Cliente;

const cerca = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-6);

test.describe('uso medido por curso', () => {
  test.beforeAll(async ({ nucleo }) => {
    test.setTimeout(TIEMPO_FASE3);
    profe = await sesion(nucleo, PROFE_AUSTRAL);
    id = await cursoConEspacio(profe, { nombre: 'Curso que Mide' });
  });

  test('cada respuesta se registra con sus tokens y su costo según la tabla de precios', async ({ nucleo }) => {
    const base = urlModelo(nucleo, id);
    const ruta = `${new URL(base).pathname}/v1/messages`;
    const token = tokenModelo(nucleo, id);
    const filasAntes = filasUso(nucleo, id).length;
    const usdAntes = usoAgente(nucleo, id);
    const modelos = ['claude-haiku-5-5', 'claude-haiku-9-1', 'modelo-desconocido'];
    for (const modelo of modelos) {
      const r = await llamarModelo(base, ruta, { token, cuerpo: cuerpoMensaje('hola', { model: modelo }) });
      expect(r.status).toBe(200);
    }
    const r = await llamarModelo(base, ruta, { token, cuerpo: cuerpoMensaje('hola', { model: 'claude-haiku-5-5', stream: true }) });
    expect(r.status).toBe(200);
    const filas = filasUso(nucleo, id).slice(filasAntes);
    expect(filas).toHaveLength(4);
    const esperados = [...modelos, 'claude-haiku-5-5'];
    let total = 0;
    filas.forEach((f, i) => {
      expect(f.modelo).toBe(esperados[i]);
      expect(Number(f.tokens_entrada)).toBe(USO_POR_RESPUESTA.input_tokens);
      expect(Number(f.tokens_salida)).toBe(USO_POR_RESPUESTA.output_tokens);
      expect(Number(f.tokens_cache_creacion)).toBe(USO_POR_RESPUESTA.cache_creation_input_tokens);
      expect(Number(f.tokens_cache_lectura)).toBe(USO_POR_RESPUESTA.cache_read_input_tokens);
      expect(Number(f.estado)).toBe(200);
      expect(f.mes).toBe(mesActual());
      const esperado = costoEsperado(esperados[i]!, USO_POR_RESPUESTA);
      cerca(Number(f.usd), esperado);
      total += esperado;
    });
    cerca(filas[0].usd, 0.117);
    cerca(filas[1].usd, 0.0378);
    cerca(filas[2].usd, 0.0351);
    cerca(usoAgente(nucleo, id) - usdAntes, total);
    const uni = nucleo.consultar("SELECT id FROM universidades WHERE nombre = 'Universidad Austral'")[0];
    for (const f of filas) expect(Number(f.universidad_id)).toBe(Number(uni.id));
  });

  test('una ejecución del agente suma una fila por cada consulta al modelo', async ({ nucleo }) => {
    guion(nucleo, 'uso', guionBash(['true', 'true']));
    const filasAntes = filasUso(nucleo, id).length;
    const pedidosAntes = nucleo.modelo.pedidos.length;
    const usdAntes = usoAgente(nucleo, id);
    await pedidoOk(profe, id, 'No cambies nada [guion:uso]');
    const nuevos = nucleo.modelo.pedidos.slice(pedidosAntes);
    const filas = filasUso(nucleo, id).slice(filasAntes);
    expect(nuevos.length).toBeGreaterThanOrEqual(3);
    expect(filas).toHaveLength(nuevos.length);
    const total = nuevos.reduce((s, p) => s + costoEsperado(p.json?.model ?? null, USO_POR_RESPUESTA), 0);
    cerca(usoAgente(nucleo, id) - usdAntes, total);
    expect(filas.every((f) => f.modelo === 'claude-haiku-5-5' || typeof f.modelo === 'string')).toBe(true);
  });

  test('los docentes ven el uso del curso y los paneles muestran el uso real', async ({ nucleo }) => {
    const u = await profe.get(`/api/cursos/${id}/uso`);
    expect(u.status).toBe(200);
    const filas = filasUso(nucleo, id);
    expect(u.json.mes).toBe(mesActual());
    expect(u.json.consultas).toBe(filas.length);
    cerca(u.json.usd, usoAgente(nucleo, id));
    expect(u.json.tokens_entrada).toBe(filas.reduce((s, f) => s + Number(f.tokens_entrada), 0));
    expect(u.json.tokens_salida).toBe(filas.reduce((s, f) => s + Number(f.tokens_salida), 0));
    expect(u.json.tokens_cache_creacion).toBe(filas.reduce((s, f) => s + Number(f.tokens_cache_creacion), 0));
    expect(u.json.tokens_cache_lectura).toBe(filas.reduce((s, f) => s + Number(f.tokens_cache_lectura), 0));
    expect(u.json.limite_usd).toBe(LIMITE_AUSTRAL);
    const totalUni = nucleo
      .consultar(
        "SELECT COALESCE(SUM(u.usd), 0) AS t FROM uso_agente u JOIN cursos c ON c.id = u.curso_id JOIN universidades x ON x.id = c.universidad_id WHERE x.nombre = 'Universidad Austral' AND u.mes = ?",
        mesActual(),
      )[0].t;
    cerca(u.json.usd_universidad, Number(totalUni));

    const admin = await sesion(nucleo, ADMIN_AUSTRAL);
    const cursos = await admin.get('/api/admin/cursos');
    cerca(Number(cursos.json.cursos.find((c: any) => c.id === id).uso_usd_mes), usoAgente(nucleo, id));

    const owner = await sesion(nucleo, OWNER);
    const uso = await owner.get('/api/owner/uso');
    const austral = uso.json.universidades.find((x: any) => x.nombre === 'Universidad Austral');
    cerca(Number(austral.agente_usd_mes), Number(totalUni));
  });
});
