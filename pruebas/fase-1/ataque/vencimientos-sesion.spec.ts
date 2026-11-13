import { test, expect, SEMILLA, OWNER, ADMIN_AUSTRAL } from '../fixtures.ts';
import { aleatorio, entrar, esperar } from '../../comun/sesion.ts';

test.use({ opcionesNucleo: { semilla: SEMILLA, owner: OWNER, entorno: { SESION_PRIVILEGIADA_SEG: '3' } } });

test('en modo sesion una sesión privilegiada vencida no habilita acciones sensibles', async ({ cliente }) => {
  const persona = cliente();
  const u = await entrar(persona, `${aleatorio('rv.')}@austral.edu.ar`);
  const admin = cliente();
  await entrar(admin, ADMIN_AUSTRAL);
  const vigente = await admin.post('/api/admin/invitaciones', { email: `${aleatorio('rvi.')}@austral.edu.ar`, tipo: 'profesor' });
  expect(vigente.status, vigente.texto).toBe(201);
  await esperar(4000);
  const cookie = admin.sesion;
  for (const [metodo, ruta, cuerpo] of [
    ['PUT', `/api/admin/personas/${u.id}/profesor`, { profesor: true }],
    ['POST', '/api/admin/invitaciones', { email: `${aleatorio('rvi.')}@austral.edu.ar`, tipo: 'administrador' }],
    ['DELETE', '/api/admin/dominios/mail.austral.edu.ar', undefined],
  ] as Array<[string, string, any]>) {
    const r = await admin.pedir(metodo, ruta, cuerpo, { cookie: `campusia_sesion=${cookie}` });
    expect(r.status, `${metodo} ${ruta}`).toBe(401);
    expect(r.json.error).toBe('no_autenticado');
  }
  expect((await persona.get('/api/yo')).json.usuario.profesor).toBe(false);
});
