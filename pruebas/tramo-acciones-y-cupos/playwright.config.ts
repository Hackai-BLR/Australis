import { defineConfig } from '@playwright/test';
import comun from '../playwright.config.ts';

export default defineConfig({
  ...comun,
  testDir: '.',
  testMatch: /(aceptacion|ataque)\/.*\.spec\.ts$/,
  globalSetup: ['../comun/compilar.ts', '../fase-3/preparar-global.ts'],
  globalTeardown: ['../fase-2/limpieza-global.ts', '../fase-3/limpieza-global.ts'],
});
