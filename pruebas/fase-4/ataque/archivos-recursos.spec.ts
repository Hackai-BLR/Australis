import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import type { Cliente } from '../../comun/http.ts';
import { levantarNucleo, type Nucleo, type OpcionesNucleo } from '../../comun/nucleo.ts';
import { ALUMNA_REDES, ALUMNO_REDES, DUENO_REDES, MIEMBROS_REDES, OWNER, PROFE_REDES, SEMILLA } from '../fixtures.ts';
import { archivosEnDisco, bajar, cursoAislado, entregar, listarArchivos, raizArchivos, rutaArchivo, sesion, sha256, subir, subirOk } from '../lib/datos.ts';

test.describe.configure({ timeout: 180_000 });

const MiB = 1024 * 1024;

async function conNucleo(op: OpcionesNucleo, f: (n: Nucleo) => Promise<void>) {
  const n = await levantarNucleo({ semilla: SEMILLA, owner: OWNER, ...op });
  try {
    await f(n);
  } finally {
    await n.cerrar();
  }
}

function memoriaResidente(n: Nucleo): number {
  const pid = n.proceso?.pid;
  if (!pid) throw new Error('El núcleo no está corriendo');
  const estado = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
  const m = /VmRSS:\s+(\d+)\s+kB/.exec(estado);
  if (!m) throw new Error('No se pudo leer VmRSS');
  return Number(m[1]) * 1024;
}

function encabezadosDe(c: Cliente, modifica: boolean): Record<string, string> {
  const host = c.nucleo.host();
  const h: Record<string, string> = { host, 'cf-connecting-ip': c.ip };
  const cookies = [...c.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  if (cookies) h.cookie = cookies;
  if (modifica) {
    h.origin = `${c.nucleo.esquema()}://${host}`;
    h['x-campusia'] = '1';
  }
  return h;
}

function bytesSubiendo(n: Nucleo): number {
  const dir = path.join(raizArchivos(n), '.subiendo');
  return archivosEnDisco(dir).reduce((t, f) => {
    try {
      return t + fs.statSync(f).size;
    } catch {
      return t;
    }
  }, 0);
}

interface Crudo {
  socket: net.Socket;
  recibido: () => string;
  estado: () => number | null;
  cerrado: () => boolean;
  escribir: (b: Buffer | string) => Promise<boolean>;
}

function abrirCrudo(n: Nucleo, cabecera: string): Promise<Crudo> {
  return new Promise((resolve, reject) => {
    let datos = '';
    let fin = false;
    const s = net.connect({ host: '127.0.0.1', port: n.puerto }, () => {
      s.write(cabecera);
      resolve({
        socket: s,
        recibido: () => datos,
        estado: () => {
          const m = /^HTTP\/1\.1 (\d{3})/.exec(datos);
          return m ? Number(m[1]) : null;
        },
        cerrado: () => fin,
        escribir: (b) =>
          new Promise((ok) => {
            if (fin || s.destroyed) return ok(false);
            s.write(b, (e) => ok(!e));
          }),
      });
    });
    s.on('data', (d) => {
      datos += d.toString('latin1');
    });
    s.on('error', () => {});
    s.on('close', () => {
      fin = true;
    });
    s.once('error', (e) => reject(e));
  });
}

function cabeceraSubida(c: Cliente, curso: string, nombre: string, extra: Record<string, string>): string {
  const h = { ...encabezadosDe(c, true), 'content-type': 'application/octet-stream', ...extra };
  const lineas = Object.entries(h).map(([k, v]) => `${k}: ${v}`);
  return `POST /api/cursos/${curso}/archivos?nombre=${encodeURIComponent(nombre)} HTTP/1.1\r\n${lineas.join('\r\n')}\r\n\r\n`;
}

async function esperar(cond: () => boolean, ms: number) {
  const limite = Date.now() + ms;
  while (Date.now() < limite) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}

test('muchas descargas simultáneas de un archivo grande no cargan el archivo entero en memoria por pedido', async () => {
  await conNucleo({ entorno: { ARCHIVOS_MAX_BYTES: String(20 * MiB), ARCHIVOS_CUOTA_CURSO: String(400 * MiB) } }, async (n) => {
    const curso = cursoAislado(n, 'mem', MIEMBROS_REDES);
    const alumno = await sesion(n, ALUMNO_REDES);
    const contenido = crypto.randomBytes(20 * MiB);
    const a = await subirOk(alumno, curso, 'grande.zip', contenido);
    const antes = memoriaResidente(n);
    const pedidos: http.ClientRequest[] = [];
    let conRespuesta = 0;
    for (let i = 0; i < 40; i++) {
      const req = http.request({
        host: '127.0.0.1',
        port: n.puerto,
        path: `/api/cursos/${curso}/archivos/${a.id}`,
        method: 'GET',
        headers: encabezadosDe(alumno, false),
        agent: false,
      });
      req.on('response', (res) => {
        conRespuesta++;
        res.pause();
      });
      req.on('error', () => {});
      req.end();
      pedidos.push(req);
    }
    await esperar(() => conRespuesta >= 4, 60_000);
    let pico = memoriaResidente(n);
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 300));
      pico = Math.max(pico, memoriaResidente(n));
    }
    for (const p of pedidos) p.destroy();
    expect(conRespuesta).toBeGreaterThan(0);
    expect(pico - antes, `memoria del núcleo: antes ${antes}, durante ${pico}`).toBeLessThan(200 * MiB);
    expect(n.proceso?.exitCode).toBeNull();
    await new Promise((r) => setTimeout(r, 500));
    const r = await bajar(alumno, curso, a.id);
    expect(r.status).toBe(200);
    expect(r.cuerpo.length).toBe(contenido.length);
    expect(sha256(r.cuerpo)).toBe(sha256(contenido));
  });
});

test('una subida que no entra en la cuota se rechaza antes de leer el cuerpo y no deja temporales', async () => {
  const CUOTA = 1_000_000;
  await conNucleo({ entorno: { ARCHIVOS_CUOTA_CURSO: String(CUOTA), ARCHIVOS_MAX_BYTES: '600000' } }, async (n) => {
    const curso = cursoAislado(n, 'pre', MIEMBROS_REDES);
    const profe = await sesion(n, PROFE_REDES);
    const alumno = await sesion(n, ALUMNO_REDES);
    await subirOk(profe, curso, 'a.txt', Buffer.alloc(600_000, 1));
    await subirOk(profe, curso, 'b.txt', Buffer.alloc(300_000, 2));
    const abiertos: Crudo[] = [];
    for (let i = 0; i < 10; i++) {
      const c = await abrirCrudo(n, cabeceraSubida(alumno, curso, `lento-${i}.zip`, { 'content-length': '500000' }));
      await c.escribir(Buffer.alloc(50_000, 7));
      abiertos.push(c);
    }
    const respondidos = await esperar(() => abiertos.every((c) => c.estado() !== null), 5000);
    const ocupados = bytesSubiendo(n);
    for (const c of abiertos) c.socket.destroy();
    expect(respondidos, abiertos.map((c) => c.recibido().slice(0, 40)).join(' | ')).toBe(true);
    for (const c of abiertos) {
      expect(c.estado()).toBe(409);
      expect(c.recibido()).toContain('cuota_excedida');
    }
    expect(ocupados).toBe(0);
    const l = await listarArchivos(profe, curso);
    expect(l.json.usado).toBe(900_000);
  });
});

test('la cuota se reserva al empezar la subida: otra que no entra se rechaza mientras la primera sigue en curso', async () => {
  const CUOTA = 200_000;
  await conNucleo({ entorno: { ARCHIVOS_CUOTA_CURSO: String(CUOTA), ARCHIVOS_MAX_BYTES: '150000' } }, async (n) => {
    const curso = cursoAislado(n, 'res', MIEMBROS_REDES);
    const profe = await sesion(n, PROFE_REDES);
    const primera = await abrirCrudo(n, cabeceraSubida(profe, curso, 'primera.txt', { 'content-length': '120000' }));
    await primera.escribir(Buffer.alloc(60_000, 1));
    await new Promise((r) => setTimeout(r, 300));
    const segunda = await subir(profe, curso, 'segunda.txt', Buffer.alloc(100_000, 2));
    expect(segunda.status, segunda.texto).toBe(409);
    expect(segunda.json?.error).toBe('cuota_excedida');
    await primera.escribir(Buffer.alloc(60_000, 1));
    expect(await esperar(() => primera.estado() !== null, 10_000)).toBe(true);
    expect(primera.estado()).toBe(201);
    primera.socket.destroy();
    const tercera = await subir(profe, curso, 'tercera.txt', Buffer.alloc(80_000, 3));
    expect(tercera.status, tercera.texto).toBe(201);
    expect((await listarArchivos(profe, curso)).json.usado).toBe(200_000);
  });
});

test('una subida sin largo declarado se corta en cuanto supera la cuota', async () => {
  const CUOTA = 1_000_000;
  await conNucleo({ entorno: { ARCHIVOS_CUOTA_CURSO: String(CUOTA), ARCHIVOS_MAX_BYTES: '900000' } }, async (n) => {
    const curso = cursoAislado(n, 'chu', MIEMBROS_REDES);
    const profe = await sesion(n, PROFE_REDES);
    const alumno = await sesion(n, ALUMNO_REDES);
    await subirOk(profe, curso, 'a.txt', Buffer.alloc(900_000, 1));
    const c = await abrirCrudo(n, cabeceraSubida(alumno, curso, 'trozos.zip', { 'transfer-encoding': 'chunked' }));
    let enviados = 0;
    let maximoTemporal = 0;
    for (let i = 0; i < 40 && c.estado() === null; i++) {
      const trozo = Buffer.alloc(20_000, 9);
      const ok = await c.escribir(Buffer.concat([Buffer.from(`${trozo.length.toString(16)}\r\n`), trozo, Buffer.from('\r\n')]));
      if (!ok) break;
      enviados += trozo.length;
      await new Promise((r) => setTimeout(r, 50));
      maximoTemporal = Math.max(maximoTemporal, bytesSubiendo(n));
    }
    expect(await esperar(() => c.estado() !== null, 5000), `enviados ${enviados}`).toBe(true);
    c.socket.destroy();
    expect(c.estado()).toBe(409);
    expect(c.recibido()).toContain('cuota_excedida');
    expect(enviados).toBeLessThan(800_000);
    expect(maximoTemporal).toBeLessThanOrEqual(100_000 + 20_000);
    await esperar(() => bytesSubiendo(n) === 0, 3000);
    expect(bytesSubiendo(n)).toBe(0);
    expect((await listarArchivos(profe, curso)).json.usado).toBe(900_000);
  });
});

test('un alumno no puede agotar la cuota del curso y un operador puede retirar un archivo para liberar espacio', async () => {
  const CUOTA = 200_000;
  const PERSONA = 50_000;
  await conNucleo(
    { entorno: { ARCHIVOS_CUOTA_CURSO: String(CUOTA), ARCHIVOS_CUOTA_PERSONA: String(PERSONA), ARCHIVOS_MAX_BYTES: '40000' } },
    async (n) => {
      const curso = cursoAislado(n, 'per', MIEMBROS_REDES);
      const alumno = await sesion(n, ALUMNO_REDES);
      const alumna = await sesion(n, ALUMNA_REDES);
      const profe = await sesion(n, PROFE_REDES);
      const dueno = await sesion(n, DUENO_REDES);
      const propio = await subirOk(alumno, curso, 'basura-1.zip', Buffer.alloc(40_000, 1));
      const intentos = await Promise.all(Array.from({ length: 6 }, (_, i) => subir(alumno, curso, `basura-${i + 2}.zip`, Buffer.alloc(20_000, i))));
      for (const r of intentos) {
        expect(r.status, r.texto).toBe(409);
        expect(r.json?.error).toBe('cuota_excedida');
      }
      const deAlumna = await subir(alumna, curso, 'tp.pdf', Buffer.alloc(40_000, 2));
      expect(deAlumna.status, deAlumna.texto).toBe(201);
      await subirOk(profe, curso, 'material-1.pdf', Buffer.alloc(40_000, 3), { material: true });
      await subirOk(profe, curso, 'material-2.pdf', Buffer.alloc(40_000, 4), { material: true });
      expect((await listarArchivos(dueno, curso)).json.usado).toBe(160_000);

      const sinMotivo = n.ejecutar(['retirar-archivo', curso, propio.id, '']);
      expect(sinMotivo.status).not.toBe(0);
      const ajeno = n.ejecutar(['retirar-archivo', 'otro-curso', propio.id, 'prueba']);
      expect(ajeno.status).not.toBe(0);
      const r = n.ejecutar(['retirar-archivo', curso, propio.id, 'archivo de relleno que ocupaba la cuota']);
      expect(r.status, r.stderr).toBe(0);
      const otraVez = n.ejecutar(['retirar-archivo', curso, propio.id, 'de nuevo']);
      expect(otraVez.status).not.toBe(0);

      const l = await listarArchivos(dueno, curso);
      expect(l.json.usado).toBe(120_000);
      expect(l.json.archivos.map((a: any) => a.id)).not.toContain(propio.id);
      expect((await listarArchivos(alumno, curso)).json.archivos.map((a: any) => a.id)).not.toContain(propio.id);
      expect((await bajar(alumno, curso, propio.id)).status).toBe(404);
      expect((await bajar(dueno, curso, propio.id)).status).toBe(404);
      expect(fs.existsSync(rutaArchivo(n, curso, propio.id))).toBe(false);
      const e = await entregar(alumno, curso, { actividad: 'tp1', archivo_id: propio.id });
      expect(e.status).toBe(404);
      expect(n.consultar('SELECT COUNT(*) AS c FROM archivos WHERE id = ?', propio.id)[0].c).toBe(1);
      expect(n.consultar('SELECT COUNT(*) AS c FROM archivos_retirados WHERE archivo_id = ?', propio.id)[0].c).toBe(1);

      const deNuevo = await subir(alumno, curso, 'tp-final.zip', Buffer.alloc(40_000, 5));
      expect(deNuevo.status, deNuevo.texto).toBe(201);
    },
  );
});
