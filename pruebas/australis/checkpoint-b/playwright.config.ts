import { defineConfig } from '@playwright/test';
import { DOMINIO } from '../comun/datos-b.ts';

export default defineConfig({
  testDir: '.',
  testMatch: /(aceptacion|ataque)\/.*\.spec\.ts$/,
  globalSetup: '../comun/pila-b-global.ts',
  globalTeardown: '../comun/pila-b-limpieza.ts',
  timeout: 300_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    headless: true,
    launchOptions: { args: [`--host-resolver-rules=MAP ${DOMINIO} 127.0.0.1, MAP *.${DOMINIO} 127.0.0.1`] },
    trace: 'retain-on-failure',
  },
});
