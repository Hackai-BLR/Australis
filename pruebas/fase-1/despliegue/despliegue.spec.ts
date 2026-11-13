import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, expect } from '@playwright/test';
import { BINARIO, INTERFAZ_DIST, RAIZ_REPO } from '../../comun/entorno.ts';

const DESPLIEGUE = path.join(RAIZ_REPO, 'despliegue');
const UNIDAD = path.join(DESPLIEGUE, 'campusia-nucleo.service');
const CADDYFILE = path.join(DESPLIEGUE, 'Caddyfile');
const INSTALAR = path.join(DESPLIEGUE, 'instalar.sh');
const EJEMPLO_ENV = path.join(DESPLIEGUE, 'campusia.env.ejemplo');

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

test.describe('despliegue', () => {
  test('la unidad de systemd corre como campusia con el entorno y las rutas de producción', () => {
    const d = directivas(fs.readFileSync(UNIDAD, 'utf8'));
    expect(d.get('User')).toEqual(['campusia']);
    expect(d.get('EnvironmentFile')).toEqual(['/srv/campusia/config/campusia.env']);
    expect(d.get('ExecStart')?.[0]).toMatch(/^\/usr\/local\/bin\/campusia-nucleo\s*$/);
    const env = (d.get('Environment') ?? []).join(' ');
    expect(env).toContain('DATABASE_URL=sqlite:///srv/campusia/datos/campusia.db');
    expect(env).toContain('INTERFAZ_DIR=/srv/campusia/interfaz');
    expect(d.get('Restart')?.[0]).toMatch(/^(on-failure|always)$/);
    expect(d.get('WantedBy')).toEqual(['multi-user.target']);
    expect(d.get('ProtectSystem')?.[0]).toMatch(/^(full|strict|true)$/);
    expect(d.get('PrivateTmp')).toEqual(['true']);
    expect((d.get('ReadWritePaths') ?? []).join(' ')).toContain('/srv/campusia');
    expect(d.get('NoNewPrivileges')?.[0] ?? 'false').not.toBe('true');
    expect(d.get('PrivateUsers')?.[0] ?? 'false').not.toBe('true');
    expect(d.get('RestrictNamespaces')?.[0] ?? 'false').not.toBe('true');
    expect(d.get('ProtectHome')?.[0] ?? 'false').not.toBe('true');
  });

  test('el Caddyfile es válido y apunta al núcleo con el certificado de origen', () => {
    test.setTimeout(240_000);
    const r = spawnSync(
      'docker',
      ['run', '--rm', '-v', `${CADDYFILE}:/etc/caddy/Caddyfile:ro`, 'caddy:2.8.4', 'caddy', 'adapt', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'],
      { encoding: 'utf8', timeout: 180_000 },
    );
    expect(r.status, r.stderr).toBe(0);
    const json = r.stdout;
    const cfg = JSON.parse(json);
    expect(json).toContain('"campusia.tech"');
    expect(json).toContain('"*.campusia.tech"');
    expect(json).toContain('127.0.0.1:8080');
    expect(json).toContain('/etc/caddy/certs/origen.pem');
    expect(json).toContain('/etc/caddy/certs/origen.key');
    const servidores = Object.values(cfg.apps.http.servers) as any[];
    expect(servidores.some((s) => s.automatic_https?.disable_certificates === true)).toBe(true);
  });

  test('el ejemplo de entorno lista todas las variables sin secretos reales', () => {
    const texto = fs.readFileSync(EJEMPLO_ENV, 'utf8');
    for (const v of [
      'PUERTO', 'DIRECCION', 'ENTORNO', 'DATABASE_URL', 'DOMINIO_BASE', 'PROVEEDOR_EMAIL', 'BREVO_API_KEY', 'EMAIL_FROM', 'EMAIL_FROM_NAME',
      'TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET', 'SESSION_SECRET', 'INTERFAZ_DIR', 'ENCABEZADO_IP_CLIENTE',
    ]) {
      expect(texto, v).toMatch(new RegExp(`^${v}=`, 'm'));
    }
    expect(texto).toMatch(/^ENTORNO=produccion$/m);
    expect(texto).toMatch(/^DOMINIO_BASE=campusia\.tech$/m);
    expect(texto).toMatch(/^ENCABEZADO_IP_CLIENTE=CF-Connecting-IP$/m);
    expect(texto).not.toMatch(/xkeysib-/);
    expect(texto).not.toMatch(/^SESSION_SECRET=[0-9a-f]{32,}$/m);
  });

  test('instalar.sh instala en una raíz alternativa, migra la base y es idempotente', () => {
    expect(fs.existsSync(BINARIO)).toBe(true);
    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'campusia-instalar-'));
    const correr = () =>
      spawnSync('bash', [INSTALAR, '--binario', BINARIO, '--interfaz', INTERFAZ_DIST, '--raiz', raiz, '--sin-servicios'], {
        encoding: 'utf8',
        timeout: 120_000,
      });
    const r1 = correr();
    expect(r1.status, r1.stderr + r1.stdout).toBe(0);
    const bin = path.join(raiz, 'usr/local/bin/campusia-nucleo');
    expect(fs.existsSync(bin)).toBe(true);
    expect(fs.statSync(bin).mode & 0o111).not.toBe(0);
    expect(fs.existsSync(path.join(raiz, 'srv/campusia/interfaz/index.html'))).toBe(true);
    expect(fs.readFileSync(path.join(raiz, 'etc/systemd/system/campusia-nucleo.service'), 'utf8')).toBe(fs.readFileSync(UNIDAD, 'utf8'));
    expect(fs.readFileSync(path.join(raiz, 'etc/caddy/Caddyfile'), 'utf8')).toBe(fs.readFileSync(CADDYFILE, 'utf8'));
    const rutaDb = path.join(raiz, 'srv/campusia/datos/campusia.db');
    expect(fs.existsSync(rutaDb)).toBe(true);
    const owner = execFileSync(bin, ['crear-owner', 'equipo@campusia.prueba'], {
      env: { ...process.env, DATABASE_URL: `sqlite://${rutaDb}` },
      encoding: 'utf8',
    });
    expect(owner).toBeDefined();
    const r2 = correr();
    expect(r2.status, r2.stderr + r2.stdout).toBe(0);
    const db = new DatabaseSync(rutaDb);
    try {
      const tablas = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t: any) => t.name);
      for (const t of ['universidades', 'dominios', 'usuarios', 'sesiones', 'codigos_login', 'tokens_api', 'cursos', 'inscripciones', 'auditoria', 'configuracion']) {
        expect(tablas, t).toContain(t);
      }
      const n = db.prepare("SELECT COUNT(*) AS n FROM usuarios WHERE email = 'equipo@campusia.prueba' AND owner = 1").get() as any;
      expect(n.n).toBe(1);
    } finally {
      db.close();
    }
    expect(fs.existsSync(path.join(raiz, 'srv/campusia/config/campusia.env'))).toBe(false);
  });

  test('instalar.sh falla sin binario o sin interfaz', () => {
    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'campusia-instalar-'));
    const r = spawnSync('bash', [INSTALAR, '--interfaz', INTERFAZ_DIST, '--raiz', raiz, '--sin-servicios'], { encoding: 'utf8' });
    expect(r.status).not.toBe(0);
    const r2 = spawnSync('bash', [INSTALAR, '--binario', '/no/existe', '--interfaz', INTERFAZ_DIST, '--raiz', raiz, '--sin-servicios'], { encoding: 'utf8' });
    expect(r2.status).not.toBe(0);
  });
});
