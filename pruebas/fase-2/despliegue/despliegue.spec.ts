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
const PLANTILLA = path.join(RAIZ_REPO, 'plantilla-curso');
const SDK = path.join(RAIZ_REPO, 'sdk');

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

function seccion(texto: string, nombre: string): string {
  const partes = texto.split(/^\[/m);
  const s = partes.find((p) => p.startsWith(`${nombre}]`));
  return s ?? '';
}

function plantillaFalsa(conVendor: boolean): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plantilla-falsa-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"curso"}');
  fs.writeFileSync(path.join(dir, 'Containerfile'), 'FROM node:22-alpine\n');
  fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'x', 'index.js'), '');
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'dist', 'a.js'), '');
  fs.mkdirSync(path.join(dir, 'servidor'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'servidor', 'app.ts'), 'export {};\n');
  if (conVendor) {
    fs.mkdirSync(path.join(dir, 'vendor'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'vendor', 'campusia-sdk-0.1.0.tgz'), 'tgz');
  }
  return dir;
}

test.describe('despliegue de la fase 2', () => {
  test('la unidad del núcleo tiene las variables de los cursos, el alias y es compatible con Docker sin root', () => {
    const texto = fs.readFileSync(UNIDAD, 'utf8');
    const d = directivas(texto);
    const env = (d.get('Environment') ?? []).join(' ');
    expect(env).toContain('RAIZ_CURSOS=/srv/campusia/cursos');
    expect(env).toContain('PLANTILLA_CURSO_DIR=/srv/campusia/plataforma/plantilla-curso');
    expect(env).toContain('SDK_DIR=/srv/campusia/plataforma/sdk');
    expect(env).toContain('PROVEEDOR_CONTENEDORES=docker');
    expect(directivas(seccion(texto, 'Install')).get('Alias')?.join(' ') ?? '').toContain('campusia.service');
    expect(d.get('User')).toEqual(['campusia']);
    expect(d.get('NoNewPrivileges')?.[0] ?? 'false').not.toMatch(/^(true|yes|1)$/);
    expect(d.get('PrivateUsers')?.[0] ?? 'false').not.toMatch(/^(true|yes|1)$/);
    expect(d.get('RestrictNamespaces')?.[0] ?? 'false').not.toMatch(/^(true|yes|1)$/);
    expect(d.get('ProtectHome')?.[0] ?? 'false').not.toMatch(/^(true|yes|1|read-only|tmpfs)$/);
    const familias = d.get('RestrictAddressFamilies');
    if (familias) expect(familias.join(' ')).toContain('AF_UNIX');
    expect((d.get('ReadWritePaths') ?? []).join(' ')).toContain('/srv/campusia');
    expect((d.get('ReadWritePaths') ?? []).join(' ')).toContain('/run/user');
    for (const k of ['InaccessiblePaths', 'TemporaryFileSystem']) {
      expect((d.get(k) ?? []).join(' '), k).not.toContain('/run/user');
    }
  });

  test('el ejemplo de entorno trae las variables nuevas sin secretos', () => {
    const texto = fs.readFileSync(EJEMPLO_ENV, 'utf8');
    for (const v of [
      'PROVEEDOR_CONTENEDORES', 'CONTENEDORES_CLI', 'PREFIJO_CONTENEDORES', 'RAIZ_CURSOS', 'PLANTILLA_CURSO_DIR', 'SDK_DIR',
      'PUERTO_API_CURSOS', 'CURSO_MEMORIA', 'CURSO_CPUS', 'MINUTOS_INACTIVIDAD', 'ARRANQUE_CURSO_SEG', 'LIMITE_UNIRSE_USUARIO', 'LIMITE_UNIRSE_IP',
    ]) {
      expect(texto, v).toMatch(new RegExp(`^${v}=`, 'm'));
    }
    expect(texto).toMatch(/^PROVEEDOR_CONTENEDORES=docker$/m);
    expect(texto).toMatch(/^RAIZ_CURSOS=\/srv\/campusia\/cursos$/m);
    expect(texto).toMatch(/^MINUTOS_INACTIVIDAD=15$/m);
    const clave = /^IDENTIDAD_CLAVE_PRIVADA=(.*)$/m.exec(texto)?.[1];
    if (clave !== undefined) expect(clave.trim()).toMatch(/^(|completar)$/);
    expect(texto).not.toMatch(/[A-Za-z0-9_-]{43}/);
  });

  test('instalar.sh copia la plantilla y el SDK sin dependencias y crea la carpeta de cursos', () => {
    expect(fs.existsSync(BINARIO)).toBe(true);
    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'campusia-instalar-'));
    const plantilla = plantillaFalsa(true);
    const correr = () =>
      spawnSync('bash', [INSTALAR, '--binario', BINARIO, '--interfaz', INTERFAZ_DIST, '--plantilla', plantilla, '--sdk', SDK, '--raiz', raiz, '--sin-servicios'], {
        encoding: 'utf8',
        timeout: 180_000,
      });
    const r1 = correr();
    expect(r1.status, r1.stderr + r1.stdout).toBe(0);
    const cursos = path.join(raiz, 'srv/campusia/cursos');
    expect(fs.statSync(cursos).isDirectory()).toBe(true);
    expect(fs.statSync(cursos).mode & 0o777).toBe(0o700);
    const dest = path.join(raiz, 'srv/campusia/plataforma/plantilla-curso');
    expect(fs.existsSync(path.join(dest, 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(dest, 'servidor/app.ts'))).toBe(true);
    expect(fs.existsSync(path.join(dest, 'vendor/campusia-sdk-0.1.0.tgz'))).toBe(true);
    expect(fs.existsSync(path.join(dest, 'node_modules'))).toBe(false);
    expect(fs.existsSync(path.join(dest, 'dist'))).toBe(false);
    const sdk = path.join(raiz, 'srv/campusia/plataforma/sdk');
    expect(fs.existsSync(path.join(sdk, 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(sdk, 'node_modules'))).toBe(false);
    fs.writeFileSync(path.join(cursos, 'marca'), 'no se borra');
    fs.rmSync(path.join(plantilla, 'servidor'), { recursive: true });
    const r2 = correr();
    expect(r2.status, r2.stderr + r2.stdout).toBe(0);
    expect(fs.readFileSync(path.join(cursos, 'marca'), 'utf8')).toBe('no se borra');
    expect(fs.existsSync(path.join(dest, 'servidor/app.ts'))).toBe(false);
  });

  test('instalar.sh falla con una plantilla sin el SDK empaquetado', () => {
    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'campusia-instalar-'));
    const r = spawnSync('bash', [INSTALAR, '--binario', BINARIO, '--interfaz', INTERFAZ_DIST, '--plantilla', plantillaFalsa(false), '--raiz', raiz, '--sin-servicios'], {
      encoding: 'utf8',
      timeout: 180_000,
    });
    expect(r.status).not.toBe(0);
  });

  test('instalar.sh sin los argumentos nuevos sigue funcionando y crea la carpeta de cursos', () => {
    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'campusia-instalar-'));
    const r = spawnSync('bash', [INSTALAR, '--binario', BINARIO, '--interfaz', INTERFAZ_DIST, '--raiz', raiz, '--sin-servicios'], { encoding: 'utf8', timeout: 180_000 });
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(fs.statSync(path.join(raiz, 'srv/campusia/cursos')).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(PLANTILLA, 'Containerfile'))).toBe(true);
  });
});
