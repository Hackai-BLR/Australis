import fs from 'node:fs';
import net from 'node:net';
import { test, expect } from '@playwright/test';
import { Cliente } from '../../comun/http.ts';
import { levantarNucleo, type Nucleo, type OpcionesNucleo } from '../../comun/nucleo.ts';
import { obtenerCodigo, verificar } from '../../comun/sesion.ts';
import { nuevaSemilla } from '../../fase-2/lib/identidad.ts';
import { ALUMNA_REDES, ALUMNO_REDES, OWNER, REDES, SEMILLA } from '../fixtures.ts';
import { archivosEnDisco, entregar, raizArchivos, sesion, subirOk } from '../lib/datos.ts';

test.describe.configure({ timeout: 120_000 });

async function conNucleo(op: OpcionesNucleo, f: (n: Nucleo) => Promise<void>) {
  const n = await levantarNucleo({ semilla: SEMILLA, owner: OWNER, ...op });
  try {
    await f(n);
  } finally {
    await n.cerrar();
  }
}

function directivas(csp: string): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const parte of csp.split(';')) {
    const [nombre, ...valores] = parte.trim().split(/\s+/);
    if (nombre) m.set(nombre.toLowerCase(), valores);
  }
  return m;
}

test('las páginas de la plataforma llevan encabezados de seguridad', async () => {
  await conNucleo({}, async (n) => {
    const c = new Cliente(n);
    for (const [ruta, sub] of [
      ['/', undefined],
      ['/owner', undefined],
      ['/administracion', undefined],
      ['/', REDES],
    ] as const) {
      const r = await c.get(ruta, { sub });
      expect(r.status, ruta).toBe(200);
      expect(String(r.encabezados['content-type'])).toContain('text/html');
      const csp = directivas(String(r.encabezados['content-security-policy'] ?? ''));
      expect(csp.get('frame-ancestors'), ruta).toEqual(["'none'"]);
      expect(csp.get('object-src'), ruta).toEqual(["'none'"]);
      expect(csp.has('default-src'), ruta).toBe(true);
      expect(csp.has('base-uri'), ruta).toBe(true);
      const scripts = (csp.get('script-src') ?? csp.get('default-src') ?? []).join(' ');
      expect(scripts, ruta).not.toContain("'unsafe-inline'");
      expect(scripts, ruta).not.toContain("'unsafe-eval'");
      expect(scripts, ruta).not.toMatch(/(^|\s)\*(\s|$)/);
      expect(String(r.encabezados['x-frame-options']), ruta).toBe('DENY');
      expect(String(r.encabezados['x-content-type-options']), ruta).toBe('nosniff');
      expect(String(r.encabezados['referrer-policy']), ruta).toBe('same-origin');
      expect(String(r.encabezados['permissions-policy'] ?? ''), ruta).toContain('camera=()');
      expect(r.encabezados['access-control-allow-origin']).toBeUndefined();
    }
    const api = await c.get('/api/config');
    expect(String(api.encabezados['x-content-type-options'])).toBe('nosniff');
    expect(String(api.encabezados['cache-control'])).toBe('no-store');
  });
});

test('en producción se exige HTTPS con HSTS', async () => {
  await conNucleo({ semilla: null, produccion: true }, async (n) => {
    const c = new Cliente(n);
    for (const ruta of ['/', '/api/config', '/salud']) {
      const r = await c.get(ruta);
      expect(String(r.encabezados['strict-transport-security'] ?? ''), ruta).toMatch(/max-age=(\d+)/);
      const edad = Number(/max-age=(\d+)/.exec(String(r.encabezados['strict-transport-security']))![1]);
      expect(edad).toBeGreaterThanOrEqual(31536000);
    }
  });
});

test('los cuerpos JSON grandes se rechazan con 413', async () => {
  await conNucleo({}, async (n) => {
    const c = new Cliente(n);
    const grande = { email: 'x@austral.edu.ar', relleno: 'a'.repeat(1024 * 1024) };
    const r = await c.post('/api/login/codigo', grande);
    expect([413, 0]).toContain(r.status);
    const alumno = await sesion(n, ALUMNO_REDES);
    const e = await entregar(alumno, REDES, { actividad: 'tp1', texto: 'b'.repeat(1024 * 1024) });
    expect([413, 0]).toContain(e.status);
    const largo = await entregar(alumno, REDES, { actividad: 'tp1', texto: 'c'.repeat(20_001) });
    expect(largo.status).toBe(400);
    const justo = await entregar(alumno, REDES, { actividad: 'tp1', texto: 'd'.repeat(20_000) });
    expect(justo.status).toBe(201);
  });
});

test('una conexión que no termina de mandar los encabezados se corta', async () => {
  await conNucleo({ entorno: { TIEMPO_ESPERA_ENCABEZADOS_SEG: '2' } }, async (n) => {
    const inicio = Date.now();
    const cerrada = await new Promise<number>((resolve) => {
      const s = net.connect({ host: '127.0.0.1', port: n.puerto }, () => {
        s.write(`GET /salud HTTP/1.1\r\nHost: ${n.host()}\r\nX-Lento: `);
      });
      const t = setTimeout(() => {
        s.destroy();
        resolve(-1);
      }, 15_000);
      s.on('data', () => {});
      s.on('error', () => {});
      s.on('close', () => {
        clearTimeout(t);
        resolve(Date.now() - inicio);
      });
    });
    expect(cerrada).toBeGreaterThan(0);
    expect(cerrada).toBeLessThan(10_000);
    const r = await new Cliente(n).get('/salud');
    expect(r.status).toBe(200);
  });
});

function cuerpoLento(n: Nucleo, c: Cliente, ruta: string, largo: number): Promise<{ ms: number; enviados: number; respuesta: string }> {
  const host = n.host();
  const cookies = [...c.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  const cabecera =
    `POST ${ruta} HTTP/1.1\r\nHost: ${host}\r\nCF-Connecting-IP: ${c.ip}\r\nCookie: ${cookies}\r\n` +
    `Origin: ${n.esquema()}://${host}\r\nX-Campusia: 1\r\nContent-Type: application/octet-stream\r\nContent-Length: ${largo}\r\n\r\n`;
  const inicio = Date.now();
  return new Promise((resolve) => {
    let enviados = 0;
    let respuesta = '';
    let goteo: NodeJS.Timeout | undefined;
    const s = net.connect({ host: '127.0.0.1', port: n.puerto }, () => {
      s.write(cabecera);
      goteo = setInterval(() => {
        if (enviados < largo - 1 && !s.destroyed) {
          s.write('x');
          enviados++;
        }
      }, 300);
    });
    const t = setTimeout(() => s.destroy(), 30_000);
    s.on('data', (d) => {
      respuesta += d.toString('latin1');
    });
    s.on('error', () => {});
    s.on('close', () => {
      clearTimeout(t);
      if (goteo) clearInterval(goteo);
      resolve({ ms: Date.now() - inicio, enviados, respuesta });
    });
  });
}

test('un cuerpo que llega gota a gota se corta al vencer el tiempo y no deja nada', async () => {
  await conNucleo({ entorno: { TIEMPO_ESPERA_CUERPO_SEG: '3' } }, async (n) => {
    const alumno = await sesion(n, ALUMNO_REDES);
    const antes = n.consultar('SELECT COUNT(*) AS c FROM archivos')[0].c;
    const [subida, json] = await Promise.all([
      cuerpoLento(n, alumno, `/api/cursos/${REDES}/archivos?nombre=lento.txt`, 30_000),
      cuerpoLento(n, alumno, `/api/cursos/${REDES}/entregas`, 5_000),
    ]);
    for (const r of [subida, json]) {
      expect(r.ms, r.respuesta.slice(0, 80)).toBeLessThan(15_000);
      expect(r.ms).toBeGreaterThanOrEqual(2_500);
      expect(r.enviados).toBeLessThan(100);
      expect(r.respuesta).not.toMatch(/^HTTP\/1\.1 2\d\d/);
    }
    await new Promise((r) => setTimeout(r, 300));
    expect(n.consultar('SELECT COUNT(*) AS c FROM archivos')[0].c).toBe(antes);
    expect(archivosEnDisco(`${raizArchivos(n)}/.subiendo`)).toEqual([]);
    expect(n.consultar('SELECT COUNT(*) AS c FROM entregas')[0].c).toBe(0);
    const r = await new Cliente(n).get('/salud');
    expect(r.status).toBe(200);
    const despues = await subirOk(alumno, REDES, 'rapido.txt', 'contenido');
    expect(despues.nombre).toBe('rapido.txt');
  });
});

test('la API limita la frecuencia de pedidos por sesión y por token, sin afectar a los demás', async () => {
  await conNucleo({ entorno: { LIMITE_API_MINUTO: '40' } }, async (n) => {
    const alumno = await sesion(n, ALUMNO_REDES);
    const estados: number[] = [];
    for (let i = 0; i < 50; i++) estados.push((await alumno.get('/api/yo')).status);
    expect(estados.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(estados).toContain(429);
    const r = await alumno.get('/api/mis-cursos');
    expect(r.status).toBe(429);
    expect(r.json.error).toBe('demasiados_intentos');
    expect(Number(r.encabezados['retry-after'])).toBeGreaterThan(0);
    const otra = await sesion(n, ALUMNA_REDES);
    expect((await otra.get('/api/yo')).status).toBe(200);
  });
});

test('el registro del núcleo no guarda secretos, códigos, sesiones ni tokens', async () => {
  const clave = nuevaSemilla();
  await conNucleo({ entorno: { RUST_LOG: 'debug', IDENTIDAD_CLAVE_PRIVADA: clave.semilla } }, async (n) => {
    const c = new Cliente(n);
    const codigo = await obtenerCodigo(c, ALUMNO_REDES);
    const malo = codigo === '000000' ? '111111' : '000000';
    await verificar(c, ALUMNO_REDES, malo);
    const ok = await verificar(c, ALUMNO_REDES, codigo);
    expect(ok.status).toBe(200);
    c.email = ALUMNO_REDES;
    const sesionValor = c.sesion!;
    const token = `cia_${Buffer.from(`${Date.now()}-${Math.random()}`).toString('base64url').padEnd(43, 'Q').slice(0, 43)}`;
    const t = new Cliente(n);
    t.bearer = token;
    await t.get('/api/yo');
    await t.get('/api/yo', { bearer: `${token}x` });
    const contenido = `contenido-${clave.semilla.slice(0, 12)}`;
    await subirOk(c, REDES, 'registro.txt', contenido);
    await c.post('/api/logout');
    await new Promise((r) => setTimeout(r, 500));
    const registro = fs.readFileSync(n.archivoRegistro, 'utf8');
    expect(registro.length).toBeGreaterThan(0);
    expect(registro).not.toContain(sesionValor);
    expect(registro).not.toContain(token);
    expect(registro).not.toContain(token.slice(4, 24));
    expect(registro).not.toContain(n.entorno.SESSION_SECRET);
    expect(registro).not.toContain(clave.semilla);
    expect(registro).not.toMatch(new RegExp(`(?<![0-9.:])${codigo}(?![0-9])`));
    expect(registro).not.toContain(contenido);
  });
});
