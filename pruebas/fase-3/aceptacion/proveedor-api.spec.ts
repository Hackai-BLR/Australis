import { crearTestAgente, expect, TIEMPO_FASE3, PROFE_AUSTRAL } from '../fixtures.ts';
import { sesion } from '../../fase-2/lib/cursos.ts';
import { cuerpoMensaje, cursoConEspacio, guion, guionAgregarRuta, llamarModelo, pedidoOk, tokenModelo, urlModelo, archivoEnRama, lineaRuta } from '../lib/agente.ts';

const test = crearTestAgente({ proveedor: 'api' });
test.describe.configure({ mode: 'serial', timeout: TIEMPO_FASE3 });

test.describe('proveedor con clave de API', () => {
  test('reenvía con x-api-key, sin authorization ni el beta de suscripción, y el agente funciona', async ({ nucleo }) => {
    const profe = await sesion(nucleo, PROFE_AUSTRAL);
    const id = await cursoConEspacio(profe, { nombre: 'Curso con Clave de API' });
    const base = urlModelo(nucleo, id);
    const r = await llamarModelo(base, `${new URL(base).pathname}/v1/messages`, {
      token: tokenModelo(nucleo, id),
      cuerpo: cuerpoMensaje('hola'),
      encabezados: { 'anthropic-beta': 'claude-code-20250219' },
    });
    expect(r.status, r.texto).toBe(200);
    const p = nucleo.modelo.pedidos[nucleo.modelo.pedidos.length - 1]!;
    expect(p.encabezados['x-api-key']).toBe(nucleo.tokenReal);
    expect(p.encabezados.authorization).toBeUndefined();
    expect(String(p.encabezados['anthropic-beta'] ?? '')).toContain('claude-code-20250219');
    expect(String(p.encabezados['anthropic-beta'] ?? '')).not.toContain('oauth-2025-04-20');

    guion(nucleo, 'api', guionAgregarRuta('/api-ok', 'SI'));
    const { respuesta } = await pedidoOk(profe, id, 'Agregá la ruta [guion:api]');
    expect(respuesta.archivos).toEqual([{ ruta: 'servidor/app.ts', cambio: 'modificado' }]);
    expect(archivoEnRama(nucleo, id, 'prueba', 'servidor/app.ts')).toContain(lineaRuta('/api-ok', 'SI'));
    for (const pedido of nucleo.modelo.pedidos) {
      expect(pedido.encabezados.authorization).toBeUndefined();
      expect(pedido.encabezados['x-api-key']).toBe(nucleo.tokenReal);
    }
  });
});
