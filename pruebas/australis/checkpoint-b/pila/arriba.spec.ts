import { test, expect } from '@playwright/test';
import { estadoB } from '../../comun/pila-b.ts';
import { pedirAlBackend } from '../../comun/escenario-b.ts';

test('la pila conjunta quedó arriba', async () => {
  const salud = await pedirAlBackend('GET', '/api/health');
  expect(salud.estado).toBe(200);
  expect(estadoB().puerto).toBeGreaterThan(0);
});
