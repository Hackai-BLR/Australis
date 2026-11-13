import { testCodigo as test, expect, ADMIN_AUSTRAL, OWNER, UNI_DEMO } from '../fixtures.ts';
import type { Cliente } from '../../comun/http.ts';
import { aleatorio, entrar, reautenticar } from '../../comun/sesion.ts';
import { RUTAS_SENSIBLES, RUTAS_SENSIBLES_OWNER, type Ruta } from '../rutas.ts';

function completar(r: Ruta, valores: Record<string, string>): Ruta {
  const reemplazar = (s: string) => s.replace(/\{(\w+)\}/g, (_, k) => valores[k]);
  return { ...r, ruta: reemplazar(r.ruta), cuerpo: r.cuerpo ? JSON.parse(reemplazar(JSON.stringify(r.cuerpo))) : undefined };
}

function llamar(c: Cliente, r: Ruta) {
  return c.pedir(r.metodo, r.ruta, r.cuerpo ?? (r.metodo === 'DELETE' ? undefined : {}));
}

test.describe('acciones sensibles sin reautenticación', () => {
  test('un administrador recién entrado no puede cambiar roles, invitar, quitar dominios ni crear tokens', async ({ cliente, nucleo }) => {
    const persona = cliente();
    const u = await entrar(persona, `${aleatorio('r.')}@austral.edu.ar`);
    const admin = cliente();
    await entrar(admin, ADMIN_AUSTRAL);
    const nuevo = aleatorio('r');
    for (const plantilla of RUTAS_SENSIBLES) {
      const r = completar(plantilla, { persona: String(u.id), nuevo });
      const desde = nucleo.cantidadMails();
      const res = await llamar(admin, r);
      expect(res.status, `${r.metodo} ${r.ruta}`).toBe(403);
      expect(res.json.error).toBe('reautenticacion_requerida');
      expect(nucleo.mails().slice(desde).filter((m) => m.para !== ADMIN_AUSTRAL)).toHaveLength(0);
    }
    expect((await persona.get('/api/yo')).json.usuario.profesor).toBe(false);
    expect((await admin.get('/api/admin/universidad')).json.dominios).toContain('mail.austral.edu.ar');
    expect(nucleo.consultar('SELECT COUNT(*) AS n FROM usuarios WHERE email LIKE ?', `${nuevo}@%`)[0].n).toBe(0);
  });

  test('el owner recién entrado no puede crear universidades ni invitar administradores', async ({ cliente, nucleo }) => {
    const owner = cliente();
    await entrar(owner, OWNER);
    const unis = await owner.get('/api/owner/universidades');
    const demo = unis.json.universidades.find((x: any) => x.nombre === UNI_DEMO);
    const nuevo = aleatorio('ro');
    for (const plantilla of RUTAS_SENSIBLES_OWNER) {
      const r = completar(plantilla, { uni: String(demo.id), nuevo });
      const res = await llamar(owner, r);
      expect(res.status, `${r.metodo} ${r.ruta}`).toBe(403);
      expect(res.json.error).toBe('reautenticacion_requerida');
    }
    expect(nucleo.consultar('SELECT COUNT(*) AS n FROM dominios WHERE dominio = ?', `${nuevo}.edu.ar`)[0].n).toBe(0);
    expect(nucleo.consultar('SELECT COUNT(*) AS n FROM usuarios WHERE email = ?', `${nuevo}@demo.edu.ar`)[0].n).toBe(0);
  });

  test('la reautenticación de una sesión no vale para otra sesión de la misma persona', async ({ cliente }) => {
    const a = cliente();
    await entrar(a, ADMIN_AUSTRAL);
    await reautenticar(a);
    const b = cliente();
    await entrar(b, ADMIN_AUSTRAL);
    const r = await b.delete('/api/admin/dominios/mail.austral.edu.ar');
    expect(r.status).toBe(403);
    expect(r.json.error).toBe('reautenticacion_requerida');
  });

  test('volver a entrar no cuenta como reautenticación', async ({ cliente }) => {
    const a = cliente();
    await entrar(a, ADMIN_AUSTRAL);
    await entrar(a, ADMIN_AUSTRAL);
    const r = await a.post('/api/admin/invitaciones', { email: `${aleatorio('z.')}@austral.edu.ar`, tipo: 'administrador' });
    expect(r.status).toBe(403);
    expect(r.json.error).toBe('reautenticacion_requerida');
  });

  test('no se puede quitar el último dominio de una universidad', async ({ cliente }) => {
    const owner = cliente();
    await entrar(owner, OWNER);
    await reautenticar(owner);
    const dominio = `${aleatorio('ul')}.edu.ar`;
    const email = `admin@${dominio}`;
    expect((await owner.post('/api/owner/universidades', { nombre: `U ${dominio}`, dominio, email_administrador: email })).status).toBe(201);
    const admin = cliente();
    await entrar(admin, email);
    await reautenticar(admin);
    const r = await admin.delete(`/api/admin/dominios/${dominio}`);
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('ultimo_dominio');
  });
});
