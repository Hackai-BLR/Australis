import crypto from 'node:crypto';
import { test, expect, ADMIN_AUSTRAL, ALUMNO_AUSTRAL, PROFE_AUSTRAL } from '../fixtures.ts';
import { COOKIE_SESION } from '../../comun/entorno.ts';
import { aleatorio, entrar, obtenerCodigo, reautenticar, verificar } from '../../comun/sesion.ts';

function textosDeLaBase(nucleo: { consultar: (sql: string, ...p: any[]) => any[] }): string[] {
  const tablas = nucleo.consultar("SELECT name FROM sqlite_master WHERE type = 'table'").map((t: any) => t.name as string);
  const valores: string[] = [];
  for (const t of tablas) {
    for (const fila of nucleo.consultar(`SELECT * FROM "${t}"`)) {
      for (const v of Object.values(fila)) {
        if (v === null || v === undefined) continue;
        if (v instanceof Uint8Array) valores.push(Buffer.from(v).toString('utf8'), Buffer.from(v).toString('hex'));
        else valores.push(String(v));
      }
    }
  }
  return valores;
}

test.describe('ataques a las sesiones', () => {
  test('una cookie inventada no sirve', async ({ cliente }) => {
    const c = cliente();
    for (const valor of [crypto.randomBytes(32).toString('base64url'), 'admin', '1', '', "' OR 1=1 --"]) {
      const r = await c.get('/api/yo', { cookie: `${COOKIE_SESION}=${valor}` });
      expect(r.status, valor).toBe(401);
    }
  });

  test('en la base solo hay huellas: ni el token de sesión, ni el código, ni el token de API aparecen', async ({ cliente, nucleo }) => {
    const email = `${aleatorio('h.')}@austral.edu.ar`;
    const c = cliente();
    const codigo = await obtenerCodigo(c, email);
    const pendientes = textosDeLaBase(nucleo);
    expect(pendientes.some((v) => v === codigo || v.includes(`:${codigo}`) || v.endsWith(codigo))).toBe(false);
    expect((await verificar(c, email, codigo)).status).toBe(200);
    c.email = email;
    const valores = textosDeLaBase(nucleo);
    const sesion = c.sesion!;
    expect(valores.some((v) => v.includes(sesion))).toBe(false);
  });

  test('la huella guardada en la base no sirve como cookie ni como token', async ({ cliente, nucleo }) => {
    const c = cliente();
    await entrar(c, ALUMNO_AUSTRAL);
    const huellas = nucleo.consultar('SELECT huella FROM sesiones').map((f: any) => (f.huella instanceof Uint8Array ? Buffer.from(f.huella).toString('hex') : String(f.huella)));
    expect(huellas.length).toBeGreaterThan(0);
    for (const h of huellas.slice(-5)) {
      expect((await c.get('/api/yo', { cookie: `${COOKIE_SESION}=${h}` })).status).toBe(401);
      expect((await c.get('/api/yo', { sinCookies: true, bearer: h })).status).toBe(401);
    }
  });

  test('una sesión revocada por logout no revive', async ({ cliente }) => {
    const c = cliente();
    await entrar(c, PROFE_AUSTRAL);
    const robada = c.sesion!;
    expect((await c.post('/api/logout')).status).toBe(204);
    const r = await c.get('/api/yo', { cookie: `${COOKIE_SESION}=${robada}` });
    expect(r.status).toBe(401);
    const m = await c.post('/api/logout', {}, { cookie: `${COOKIE_SESION}=${robada}` });
    expect(m.status).toBe(401);
  });

  test('una cookie plantada antes del login se reemplaza por una nueva', async ({ cliente }) => {
    const c = cliente();
    const plantada = crypto.randomBytes(32).toString('base64url');
    c.sesion = plantada;
    const codigo = await obtenerCodigo(c, ALUMNO_AUSTRAL);
    const r = await verificar(c, ALUMNO_AUSTRAL, codigo);
    expect(r.status).toBe(200);
    expect(c.sesion).not.toBe(plantada);
    expect((await c.get('/api/yo', { cookie: `${COOKIE_SESION}=${plantada}` })).status).toBe(401);
  });

  test('la sesión no sirve en el subdominio del contenido de un curso ni en la versión de prueba', async ({ cliente }) => {
    const c = cliente();
    await entrar(c, PROFE_AUSTRAL);
    for (const sub of ['redes-curso', 'redes-prueba']) {
      const r = await c.get('/api/yo', { sub });
      expect(r.status, sub).toBe(404);
      const m = await c.post('/api/logout', {}, { sub, origen: `http://${c.nucleo.host(sub)}` });
      expect(m.status, sub).toBe(404);
    }
    expect((await c.get('/api/yo')).status).toBe(200);
  });
});
