import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { RAIZ_REPO } from '../../comun/entorno.ts';

const HANDOFFS = path.join(RAIZ_REPO, 'handoffs');

function handoffFase4(): { nombre: string; texto: string } | null {
  const nombres = fs
    .readdirSync(HANDOFFS)
    .filter((n) => /^\d{6}_\d{4}_fase-4.*\.md$/.test(n))
    .sort();
  const nombre = nombres.at(-1);
  if (!nombre) return null;
  return { nombre, texto: fs.readFileSync(path.join(HANDOFFS, nombre), 'utf8') };
}

function seccion(texto: string, titulo: RegExp): string {
  const lineas = texto.split('\n');
  const inicio = lineas.findIndex((l) => /^##\s/.test(l) && titulo.test(l));
  if (inicio < 0) return '';
  const resto = lineas.slice(inicio + 1);
  const fin = resto.findIndex((l) => /^##\s/.test(l));
  return (fin < 0 ? resto : resto.slice(0, fin)).join('\n');
}

test('existe el handoff de la fase 4 con la revisión de seguridad del núcleo', () => {
  const h = handoffFase4();
  expect(h, 'falta handoffs/AAMMDD_HHMM_fase-4-....md').not.toBeNull();
  const { texto } = h!;
  expect(texto).toMatch(/contratos\/fase-4\.md/);
  for (const t of [/Qué se hizo/i, /Cómo se prueba/i, /Resultado de las pruebas/i, /Desvíos/i, /Pendientes/i]) {
    expect(seccion(texto, t).trim().length, String(t)).toBeGreaterThan(0);
  }
  const revision = seccion(texto, /Revisión de seguridad/i);
  expect(revision.trim().length).toBeGreaterThan(400);
  for (const parte of ['enrutador', 'supervisor', 'puente', 'SIU', 'archivos', 'endurecimiento']) {
    expect(revision.toLowerCase(), parte).toContain(parte.toLowerCase());
  }
  expect(revision).toMatch(/Encontrado/i);
  expect(revision).toMatch(/Corregido/i);
  for (const v of ['ARCHIVOS_CUOTA_PERSONA', 'SUBIDAS_SIMULTANEAS', 'DESCARGAS_SIMULTANEAS', 'retirar-archivo']) {
    expect(texto, v).toContain(v);
  }
});

test('la unidad y el ejemplo de entorno llevan los límites nuevos de archivos y memoria', () => {
  const unidad = fs.readFileSync(path.join(RAIZ_REPO, 'despliegue', 'campusia-nucleo.service'), 'utf8');
  expect(unidad).toMatch(/^MemoryMax=\S+/m);
  const ejemplo = fs.readFileSync(path.join(RAIZ_REPO, 'despliegue', 'campusia.env.ejemplo'), 'utf8');
  for (const v of ['ARCHIVOS_CUOTA_PERSONA', 'SUBIDAS_SIMULTANEAS', 'DESCARGAS_SIMULTANEAS']) {
    expect(ejemplo).toMatch(new RegExp(`^${v}=\\d+$`, 'm'));
  }
});
