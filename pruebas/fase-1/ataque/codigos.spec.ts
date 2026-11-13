import { MODO_CODIGO } from '../../comun/nucleo.ts';
import { test, expect, SEMILLA, OWNER } from '../fixtures.ts';
import { TURNSTILE_SECRET, TURNSTILE_SITE_KEY, TURNSTILE_TOKEN_VALIDO } from '../../comun/servicios-falsos.ts';
import { aleatorio, entrar, esperarCodigo, obtenerCodigo, pedirCodigo, verificar } from '../../comun/sesion.ts';

test.use({ opcionesNucleo: { semilla: SEMILLA, owner: OWNER, limitesReales: true, entorno: MODO_CODIGO } });

function cuenta() {
  return `${aleatorio('cod.')}@austral.edu.ar`;
}

function otroCodigo(codigo: string) {
  return String((Number(codigo) + 1) % 1_000_000).padStart(6, '0');
}

test.describe('ataques a los códigos de login', () => {
  test('un código equivocado o con otro formato no entra', async ({ cliente }) => {
    const email = cuenta();
    const c = cliente();
    const codigo = await obtenerCodigo(c, email);
    for (const malo of [otroCodigo(codigo), '12345', '1234567', 'abcdef', '', ' ' + codigo + 'x']) {
      const r = await verificar(cliente(), email, malo);
      expect(r.status, `código ${JSON.stringify(malo)}`).toBe(400);
      expect(r.json.error).toBe('codigo_invalido');
      expect(r.setCookies.some((s) => s.startsWith('campusia_sesion=') && !/max-age=0/i.test(s))).toBe(false);
    }
  });

  test('al quinto intento fallido el código se anula aunque después llegue el correcto, sin bloquear la cuenta', async ({ cliente }) => {
    const email = cuenta();
    const atacante = cliente();
    const codigo = await obtenerCodigo(atacante, email);
    for (let i = 0; i < 5; i++) {
      const otro = cliente();
      expect((await verificar(otro, email, otroCodigo(codigo))).status).toBe(400);
    }
    const r = await verificar(cliente(), email, codigo);
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('codigo_invalido');
    const legitimo = cliente();
    const u = await entrar(legitimo, email);
    expect(u.email).toBe(email);
  });

  test('el código de una persona no sirve para otra', async ({ cliente }) => {
    const a = cuenta();
    const b = cuenta();
    const c = cliente();
    const codigoA = await obtenerCodigo(c, a);
    await obtenerCodigo(cliente(), b);
    const r = await verificar(cliente(), b, codigoA);
    expect(r.status).toBe(400);
    expect((await verificar(cliente(), a, codigoA)).status).toBe(200);
  });

  test('pedir un código nuevo anula el anterior', async ({ cliente }) => {
    const email = cuenta();
    const viejo = await obtenerCodigo(cliente(), email);
    const nuevo = await obtenerCodigo(cliente(), email);
    if (viejo !== nuevo) {
      expect((await verificar(cliente(), email, viejo)).status).toBe(400);
    }
    expect((await verificar(cliente(), email, nuevo)).status).toBe(200);
  });

  test('después de 3 códigos por mail en 15 minutos, desde otra IP hace falta Turnstile y desde la misma no se manda más', async ({ cliente, nucleo }) => {
    const email = cuenta();
    for (let i = 0; i < 3; i++) expect((await pedirCodigo(cliente(), email)).status).toBe(200);
    const desde = nucleo.cantidadMails();
    const r = await pedirCodigo(cliente(), email);
    expect(r.status).toBe(403);
    expect(r.json.error).toBe('turnstile_requerido');
    const insistente = cliente();
    for (let i = 0; i < 3; i++) {
      expect((await pedirCodigo(insistente, email, { turnstile: TURNSTILE_TOKEN_VALIDO })).status).toBe(200);
    }
    const r2 = await pedirCodigo(insistente, email, { turnstile: TURNSTILE_TOKEN_VALIDO });
    expect(r2.status).toBe(429);
    expect(r2.json.error).toBe('demasiados_intentos');
    await new Promise((x) => setTimeout(x, 500));
    expect(nucleo.mails().slice(desde).filter((m) => m.para === email)).toHaveLength(3);
  });

  test('desde una IP, después de 5 pedidos hace falta Turnstile y se verifica con el secreto', async ({ cliente, nucleo }) => {
    const c = cliente();
    for (let i = 0; i < 5; i++) expect((await pedirCodigo(c, cuenta())).status).toBe(200);
    const sin = await pedirCodigo(c, cuenta());
    expect(sin.status).toBe(403);
    expect(sin.json.error).toBe('turnstile_requerido');
    expect(sin.json.site_key).toBe(TURNSTILE_SITE_KEY);
    const malo = await pedirCodigo(c, cuenta(), { turnstile: 'token-inventado' });
    expect(malo.status).toBe(403);
    expect(malo.json.error).toBe('turnstile_invalido');
    const antes = nucleo.turnstile.pedidos.length;
    const email = cuenta();
    const desde = nucleo.cantidadMails();
    const ok = await pedirCodigo(c, email, { turnstile: TURNSTILE_TOKEN_VALIDO });
    expect(ok.status).toBe(200);
    await esperarCodigo(nucleo, email, desde);
    const pedido = nucleo.turnstile.pedidos.slice(antes).find((p) => p.cuerpo.response === TURNSTILE_TOKEN_VALIDO);
    expect(pedido).toBeTruthy();
    expect(pedido!.cuerpo.secret).toBe(TURNSTILE_SECRET);
    expect(pedido!.cuerpo.remoteip).toBe(c.ip);
    const otraIp = cliente();
    expect((await pedirCodigo(otraIp, cuenta())).status).toBe(200);
  });

  test('desde una IP hay un tope de 20 pedidos cada 15 minutos aun con Turnstile', async ({ cliente }) => {
    const c = cliente();
    for (let i = 0; i < 20; i++) {
      const r = await pedirCodigo(c, cuenta(), { turnstile: TURNSTILE_TOKEN_VALIDO });
      expect(r.status, `pedido ${i + 1}`).toBe(200);
    }
    const r = await pedirCodigo(c, cuenta(), { turnstile: TURNSTILE_TOKEN_VALIDO });
    expect(r.status).toBe(429);
    expect(r.json.error).toBe('demasiados_intentos');
  });

  test('después de 5 verificaciones fallidas desde una IP, verificar exige Turnstile', async ({ cliente }) => {
    const email = cuenta();
    const legitimo = cliente();
    const codigo = await obtenerCodigo(legitimo, email);
    const atacante = cliente();
    const victima = cuenta();
    await obtenerCodigo(cliente(), victima);
    for (let i = 0; i < 5; i++) expect((await verificar(atacante, victima, String(100000 + i))).status).toBe(400);
    const r = await verificar(atacante, email, codigo);
    expect(r.status).toBe(403);
    expect(r.json.error).toBe('turnstile_requerido');
    const conMalo = await verificar(atacante, email, codigo, { turnstile: 'falso' });
    expect(conMalo.status).toBe(403);
    expect(conMalo.json.error).toBe('turnstile_invalido');
    const conBueno = await verificar(atacante, email, codigo, { turnstile: TURNSTILE_TOKEN_VALIDO });
    expect(conBueno.status).toBe(200);
  });

  test('los dominios no habilitados no reciben código ni crean cuenta', async ({ cliente, nucleo }) => {
    const email = `${aleatorio('x.')}@gmail.com`;
    const desde = nucleo.cantidadMails();
    const r = await pedirCodigo(cliente(), email);
    expect(r.status).toBe(200);
    await new Promise((x) => setTimeout(x, 700));
    expect(nucleo.mails().slice(desde).filter((m) => m.para === email)).toHaveLength(0);
    for (const intento of ['000000', '123456', '999999']) {
      expect((await verificar(cliente(), email, intento)).status).toBe(400);
    }
    expect(nucleo.consultar('SELECT COUNT(*) AS n FROM usuarios WHERE email = ?', email)[0].n).toBe(0);
  });

  test('un dominio parecido a uno habilitado no sirve', async ({ cliente, nucleo }) => {
    const desde = nucleo.cantidadMails();
    const trampas = [
      `${aleatorio('a.')}@austral.edu.ar.evil.com`,
      `${aleatorio('a.')}@evilaustral.edu.ar`,
      `${aleatorio('a.')}@austral.edu.ar@evil.com`,
      `${aleatorio('a.')}%austral.edu.ar@evil.com`,
    ];
    for (const email of trampas) {
      const r = await pedirCodigo(cliente(), email);
      expect([200, 400], email).toContain(r.status);
    }
    await new Promise((x) => setTimeout(x, 700));
    const nuevos = nucleo.mails().slice(desde);
    expect(nuevos.filter((m) => !m.para.endsWith('@austral.edu.ar') && !m.para.endsWith('@mail.austral.edu.ar'))).toHaveLength(0);
    expect(nuevos).toHaveLength(0);
  });

  test('el código de reautenticación queda atado a la sesión que lo pidió', async ({ cliente, nucleo }) => {
    const email = cuenta();
    const a = cliente();
    await entrar(a, email);
    const b = cliente();
    await entrar(b, email);
    const desde = nucleo.cantidadMails();
    expect((await a.post('/api/reautenticacion/codigo')).status).toBe(200);
    const codigo = await esperarCodigo(nucleo, email, desde);
    const r = await b.post('/api/reautenticacion/verificar', { codigo });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('codigo_invalido');
  });

  test('un código de login no sirve para reautenticar ni uno de reautenticación para entrar', async ({ cliente, nucleo }) => {
    const email = cuenta();
    const a = cliente();
    await entrar(a, email);
    const codigoLogin = await obtenerCodigo(cliente(), email);
    const r = await a.post('/api/reautenticacion/verificar', { codigo: codigoLogin });
    expect(r.status).toBe(400);
    const desde = nucleo.cantidadMails();
    expect((await a.post('/api/reautenticacion/codigo')).status).toBe(200);
    const codigoReaut = await esperarCodigo(nucleo, email, desde);
    if (codigoReaut !== codigoLogin) {
      expect((await verificar(cliente(), email, codigoReaut)).status).toBe(400);
    }
  });

  test('cinco intentos de reautenticación fallidos anulan el código', async ({ cliente, nucleo }) => {
    const email = cuenta();
    const a = cliente();
    await entrar(a, email);
    const desde = nucleo.cantidadMails();
    expect((await a.post('/api/reautenticacion/codigo')).status).toBe(200);
    const codigo = await esperarCodigo(nucleo, email, desde);
    for (let i = 0; i < 5; i++) expect((await a.post('/api/reautenticacion/verificar', { codigo: otroCodigo(codigo) })).status).toBe(400);
    expect((await a.post('/api/reautenticacion/verificar', { codigo })).status).toBe(400);
    expect((await a.get('/api/yo')).status).toBe(200);
  });
});
