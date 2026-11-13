import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /checkpoint-[a-z]\/.*\.spec\.ts$/,
  globalSetup: './comun/pila-global.ts',
  globalTeardown: './comun/pila-limpieza.ts',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { headless: true, trace: 'retain-on-failure' },
});
