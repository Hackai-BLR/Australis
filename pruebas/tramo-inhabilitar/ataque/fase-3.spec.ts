import { crearTestTramo, expect, PROFE_AUSTRAL, PROFE2_AUSTRAL } from '../fixtures.ts';
import { AUSTRAL, archivar, cursoDePrueba, ejecutarSql, fila, idUniversidad, sesion, sesionReautenticada } from '../lib.ts';

const test = crearTestTramo();

test('un curso archivado no se edita con el agente, no se publica ni vuelve a una versión', async ({ nucleo }) => {
  const curso = cursoDePrueba(nucleo, { universidad: idUniversidad(nucleo, AUSTRAL), dueno: PROFE_AUSTRAL, profesores: [PROFE2_AUSTRAL] });
  ejecutarSql(nucleo, "UPDATE cursos SET estado = 'listo' WHERE id = ?", curso);
  const dueno = await sesionReautenticada(nucleo, PROFE_AUSTRAL);
  const profe = await sesion(nucleo, PROFE2_AUSTRAL);
  expect((await archivar(dueno, curso)).status).toBe(200);
  for (const c of [dueno, profe]) {
    const intentos: [string, () => Promise<any>][] = [
      ['encender el espacio', () => c.post(`/api/cursos/${curso}/espacio`, {})],
      ['pedir al agente', () => c.post(`/api/cursos/${curso}/agente`, { pedido: 'Agregá una página' })],
      ['publicar', () => c.post(`/api/cursos/${curso}/publicar`, {})],
      ['volver a una versión', () => c.post(`/api/cursos/${curso}/versiones/1/volver`, {})],
    ];
    for (const [nombre, intento] of intentos) {
      const r = await intento();
      expect(r.status, `${nombre}: ${r.texto}`).toBe(409);
      expect(r.json.error, nombre).toBe('curso_archivado');
    }
  }
  expect(fila(nucleo, 'SELECT COUNT(*) AS n FROM mensajes_agente WHERE curso_id = ?', curso).n).toBe(0);
  expect(fila(nucleo, 'SELECT COUNT(*) AS n FROM publicaciones WHERE curso_id = ?', curso).n).toBe(0);
  expect(fila(nucleo, 'SELECT COUNT(*) AS n FROM espacios WHERE curso_id = ?', curso).n).toBe(0);
});

test('nadie entra a la versión de prueba de un curso archivado', async ({ nucleo }) => {
  const curso = cursoDePrueba(nucleo, { universidad: idUniversidad(nucleo, AUSTRAL), dueno: PROFE_AUSTRAL, profesores: [PROFE2_AUSTRAL] });
  ejecutarSql(nucleo, "UPDATE cursos SET estado = 'listo' WHERE id = ?", curso);
  const dueno = await sesionReautenticada(nucleo, PROFE_AUSTRAL);
  const profe = await sesion(nucleo, PROFE2_AUSTRAL);
  expect((await archivar(dueno, curso)).status).toBe(200);
  const origen = `${nucleo.esquema()}://${nucleo.host(`${curso}-prueba`)}`;
  for (const c of [dueno, profe]) {
    for (const [metodo, ruta] of [['GET', '/'], ['GET', '/api/algo'], ['POST', '/api/algo']]) {
      const r = await c.pedir(metodo, ruta, metodo === 'POST' ? { x: 1 } : undefined, { sub: `${curso}-prueba`, origen });
      expect(r.status, `${metodo} ${ruta}: ${r.texto.slice(0, 200)}`).toBe(403);
      expect(r.texto).toContain('Curso archivado');
    }
  }
});
