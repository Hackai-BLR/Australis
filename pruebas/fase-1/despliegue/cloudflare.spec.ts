import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { RAIZ_REPO } from '../../comun/entorno.ts';
import { puertoLibre } from '../../comun/servicios-falsos.ts';

const CADDYFILE = path.join(RAIZ_REPO, 'despliegue', 'Caddyfile');
const EJEMPLO_ENV = path.join(RAIZ_REPO, 'despliegue', 'campusia.env.ejemplo');
const RANGOS_CLOUDFLARE = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18',
  '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22', '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32',
  '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
];

function recorrer(nodo: any, f: (n: any) => void) {
  if (Array.isArray(nodo)) nodo.forEach((x) => recorrer(x, f));
  else if (nodo && typeof nodo === 'object') {
    f(nodo);
    Object.values(nodo).forEach((x) => recorrer(x, f));
  }
}

test.describe('Caddy solo atiende a Cloudflare', () => {
  test('confía solo en los rangos de Cloudflare, corta lo demás y reescribe CF-Connecting-IP', () => {
    test.setTimeout(240_000);
    const r = spawnSync(
      'docker',
      ['run', '--rm', '-v', `${CADDYFILE}:/etc/caddy/Caddyfile:ro`, 'caddy:2.8.4', 'caddy', 'adapt', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'],
      { encoding: 'utf8', timeout: 180_000 },
    );
    expect(r.status, r.stderr).toBe(0);
    const cfg = JSON.parse(r.stdout);
    const servidor = Object.values(cfg.apps.http.servers)[0] as any;
    expect(servidor.trusted_proxies?.source).toBe('static');
    expect([...servidor.trusted_proxies.ranges].sort()).toEqual([...RANGOS_CLOUDFLARE].sort());
    expect(servidor.client_ip_headers).toEqual(['CF-Connecting-IP']);
    expect(servidor.trusted_proxies_strict).toBeTruthy();

    let corte = false;
    let proxy: any = null;
    recorrer(servidor.routes, (n) => {
      const negados = n.match?.flatMap((m: any) => m.not ?? []) ?? [];
      const rangos = negados.flatMap((m: any) => m.remote_ip?.ranges ?? []);
      if (rangos.length) {
        expect([...rangos].sort()).toEqual([...RANGOS_CLOUDFLARE].sort());
        recorrer(n.handle, (h) => {
          if (h.handler === 'static_response' && h.abort === true) corte = true;
        });
      }
      if (n.handler === 'reverse_proxy') proxy = n;
    });
    expect(corte).toBe(true);
    expect(proxy).toBeTruthy();
    const set = Object.fromEntries(Object.entries(proxy.headers?.request?.set ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    expect(set['cf-connecting-ip']).toEqual(['{http.vars.client_ip}']);
  });

  test('una conexión directa al origen, sin pasar por Cloudflare, se corta sin llegar al núcleo', async () => {
    test.setTimeout(240_000);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campusia-caddy-'));
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
      '-subj', '/CN=campusia.tech', '-addext', 'subjectAltName=DNS:campusia.tech,DNS:*.campusia.tech',
      '-keyout', path.join(dir, 'origen.key'), '-out', path.join(dir, 'origen.pem'),
    ], { stdio: 'ignore' });
    fs.chmodSync(path.join(dir, 'origen.key'), 0o644);
    const puerto = await puertoLibre();
    const nombre = `campusia-caddy-${puerto}`;
    const inicio = spawnSync('docker', [
      'run', '-d', '--rm', '--name', nombre, '-p', `127.0.0.1:${puerto}:443`,
      '-v', `${CADDYFILE}:/etc/caddy/Caddyfile:ro`, '-v', `${dir}:/etc/caddy/certs:ro`, 'caddy:2.8.4',
    ], { encoding: 'utf8', timeout: 180_000 });
    expect(inicio.status, inicio.stderr).toBe(0);
    try {
      const pedir = () =>
        new Promise<{ status?: number; error?: string }>((resolve) => {
          const req = https.request(
            {
              host: '127.0.0.1', port: puerto, path: '/api/config', method: 'GET', servername: 'campusia.tech',
              rejectUnauthorized: false, timeout: 5000,
              headers: { host: 'campusia.tech', 'cf-connecting-ip': '203.0.113.77' },
            },
            (res) => {
              res.resume();
              resolve({ status: res.statusCode });
            },
          );
          req.on('error', (e: any) => resolve({ error: e.code ?? e.message }));
          req.on('timeout', () => req.destroy(new Error('tiempo')));
          req.end();
        });
      const limite = Date.now() + 30_000;
      while (Date.now() < limite) {
        const log = spawnSync('docker', ['logs', nombre], { encoding: 'utf8' });
        if (/serving initial configuration/.test(log.stdout + log.stderr)) break;
        await new Promise((x) => setTimeout(x, 300));
      }
      await new Promise((x) => setTimeout(x, 500));
      const r = await pedir();
      expect(r.status, 'Caddy no tiene que responder a quien no es Cloudflare, ni siquiera con 502').toBeUndefined();
      expect(r.error).toBeTruthy();
    } finally {
      spawnSync('docker', ['rm', '-f', nombre], { encoding: 'utf8' });
    }
  });

  test('el ejemplo de entorno limita en quién confía el núcleo para leer la IP', () => {
    const texto = fs.readFileSync(EJEMPLO_ENV, 'utf8');
    expect(texto).toMatch(/^PROXIES_CONFIABLES=127\.0\.0\.1,::1$/m);
  });
});
