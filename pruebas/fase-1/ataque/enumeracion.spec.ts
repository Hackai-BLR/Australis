import { test, expect, PROFE_AUSTRAL } from '../fixtures.ts';
import { aleatorio, pedirCodigo, verificar } from '../../comun/sesion.ts';
import type { Respuesta } from '../../comun/http.ts';

test('pedir código responde igual para cuentas existentes, inexistentes y dominios no habilitados', async ({ cliente, nucleo }) => {
  const casos = [PROFE_AUSTRAL, `${aleatorio('no.')}@austral.edu.ar`, `${aleatorio('no.')}@gmail.com`];
  const respuestas: Respuesta[] = [];
  for (const email of casos) respuestas.push(await pedirCodigo(cliente(), email));
  for (const r of respuestas) {
    expect(r.status).toBe(200);
    expect(r.texto).toBe(respuestas[0].texto);
    expect(r.setCookies).toEqual([]);
  }
  const nueva = casos[1];
  expect(nucleo.consultar('SELECT COUNT(*) AS n FROM usuarios WHERE email = ?', nueva)[0].n).toBe(0);
});

test('verificar un código malo responde igual exista o no la cuenta', async ({ cliente }) => {
  const casos = [PROFE_AUSTRAL, `${aleatorio('no.')}@austral.edu.ar`, `${aleatorio('no.')}@gmail.com`];
  const respuestas: Respuesta[] = [];
  for (const email of casos) respuestas.push(await verificar(cliente(), email, '000000'));
  for (const r of respuestas) {
    expect(r.status).toBe(400);
    expect(r.texto).toBe(respuestas[0].texto);
  }
});
