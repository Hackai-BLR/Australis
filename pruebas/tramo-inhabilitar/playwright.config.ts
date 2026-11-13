import { defineConfig } from '@playwright/test';
import comun from '../playwright.config.ts';

export default defineConfig({
  ...comun,
  testDir: '.',
  testMatch: /(aceptacion|ataque)\/.*\.spec\.ts$/,
  globalSetup: '../comun/compilar.ts',
  globalTeardown: '../fase-2/limpieza-global.ts',
});
