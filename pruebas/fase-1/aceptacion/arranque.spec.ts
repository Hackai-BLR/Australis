import { spawnSync } from 'node:child_process';
import { test, expect } from '../fixtures.ts';
import { BINARIO } from '../../comun/entorno.ts';
import { aleatorio, entrar } from '../../comun/sesion.ts';

function arrancar(entorno: Record<string, string>) {
  return spawnSync(BINARIO, [], { env: { ...process.env, ...entorno }, encoding: 'utf8', timeout: 8000 });
}

test('crear-owner crea el owner y es idempotente', async ({ nucleo, cliente }) => {
  const email = `${aleatorio('owner.')}@otro-dominio.prueba`;
  const r1 = nucleo.ejecutar(['crear-owner', email]);
  expect(r1.status).toBe(0);
  const r2 = nucleo.ejecutar(['crear-owner', email.toUpperCase()]);
  expect(r2.status).toBe(0);
  const filas = nucleo.consultar('SELECT COUNT(*) AS n FROM usuarios WHERE email = ?', email);
  expect(Number(filas[0].n)).toBe(1);
  const u = await entrar(cliente(), email);
  expect(u.owner).toBe(true);
});

test('crear-owner rechaza un mail inválido', async ({ nucleo }) => {
  expect(nucleo.ejecutar(['crear-owner', 'no-es-un-mail']).status).not.toBe(0);
});

test('migrar es idempotente', async ({ nucleo }) => {
  expect(nucleo.ejecutar(['migrar']).status).toBe(0);
  expect(nucleo.ejecutar(['migrar']).status).toBe(0);
});

test('el núcleo no arranca sin SESSION_SECRET o con uno corto', async ({ nucleo }) => {
  const sinSecreto = { ...nucleo.entorno, PUERTO: '0' } as Record<string, string>;
  delete sinSecreto.SESSION_SECRET;
  const env = { ...process.env, ...sinSecreto };
  delete env.SESSION_SECRET;
  const r1 = spawnSync(BINARIO, [], { env, encoding: 'utf8', timeout: 8000 });
  expect(r1.status).not.toBe(0);
  expect(r1.status).not.toBeNull();
  const r2 = arrancar({ ...nucleo.entorno, PUERTO: '0', SESSION_SECRET: 'corto' });
  expect(r2.status).not.toBe(0);
  expect(r2.status).not.toBeNull();
});

test('el núcleo no arranca con brevo sin clave ni con un proveedor desconocido', async ({ nucleo }) => {
  const r1 = arrancar({ ...nucleo.entorno, PUERTO: '0', PROVEEDOR_EMAIL: 'brevo', BREVO_API_KEY: '' });
  expect(r1.status).not.toBe(0);
  expect(r1.status).not.toBeNull();
  const r2 = arrancar({ ...nucleo.entorno, PUERTO: '0', PROVEEDOR_EMAIL: 'palomas' });
  expect(r2.status).not.toBe(0);
  expect(r2.status).not.toBeNull();
});
