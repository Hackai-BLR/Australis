import { crearTestAgente, expect, TIEMPO_FASE3, PROFE_AUSTRAL } from '../fixtures.ts';
import { sesion } from '../../fase-2/lib/cursos.ts';
import type { Cliente } from '../../comun/http.ts';
import { archivoEnRama, cursoConEspacio, espacioListo, finDe, guion, pedidoOk, pedirAlAgente } from '../lib/agente.ts';

const MAXIMO_SEG = 45;

const test = crearTestAgente({ entorno: { AGENTE_MAX_SEG: String(MAXIMO_SEG) } });
test.describe.configure({ mode: 'serial', timeout: TIEMPO_FASE3 });

let id = '';
let profe: Cliente;

test.describe('una ejecución que supera AGENTE_MAX_SEG', () => {
  test.beforeAll(async ({ nucleo }) => {
    test.setTimeout(TIEMPO_FASE3);
    profe = await sesion(nucleo, PROFE_AUSTRAL);
    id = await cursoConEspacio(profe, { nombre: 'Curso con Tiempo Máximo' });
  });

  test('se corta con un error claro, guarda los cambios parciales y el espacio vuelve a funcionar', async ({ nucleo }) => {
    guion(nucleo, 'eterno', [
      { herramientas: [{ nombre: 'Write', entrada: { file_path: '/repo/parcial.txt', content: 'a medias\n' } }] },
      { herramientas: [{ nombre: 'Bash', entrada: { command: 'sleep 600', description: 'Esperar' } }] },
      { texto: 'Terminé.' },
    ]);
    const inicio = Date.now();
    const r = await pedirAlAgente(profe, id, 'Algo que no termina [guion:eterno]');
    const duracion = (Date.now() - inicio) / 1000;
    expect(r.status).toBe(200);
    const fin = finDe(r);
    expect(fin, r.texto.slice(-2000)).toBeTruthy();
    expect(fin.estado).toBe('error');
    expect(fin.texto).toMatch(/tiempo máximo/i);
    expect(fin.archivos).toEqual([{ ruta: 'parcial.txt', cambio: 'agregado' }]);
    expect(duracion).toBeGreaterThanOrEqual(MAXIMO_SEG - 1);
    expect(duracion).toBeLessThan(MAXIMO_SEG + 120);
    expect(archivoEnRama(nucleo, id, 'prueba', 'parcial.txt')).toBe('a medias');
    const conversacion = await profe.get(`/api/cursos/${id}/agente`);
    expect(conversacion.json.en_curso).toBe(false);
    const ultimo = conversacion.json.mensajes.at(-1);
    expect(ultimo.estado).toBe('error');
    expect(ultimo.texto).toMatch(/tiempo máximo/i);
    const curso = await profe.get(`/api/cursos/${id}`);
    expect(curso.json.cambios_sin_publicar).toBe(true);

    await espacioListo(profe, id);
    guion(nucleo, 'despues', [
      { herramientas: [{ nombre: 'Write', entrada: { file_path: '/repo/despues.txt', content: 'de nuevo\n' } }] },
      { texto: 'Listo.' },
    ]);
    const { respuesta } = await pedidoOk(profe, id, 'Seguimos [guion:despues]');
    expect(respuesta.archivos).toEqual([{ ruta: 'despues.txt', cambio: 'agregado' }]);
    expect(archivoEnRama(nucleo, id, 'prueba', 'despues.txt')).toBe('de nuevo');
  });
});
