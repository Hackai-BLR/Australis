import { MODO_CODIGO } from '../../comun/nucleo.ts';
import crypto from 'node:crypto';
import { test, expect, SEMILLA, OWNER } from '../fixtures.ts';
import { TURNSTILE_TOKEN_VALIDO } from '../../comun/servicios-falsos.ts';
import { aleatorio, entrar, esperarCodigo, pedirCodigo, verificar } from '../../comun/sesion.ts';

test.use({ opcionesNucleo: { semilla: SEMILLA, owner: OWNER, limitesReales: true, entorno: MODO_CODIGO } });

function cuenta() {
  return `${aleatorio('blq.')}@austral.edu.ar`;
}

function solicitud() {
  return crypto.randomBytes(24).toString('hex');
}

function otroCodigo(codigo: string) {
  return String((Number(codigo) + 1) % 1_000_000).padStart(6, '0');
}

test.describe('nadie deja a otra persona sin poder entrar', () => {
  test('aunque otro agote los pedidos de su mail, la persona recibe su código pasando Turnstile', async ({ cliente, nucleo }) => {
    const victima = cuenta();
    const atacante = cliente();
    for (let i = 0; i < 3; i++) expect((await pedirCodigo(atacante, victima)).status).toBe(200);
    const otraVez = await pedirCodigo(atacante, victima, { turnstile: TURNSTILE_TOKEN_VALIDO });
    expect(otraVez.status).toBe(429);

    const persona = cliente();
    const s = solicitud();
    const sinTurnstile = await pedirCodigo(persona, victima, { solicitud: s });
    expect(sinTurnstile.status).toBe(403);
    expect(sinTurnstile.json.error).toBe('turnstile_requerido');
    const desde = nucleo.cantidadMails();
    const r = await pedirCodigo(persona, victima, { solicitud: s, turnstile: TURNSTILE_TOKEN_VALIDO });
    expect(r.status).toBe(200);
    const codigo = await esperarCodigo(nucleo, victima, desde);
    const v = await verificar(persona, victima, codigo, { solicitud: s });
    expect(v.status).toBe(200);
    expect(v.json.usuario.email).toBe(victima);
  });

  test('las verificaciones falsas y los pedidos de otro no anulan el código que recibió la persona', async ({ cliente, nucleo }) => {
    const victima = cuenta();
    const persona = cliente();
    const s = solicitud();
    const desde = nucleo.cantidadMails();
    expect((await pedirCodigo(persona, victima, { solicitud: s })).status).toBe(200);
    const codigo = await esperarCodigo(nucleo, victima, desde);

    const atacante = cliente();
    expect((await pedirCodigo(atacante, victima)).status).toBe(200);
    expect((await pedirCodigo(atacante, victima, { solicitud: solicitud() })).status).toBe(200);
    for (let i = 0; i < 5; i++) {
      expect((await verificar(cliente(), victima, otroCodigo(codigo))).status).toBe(400);
      expect((await verificar(cliente(), victima, otroCodigo(codigo), { solicitud: solicitud() })).status).toBe(400);
    }
    const r = await verificar(persona, victima, codigo, { solicitud: s });
    expect(r.status).toBe(200);
    expect(r.json.usuario.email).toBe(victima);
  });

  test('el código solo sirve junto con la solicitud que lo pidió y se anula a los 5 fallos de esa solicitud', async ({ cliente, nucleo }) => {
    const email = cuenta();
    const persona = cliente();
    const s = solicitud();
    const desde = nucleo.cantidadMails();
    expect((await pedirCodigo(persona, email, { solicitud: s })).status).toBe(200);
    const codigo = await esperarCodigo(nucleo, email, desde);
    expect((await verificar(cliente(), email, codigo)).status).toBe(400);
    expect((await verificar(cliente(), email, codigo, { solicitud: solicitud() })).status).toBe(400);
    for (let i = 0; i < 5; i++) {
      expect((await verificar(cliente(), email, otroCodigo(codigo), { solicitud: s, turnstile: TURNSTILE_TOKEN_VALIDO })).status).toBe(400);
    }
    const r = await verificar(persona, email, codigo, { solicitud: s, turnstile: TURNSTILE_TOKEN_VALIDO });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('codigo_invalido');
  });

  test('una solicitud mal formada se rechaza', async ({ cliente }) => {
    for (const malo of ['corta', 'x'.repeat(200), 'con espacios y más cosas', 123]) {
      const r = await pedirCodigo(cliente(), cuenta(), { solicitud: malo });
      expect(r.status, JSON.stringify(malo)).toBe(400);
    }
  });

  test('los pedidos de login de otro no dejan a la persona sin reautenticarse', async ({ cliente, nucleo }) => {
    const victima = cuenta();
    const persona = cliente();
    await entrar(persona, victima);
    const atacante = cliente();
    for (let i = 0; i < 3; i++) await pedirCodigo(atacante, victima);
    const desde = nucleo.cantidadMails();
    const r = await persona.post('/api/reautenticacion/codigo');
    expect(r.status).toBe(200);
    const codigo = await esperarCodigo(nucleo, victima, desde);
    expect((await persona.post('/api/reautenticacion/verificar', { codigo })).status).toBe(200);
  });
});
