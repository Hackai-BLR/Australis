import { defineConfig } from '@playwright/test';
import { DOMINIO } from './comun/entorno.ts';

export default defineConfig({
  testDir: '.',
  testMatch: /fase-\d+\/.*\.spec\.ts$/,
  globalSetup: ['./comun/compilar.ts', './fase-3/preparar-global.ts'],
  globalTeardown: ['./fase-2/limpieza-global.ts', './fase-3/limpieza-global.ts'],
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: process.env.PRUEBAS_WORKERS ? Number(process.env.PRUEBAS_WORKERS) : 4,
  retries: 0,
  reporter: [['list']],
  use: {
    headless: true,
    launchOptions: {
      args: [`--host-resolver-rules=MAP ${DOMINIO} 127.0.0.1, MAP *.${DOMINIO} 127.0.0.1`],
    },
    trace: 'retain-on-failure',
  },
});
