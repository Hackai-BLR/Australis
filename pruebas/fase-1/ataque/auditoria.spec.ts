import { test, expect, ADMIN_AUSTRAL } from '../fixtures.ts';
import { entrar } from '../../comun/sesion.ts';

test('la auditoría es de solo agregado: la base rechaza modificarla o borrarla', async ({ cliente, nucleo }) => {
  await entrar(cliente(), ADMIN_AUSTRAL);
  const antes = nucleo.consultar('SELECT COUNT(*) AS n FROM auditoria')[0].n;
  expect(antes).toBeGreaterThan(0);
  const db = nucleo.base();
  try {
    expect(() => db.exec("UPDATE auditoria SET accion = 'nada'")).toThrow();
    expect(() => db.exec('DELETE FROM auditoria')).toThrow();
  } finally {
    db.close();
  }
  expect(nucleo.consultar('SELECT COUNT(*) AS n FROM auditoria')[0].n).toBeGreaterThanOrEqual(antes);
  expect(nucleo.consultar("SELECT COUNT(*) AS n FROM auditoria WHERE accion = 'nada'")[0].n).toBe(0);
});

test('la API no expone rutas para modificar la auditoría', async ({ cliente }) => {
  const c = cliente();
  await entrar(c, ADMIN_AUSTRAL);
  const eventos = (await c.get('/api/admin/auditoria')).json.eventos;
  const id = eventos[0].id;
  for (const [metodo, ruta] of [
    ['DELETE', `/api/admin/auditoria/${id}`],
    ['PUT', `/api/admin/auditoria/${id}`],
    ['DELETE', '/api/admin/auditoria'],
    ['POST', '/api/admin/auditoria'],
  ]) {
    const r = await c.pedir(metodo, ruta, metodo === 'DELETE' ? undefined : { accion: 'x' });
    expect([404, 405], `${metodo} ${ruta}`).toContain(r.status);
  }
  const despues = (await c.get('/api/admin/auditoria')).json.eventos;
  expect(despues.find((e: any) => e.id === id)).toBeTruthy();
});
