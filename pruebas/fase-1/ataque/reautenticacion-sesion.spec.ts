import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { test, expect, ADMIN_AUSTRAL, OWNER, UNI_DEMO } from '../fixtures.ts';
import { Cliente } from '../../comun/http.ts';
import { BINARIO } from '../../comun/entorno.ts';
import { aleatorio, entrar } from '../../comun/sesion.ts';
import { RUTAS_SENSIBLES, RUTAS_SENSIBLES_OWNER, type Ruta } from '../rutas.ts';

function completar(r: Ruta, valores: Record<string, string>): Ruta {
  const reemplazar = (s: string) => s.replace(/\{(\w+)\}/g, (_, k) => valores[k]);
  return { ...r, ruta: reemplazar(r.ruta), cuerpo: r.cuerpo ? JSON.parse(reemplazar(JSON.stringify(r.cuerpo))) : undefined };
}

function llamar(c: Cliente, r: Ruta, op: any = {}) {
  return c.pedir(r.metodo, r.ruta, r.cuerpo ?? (r.metodo === 'DELETE' ? undefined : {}), op);
}

async function sensiblesRechazadas(c: Cliente, persona: number, estado: number, error: string) {
  const nuevo = aleatorio('rx');
  for (const plantilla of RUTAS_SENSIBLES) {
    const r = completar(plantilla, { persona: String(persona), nuevo });
    const res = await llamar(c, r);
    expect(res.status, `${r.metodo} ${r.ruta}`).toBe(estado);
    expect(res.json.error, `${r.metodo} ${r.ruta}`).toBe(error);
  }
}

test.describe('modo sesion: sesiones que no sirven', () => {
  test('una sesión cerrada con logout no habilita acciones sensibles', async ({ cliente }) => {
    const persona = cliente();
    const u = await entrar(persona, `${aleatorio('rx.')}@austral.edu.ar`);
    const admin = cliente();
    await entrar(admin, ADMIN_AUSTRAL);
    const robada = admin.clonarSesion();
    expect((await admin.post('/api/logout')).status).toBe(204);
    await sensiblesRechazadas(robada, u.id, 401, 'no_autenticado');
    expect((await persona.get('/api/yo')).json.usuario.profesor).toBe(false);
  });

  test('una sesión cerrada desde otra o reemplazada por un login nuevo no sirve', async ({ cliente }) => {
    const persona = cliente();
    const u = await entrar(persona, `${aleatorio('rx.')}@austral.edu.ar`);
    const nueva = cliente();
    await entrar(nueva, ADMIN_AUSTRAL);

    const reemplazada = nueva.clonarSesion();
    await entrar(nueva, ADMIN_AUSTRAL);
    await sensiblesRechazadas(reemplazada, u.id, 401, 'no_autenticado');
    expect((await persona.get('/api/yo')).json.usuario.profesor).toBe(false);
  });

  test('una sesión revocada en la base no sirve aunque tenga reautenticada_en', async ({ cliente, nucleo }) => {
    const persona = cliente();
    const u = await entrar(persona, `${aleatorio('rx.')}@austral.edu.ar`);
    const admin = cliente();
    const a = await entrar(admin, ADMIN_AUSTRAL);
    const db = nucleo.base();
    try {
      db.prepare('UPDATE sesiones SET revocada = 1 WHERE usuario_id = ? AND revocada = 0').run(a.id);
    } finally {
      db.close();
    }
    await sensiblesRechazadas(admin, u.id, 401, 'no_autenticado');
  });

  test('una cookie inventada no habilita acciones sensibles', async ({ cliente }) => {
    const persona = cliente();
    const u = await entrar(persona, `${aleatorio('rx.')}@austral.edu.ar`);
    const c = cliente();
    c.sesion = randomBytes(32).toString('base64url');
    await sensiblesRechazadas(c, u.id, 401, 'no_autenticado');
  });
});

test('el núcleo no arranca con un modo de reautenticación desconocido', async ({ nucleo }) => {
  const r = spawnSync(BINARIO, [], {
    env: { ...process.env, ...nucleo.entorno, PUERTO: '0', REAUTENTICACION_MODO: 'nunca' },
    encoding: 'utf8',
    timeout: 8000,
  });
  expect(r.status).not.toBeNull();
  expect(r.status).not.toBe(0);
});
