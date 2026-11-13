import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { BINARIO, INTERFAZ_DIST, RAIZ_REPO } from '../../comun/entorno.ts';

const DESPLIEGUE = path.join(RAIZ_REPO, 'despliegue');
const UNIDAD = path.join(DESPLIEGUE, 'campusia-nucleo.service');
const INSTALAR = path.join(DESPLIEGUE, 'instalar.sh');
const EJEMPLO_ENV = path.join(DESPLIEGUE, 'campusia.env.ejemplo');
const CADDYFILE = path.join(DESPLIEGUE, 'Caddyfile');
const LITESTREAM = path.join(DESPLIEGUE, 'respaldo', 'litestream.yml');

function directivas(texto: string): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const linea of texto.split('\n')) {
    const l = linea.trim();
    if (!l || l.startsWith('#') || l.startsWith(';') || l.startsWith('[')) continue;
    const i = l.indexOf('=');
    if (i === -1) continue;
    const k = l.slice(0, i).trim();
    m.set(k, [...(m.get(k) ?? []), l.slice(i + 1).trim()]);
  }
  return m;
}

test.describe('despliegue de la fase 4', () => {
  test('la unidad del núcleo define dónde viven los archivos y los respaldos', () => {
    const d = directivas(fs.readFileSync(UNIDAD, 'utf8'));
    const env = (d.get('Environment') ?? []).join(' ');
    expect(env).toContain('RAIZ_ARCHIVOS=/srv/campusia/archivos');
    expect(env).toContain('DIR_RESPALDOS=/srv/campusia/respaldos');
    expect((d.get('ReadWritePaths') ?? []).join(' ')).toContain('/srv/campusia');
  });

  test('el ejemplo de entorno trae las variables nuevas sin secretos', () => {
    const texto = fs.readFileSync(EJEMPLO_ENV, 'utf8');
    for (const v of [
      'ARCHIVOS_CUOTA_CURSO',
      'ARCHIVOS_MAX_BYTES',
      'ARCHIVOS_TIPOS',
      'LIMITE_API_MINUTO',
      'LIMITE_CUERPO_JSON',
      'TIEMPO_ESPERA_ENCABEZADOS_SEG',
    ]) {
      expect(texto, v).toMatch(new RegExp(`^${v}=`, 'm'));
    }
    expect(texto).toMatch(/^ARCHIVOS_CUOTA_CURSO=1073741824$/m);
    expect(texto).toMatch(/^ARCHIVOS_MAX_BYTES=26214400$/m);
    const tipos = /^ARCHIVOS_TIPOS=(.*)$/m.exec(texto)![1].split(',').map((t) => t.trim().toLowerCase());
    for (const peligroso of ['html', 'htm', 'svg', 'xhtml', 'xml', 'js', 'exe', 'sh']) expect(tipos).not.toContain(peligroso);
    expect(texto).not.toMatch(/[A-Za-z0-9_-]{43}/);
  });

  test('Caddy limita el tamaño de los pedidos', () => {
    const texto = fs.readFileSync(CADDYFILE, 'utf8');
    expect(texto).toMatch(/request_body\s*\{[^}]*max_size\s+\d+(MB|M|mb)?/s);
  });

  test('Litestream sigue desactivado por defecto y sin credenciales', () => {
    const texto = fs.readFileSync(LITESTREAM, 'utf8');
    expect(texto).not.toMatch(/access-key-id:\s*[A-Za-z0-9]{16,}/);
    expect(texto).not.toMatch(/secret-access-key:\s*[A-Za-z0-9/+]{20,}/);
    const unidad = fs.readFileSync(path.join(DESPLIEGUE, 'respaldo', 'campusia-respaldo.timer'), 'utf8');
    expect(unidad).toContain('OnCalendar');
  });

  test('instalar.sh crea las carpetas de archivos y de respaldos solo para el dueño', () => {
    expect(fs.existsSync(BINARIO)).toBe(true);
    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'campusia-instalar-'));
    const correr = () =>
      spawnSync('bash', [INSTALAR, '--binario', BINARIO, '--interfaz', INTERFAZ_DIST, '--raiz', raiz, '--sin-servicios'], {
        encoding: 'utf8',
        timeout: 180_000,
      });
    const r1 = correr();
    expect(r1.status, r1.stderr + r1.stdout).toBe(0);
    for (const d of ['archivos', 'respaldos']) {
      const dir = path.join(raiz, 'srv/campusia', d);
      expect(fs.statSync(dir).isDirectory(), d).toBe(true);
      expect(fs.statSync(dir).mode & 0o777, d).toBe(0o700);
    }
    fs.mkdirSync(path.join(raiz, 'srv/campusia/archivos/redes'), { recursive: true });
    fs.writeFileSync(path.join(raiz, 'srv/campusia/archivos/redes/marca'), 'no se borra');
    const r2 = correr();
    expect(r2.status, r2.stderr + r2.stdout).toBe(0);
    expect(fs.readFileSync(path.join(raiz, 'srv/campusia/archivos/redes/marca'), 'utf8')).toBe('no se borra');
    fs.rmSync(raiz, { recursive: true, force: true });
  });
});
