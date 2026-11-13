import { test, expect, SEMILLA, OWNER } from '../fixtures.ts';
import { TURNSTILE_TOKEN_VALIDO } from '../../comun/servicios-falsos.ts';
import { aleatorio, esperarCodigo, pedirCodigo, verificar } from '../../comun/sesion.ts';

test.use({ opcionesNucleo: { semilla: SEMILLA, owner: OWNER, limitesReales: true, entorno: { PROXIES_CONFIABLES: '192.0.2.1' } } });

function cuenta() {
  return `${aleatorio('ip.')}@austral.edu.ar`;
}

test.describe('IP del cliente detrás de un proxy no confiable', () => {
  test('un CF-Connecting-IP inventado en cada pedido no saltea Turnstile', async ({ cliente }) => {
    const respuestas: number[] = [];
    let ultimo: any = null;
    for (let i = 0; i < 8; i++) {
      const r = await pedirCodigo(cliente(), cuenta());
      respuestas.push(r.status);
      ultimo = r.json;
    }
    expect(respuestas.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(respuestas.slice(5)).toEqual([403, 403, 403]);
    expect(ultimo.error).toBe('turnstile_requerido');
  });

  test('la sesión y la auditoría guardan la IP de la conexión, no la inventada', async ({ cliente, nucleo }) => {
    const email = cuenta();
    const c = cliente();
    const desde = nucleo.cantidadMails();
    expect((await pedirCodigo(c, email, { turnstile: TURNSTILE_TOKEN_VALIDO })).status).toBe(200);
    const codigo = await esperarCodigo(nucleo, email, desde);
    const r = await verificar(c, email, codigo, { turnstile: TURNSTILE_TOKEN_VALIDO });
    expect(r.status).toBe(200);
    const sesion = nucleo.consultar('SELECT s.ip FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id WHERE u.email = ?', email);
    expect(sesion.map((s: any) => s.ip)).toEqual(['127.0.0.1']);
    const aud = nucleo.consultar("SELECT ip FROM auditoria WHERE accion = 'login' AND detalle LIKE ?", `%${email}%`);
    expect(aud.map((a: any) => a.ip)).toEqual(['127.0.0.1']);
    expect(JSON.stringify(aud)).not.toContain(c.ip);
  });
});
