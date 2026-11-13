import { crearTestAgente, expect, TIEMPO_FASE3, PROFE_AUSTRAL } from '../fixtures.ts';
import { esperarHasta, sesion } from '../../fase-2/lib/cursos.ts';
import { corriendo } from '../../fase-2/lib/docker.ts';
import { ESPERA_ESPACIO_MS, cursoConEspacio, enPrueba, esperarRespuesta, guion, guionBash, nombreEspacio, pedirAlAgente, finDe } from '../lib/agente.ts';

const test = crearTestAgente({ inactividadEspacioSeg: 25 });
test.describe.configure({ mode: 'serial', timeout: TIEMPO_FASE3 });

test.describe('inactividad del espacio de trabajo', () => {
  test('el espacio se apaga solo, se despierta con una visita y no se corta en medio de una ejecución', async ({ nucleo }) => {
    const profe = await sesion(nucleo, PROFE_AUSTRAL);
    const id = await cursoConEspacio(profe, { nombre: 'Curso que Duerme' });
    const nombre = nombreEspacio(nucleo, id);

    await esperarHasta(() => !corriendo(nombre), 180_000, 'el espacio se detiene por inactividad');
    const e = await profe.get(`/api/cursos/${id}/espacio`);
    expect(e.json.espacio).toBe('apagado');
    expect(nucleo.consultar('SELECT estado FROM espacios WHERE curso_id = ?', id)[0].estado).toBe('apagado');

    const primera = await enPrueba(profe, id, '/salud');
    expect([200, 503]).toContain(primera.status);
    if (primera.status === 503) {
      expect(primera.texto).toContain('Preparando la versión de prueba');
      expect(primera.encabezados['retry-after']).toBeTruthy();
    }
    await esperarRespuesta(() => enPrueba(profe, id, '/salud'), (r) => r.status === 200, ESPERA_ESPACIO_MS, 'la visita despierta el espacio');
    expect(corriendo(nombre)).toBe(true);

    guion(nucleo, 'largo', guionBash(['sleep 45']));
    const enCurso = pedirAlAgente(profe, id, 'Esperá un rato [guion:largo]');
    await new Promise((r) => setTimeout(r, 40_000));
    expect(corriendo(nombre)).toBe(true);
    const a = await profe.get(`/api/cursos/${id}/agente`);
    expect(a.json.en_curso).toBe(true);
    const r = await enCurso;
    expect(r.status).toBe(200);
    expect(finDe(r)?.estado).toBe('ok');
  });
});
