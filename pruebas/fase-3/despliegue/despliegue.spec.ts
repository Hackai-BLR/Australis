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
const CONSTRUIR = path.join(DESPLIEGUE, 'construir-espacio.sh');
const ESPACIO = path.join(DESPLIEGUE, 'espacio-trabajo');
const CONTAINERFILE = path.join(ESPACIO, 'Containerfile');
const PLANTILLA = path.join(RAIZ_REPO, 'plantilla-curso');

function variables(texto: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const linea of texto.split('\n')) {
    const l = linea.trim();
    if (!l || l.startsWith('#')) continue;
    const i = l.indexOf('=');
    if (i === -1) continue;
    m.set(l.slice(0, i).trim(), l.slice(i + 1).trim());
  }
  return m;
}

function archivosVersionados(): string[] {
  const r = spawnSync('git', ['-C', RAIZ_REPO, 'ls-files', '-co', '--exclude-standard'], { encoding: 'utf8' });
  return r.stdout.split('\n').filter(Boolean);
}

const PATRON_SECRETO = /sk-ant-(oat|api)\d\d-(?!PRUEBA|ATACANTE|FALSO|EJEMPLO)[A-Za-z0-9_-]{60,}/;

test.describe('despliegue de la fase 3', () => {
  test('la imagen del espacio fija la versión de Claude Code y no trae credenciales', () => {
    expect(fs.existsSync(CONTAINERFILE), CONTAINERFILE).toBe(true);
    const texto = fs.readFileSync(CONTAINERFILE, 'utf8');
    expect(texto).toMatch(/@anthropic-ai\/claude-code@\d+\.\d+\.\d+(\s|$|\\)/m);
    expect(texto).not.toMatch(/claude-code@(latest|next|\^|~)/);
    expect(texto).not.toMatch(/(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN)\s*=/);
    expect(texto).not.toMatch(PATRON_SECRETO);
    expect(texto).toMatch(/^\s*USER\s+(?!root\b|0\b)\S+/m);
    expect(texto).toContain('/etc/claude-code/managed-settings.json');
    for (const v of ['DISABLE_TELEMETRY', 'DISABLE_ERROR_REPORTING', 'DISABLE_AUTOUPDATER', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC']) {
      expect(texto, v).toContain(v);
    }
    expect(texto).toMatch(/pnpm@12\.18\.0/);
    const archivos = fs.readdirSync(ESPACIO, { recursive: true }).map(String);
    for (const comando of ['campusia-espacio', 'campusia-agente']) {
      expect(archivos.some((f) => path.basename(f).replace(/\.(sh|mjs|js)$/, '') === comando), comando).toBe(true);
    }
    const ajustes = archivos.find((f) => f.endsWith('managed-settings.json'));
    expect(ajustes, 'despliegue/espacio-trabajo tiene que traer managed-settings.json').toBeTruthy();
    const json = JSON.parse(fs.readFileSync(path.join(ESPACIO, ajustes!), 'utf8'));
    expect(json.hooks?.PreToolUse?.length).toBeGreaterThan(0);
  });

  test('construir-espacio.sh no usa sudo y acepta etiqueta y CLI', () => {
    expect(fs.existsSync(CONSTRUIR), CONSTRUIR).toBe(true);
    const texto = fs.readFileSync(CONSTRUIR, 'utf8');
    expect(texto).not.toMatch(/\bsudo\b/);
    expect(texto).toContain('--etiqueta');
    expect(texto).toContain('--cli');
    expect(texto).toContain('campusia-espacio:1');
    const sintaxis = spawnSync('bash', ['-n', CONSTRUIR], { encoding: 'utf8' });
    expect(sintaxis.status, sintaxis.stderr).toBe(0);
  });

  test('la plantilla tiene el script dev', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(PLANTILLA, 'package.json'), 'utf8'));
    expect(pkg.scripts?.dev).toBeTruthy();
    expect(pkg.scripts?.test).toBeTruthy();
    expect(pkg.scripts?.build).toBeTruthy();
  });

  test('la unidad y el ejemplo de entorno tienen las variables nuevas sin secretos', () => {
    const unidad = fs.readFileSync(UNIDAD, 'utf8');
    expect(unidad).toMatch(/^Environment=RAIZ_ESPACIOS=\/srv\/campusia\/espacios\s*$/m);
    const env = variables(fs.readFileSync(EJEMPLO_ENV, 'utf8'));
    expect(env.get('PROVEEDOR_MODELO')).toBe('api');
    expect(['', 'completar']).toContain(env.get('ANTHROPIC_API_KEY'));
    expect(['', 'completar']).toContain(env.get('CLAUDE_CODE_OAUTH_TOKEN'));
    expect(env.get('ESPACIO_IMAGEN')).toBe('campusia-espacio:1');
    expect(env.get('RAIZ_ESPACIOS')).toBe('/srv/campusia/espacios');
    expect(env.get('PUERTO_ESPACIOS')).toBe('8082');
    expect(env.get('PUERTO_PROXY_SALIDA')).toBe('8083');
    expect(env.get('SALIDA_PERMITIDA')).toBe('registry.npmjs.org');
    for (const k of ['MODELO_AGENTE', 'INACTIVIDAD_ESPACIO_SEG', 'ESPACIO_MEMORIA', 'ESPACIO_CPUS', 'AGENTE_MAX_SEG', 'PRECIOS_MODELO_ARCHIVO']) {
      expect(env.has(k), k).toBe(true);
    }
    expect(fs.readFileSync(EJEMPLO_ENV, 'utf8')).not.toMatch(PATRON_SECRETO);
  });

  test('instalar.sh copia el espacio de trabajo y crea la carpeta de espacios', () => {
    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'campusia-instalar-'));
    try {
      const r = spawnSync('bash', [INSTALAR, '--binario', BINARIO, '--interfaz', INTERFAZ_DIST, '--espacio', ESPACIO, '--raiz', raiz, '--sin-servicios'], {
        encoding: 'utf8',
        timeout: 180_000,
      });
      expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
      const espacios = path.join(raiz, 'srv/campusia/espacios');
      expect(fs.statSync(espacios).isDirectory()).toBe(true);
      expect(fs.statSync(espacios).mode & 0o777).toBe(0o700);
      expect(fs.existsSync(path.join(raiz, 'srv/campusia/plataforma/espacio-trabajo/Containerfile'))).toBe(true);
      const sin = fs.mkdtempSync(path.join(os.tmpdir(), 'campusia-instalar-'));
      try {
        const r2 = spawnSync('bash', [INSTALAR, '--binario', BINARIO, '--interfaz', INTERFAZ_DIST, '--raiz', sin, '--sin-servicios'], { encoding: 'utf8', timeout: 180_000 });
        expect(r2.status, `${r2.stdout}${r2.stderr}`).toBe(0);
        expect(fs.statSync(path.join(sin, 'srv/campusia/espacios')).isDirectory()).toBe(true);
      } finally {
        fs.rmSync(sin, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(raiz, { recursive: true, force: true });
    }
  });

  test('el repo no tiene tokens ni claves reales', () => {
    for (const f of archivosVersionados()) {
      const ruta = path.join(RAIZ_REPO, f);
      let st: fs.Stats;
      try {
        st = fs.statSync(ruta);
      } catch {
        continue;
      }
      if (!st.isFile() || st.size > 2 * 1024 * 1024) continue;
      const texto = fs.readFileSync(ruta, 'latin1');
      expect(PATRON_SECRETO.test(texto), f).toBe(false);
    }
  });

  test('el handoff de la fase 3 registra una corrida con éxito de la prueba con el modelo real', () => {
    const dir = path.join(RAIZ_REPO, 'handoffs');
    const archivos = fs.readdirSync(dir).filter((f) => /^\d{6}_\d{4}_fase-3[\w-]*\.md$/.test(f));
    expect(archivos.length, 'falta el handoff de la fase 3 en handoffs/').toBeGreaterThan(0);
    const corridas = archivos
      .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
      .flatMap((t) => t.split(/^## /m).filter((seccion) => /^Prueba con el modelo real/i.test(seccion)));
    expect(corridas.length, 'el handoff no tiene la sección "Prueba con el modelo real"').toBeGreaterThan(0);
    const valida = corridas.find(
      (c) =>
        /^- Fecha: \d{4}-\d{2}-\d{2}/m.test(c) &&
        /^- Duración: \d+(?:[.,]\d+)? (?:s|min)/m.test(c) &&
        /^- Consumo: .*\d+ consultas?.*USD \d+(?:[.,]\d+)?/m.test(c) &&
        /^- Resultado: ok\b/m.test(c),
    );
    expect(valida, 'la sección tiene que anotar Fecha, Duración, Consumo y Resultado: ok').toBeTruthy();
    expect(valida).not.toMatch(PATRON_SECRETO);
    expect(valida).not.toMatch(/sk-ant-/);
  });
});

