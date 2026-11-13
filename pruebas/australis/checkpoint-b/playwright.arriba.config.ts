import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './pila',
  testMatch: /arriba\.spec\.ts$/,
  globalSetup: '../comun/pila-b-global.ts',
  timeout: 30_000,
  workers: 1,
  reporter: [['list']],
});
