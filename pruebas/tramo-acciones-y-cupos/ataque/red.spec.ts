import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { crearTestAcciones, expect, TIEMPO_FASE3, PROFE_AUSTRAL, ALUMNO_AUSTRAL } from '../fixtures.ts';
import { RAIZ_REPO } from '../../comun/entorno.ts';
import { Cliente } from '../../comun/http.ts';
import { apiDeCurso, inscribirOk, tokenDeCurso } from '../../fase-2/lib/cursos.ts';
import { cursoConEspacio, entornoEspacio } from '../../fase-3/lib/agente.ts';
import { inscriptosEnBase, pedirInterna, sesionDe } from '../lib.ts';

const test = crearTestAcciones();
test.describe.configure({ mode: 'serial', timeout: TIEMPO_FASE3 });

let id = '';
let duena: Cliente;

function direccionesExternas(): string[] {
  const salida: string[] = [];
  for (const [nombre, dirs] of Object.entries(os.networkInterfaces())) {
    if (/^(lo|docker|br-|veth|virbr|cni|flannel)/.test(nombre)) continue;
    for (const d of dirs ?? []) {
      if (d.family === 'IPv4' && !d.internal) salida.push(d.address);
    }
  }
  return salida;
}

function conectar(host: string, puerto: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port: puerto });
    const fin = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(3000, () => fin(false));
    s.once('connect', () => fin(true));
    s.once('error', () => fin(false));
  });
}

function puertoDe(url: string): number {
  return Number(new URL(url).port);
}

test.describe('las APIs internas no se alcanzan desde afuera', () => {
  test.beforeAll(async ({ nucleo }) => {
    test.setTimeout(TIEMPO_FASE3);
    duena = await sesionDe(nucleo, PROFE_AUSTRAL);
    id = await cursoConEspacio(duena, { nombre: 'Curso Interno' });
    await inscribirOk(duena, id, [ALUMNO_AUSTRAL]);
  });

  test('la API para cursos y la escucha de espacios no escuchan en las direcciones externas de la máquina', async ({ nucleo }) => {
    const publicada = apiDeCurso(nucleo, id);
    const espacios = String(entornoEspacio(nucleo, id).CAMPUSIA_API);
    const puertos = [puertoDe(publicada), puertoDe(espacios)];
    expect(await conectar(new URL(publicada).hostname, puertos[0]!)).toBe(true);
    for (const ip of direccionesExternas()) {
      for (const p of puertos) expect(await conectar(ip, p), `${ip}:${p} responde desde afuera`).toBe(false);
    }
    const ss = spawnSync('ss', ['-ltnH'], { encoding: 'utf8' });
    if (ss.status === 0) {
      for (const linea of ss.stdout.split('\n')) {
        const local = linea.trim().split(/\s+/)[3] ?? '';
        for (const p of puertos) {
          if (local.endsWith(`:${p}`)) expect(local, `escucha en ${local}`).not.toMatch(/^(0\.0\.0\.0|\*|\[::\]|::):/);
        }
      }
    }
    for (const base of [publicada, espacios]) {
      const host = new URL(base).hostname;
      expect(host).toMatch(/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/);
      expect(direccionesExternas()).not.toContain(host);
    }
  });

  test('la escucha principal no da acceso a las acciones aunque el token del curso sea válido', async ({ nucleo }) => {
    const tokens = [tokenDeCurso(nucleo, id), String(entornoEspacio(nucleo, id).CAMPUSIA_TOKEN_CURSO)];
    const antes = inscriptosEnBase(nucleo, id).length;
    const c = new Cliente(nucleo);
    for (const token of tokens) {
      for (const sub of [undefined, id]) {
        for (const ruta of ['/api/curso/acciones/inscriptos', '/api/curso/acciones/codigo', '/api/curso/acciones/confirmaciones', '/api/curso/inscriptos', '/api/curso/yo']) {
          const r = await c.get(ruta, { sub, bearer: token });
          expect([401, 404], `${sub ?? 'base'} ${ruta}`).toContain(r.status);
          expect(r.texto).not.toContain(ALUMNO_AUSTRAL);
        }
        const w = await c.post('/api/curso/acciones/inscriptos', { emails: ['intruso@mail.austral.edu.ar'], rol: 'alumno' }, { sub, bearer: token });
        expect([401, 403, 404]).toContain(w.status);
      }
      for (const sub of [`${id}-curso`, `${id}-prueba`]) {
        const r = await c.get('/api/curso/acciones/inscriptos', { sub, bearer: token, sinCookies: true });
        expect(r.status, sub).not.toBe(200);
        expect(r.texto).not.toContain(ALUMNO_AUSTRAL);
        const conSesion = await duena.get('/api/curso/acciones/inscriptos', { sub, bearer: token });
        expect(conSesion.texto, sub).not.toContain(ALUMNO_AUSTRAL);
      }
    }
    expect(inscriptosEnBase(nucleo, id).length).toBe(antes);
    expect(nucleo.consultar("SELECT COUNT(*) AS n FROM usuarios WHERE email = 'intruso@mail.austral.edu.ar'")[0].n).toBe(0);
  });

  test('Caddy solo reenvía a la escucha principal y la configuración no abre las escuchas internas', () => {
    const caddy = fs.readFileSync(path.join(RAIZ_REPO, 'despliegue', 'Caddyfile'), 'utf8');
    const destinos = [...caddy.matchAll(/reverse_proxy\s+(\S+)/g)].map((m) => m[1]);
    expect(destinos.length).toBeGreaterThan(0);
    for (const d of destinos) expect(d).toBe('127.0.0.1:8080');
    expect(caddy).not.toMatch(/:808[1-3]\b/);
    for (const archivo of ['campusia.env.ejemplo', 'campusia-nucleo.service']) {
      const texto = fs.readFileSync(path.join(RAIZ_REPO, 'despliegue', archivo), 'utf8');
      expect(texto, archivo).not.toMatch(/DIRECCION_(API_CURSOS|ESPACIOS)\s*=\s*(0\.0\.0\.0|::|\*)/);
      expect(texto, archivo).not.toMatch(/^\s*(Environment=)?DIRECCION\s*=\s*0\.0\.0\.0/m);
    }
  });
});
