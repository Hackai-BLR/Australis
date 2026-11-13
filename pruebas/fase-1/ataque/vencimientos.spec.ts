import { test, expect, SEMILLA, OWNER, ADMIN_AUSTRAL, ALUMNO_AUSTRAL } from '../fixtures.ts';
import { entrar, esperar, obtenerCodigo, reautenticar, verificar } from '../../comun/sesion.ts';

test.use({
  opcionesNucleo: {
    semilla: SEMILLA,
    owner: OWNER,
    entorno: { CODIGO_VIGENCIA_SEG: '2', SESION_COMUN_SEG: '8', SESION_PRIVILEGIADA_SEG: '3', REAUTENTICACION_SEG: '2', REAUTENTICACION_MODO: 'codigo' },
  },
});

test('un código vencido no sirve', async ({ cliente }) => {
  const c = cliente();
  const codigo = await obtenerCodigo(c, ALUMNO_AUSTRAL);
  await esperar(3000);
  const r = await verificar(c, ALUMNO_AUSTRAL, codigo);
  expect(r.status).toBe(400);
  expect(r.json.error).toBe('codigo_invalido');
});

test('la sesión vencida se rechaza en el servidor aunque el navegador mande la cookie', async ({ cliente }) => {
  const alumno = cliente();
  await entrar(alumno, ALUMNO_AUSTRAL);
  const admin = cliente();
  await entrar(admin, ADMIN_AUSTRAL);
  expect((await alumno.get('/api/yo')).status).toBe(200);
  expect((await admin.get('/api/yo')).status).toBe(200);
  await esperar(3500);
  expect((await admin.get('/api/yo')).status).toBe(401);
  expect((await alumno.get('/api/yo')).status).toBe(200);
  await esperar(5500);
  expect((await alumno.get('/api/yo')).status).toBe(401);
});

test('la reautenticación vence', async ({ cliente }) => {
  const c = cliente();
  await entrar(c, OWNER);
  await reautenticar(c);
  await esperar(2500);
  const r = await c.post('/api/owner/universidades', { nombre: 'Tarde', dominio: 'tarde.edu.ar', email_administrador: 'a@tarde.edu.ar' });
  expect(r.status).toBe(403);
  expect(r.json.error).toBe('reautenticacion_requerida');
});
