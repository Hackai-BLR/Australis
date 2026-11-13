import net from 'node:net';
import { crearTestCursos, expect } from '../../fase-2/fixtures.ts';
import { nuevaSemilla } from '../../fase-2/lib/identidad.ts';
import { TIEMPO_PRUEBA_DOCKER, apiDeCurso, cursoListo, idAleatorio, inscribirOk, tokenDeCurso } from '../../fase-2/lib/cursos.ts';
import { ALUMNO_REDES, DUENO_REDES } from '../fixtures.ts';
import { archivosEnDisco, raizArchivos, sesion } from '../lib/datos.ts';
import { apiCurso, identidad } from '../lib/api-curso.ts';

const CLAVE = nuevaSemilla();
const LIMITE = 20;
const test = crearTestCursos({
  entorno: { IDENTIDAD_CLAVE_PRIVADA: CLAVE.semilla, LIMITE_API_CURSO_MINUTO: String(LIMITE), TIEMPO_ESPERA_CUERPO_SEG: '3' },
});
test.describe.configure({ mode: 'serial', timeout: TIEMPO_PRUEBA_DOCKER });

let a = '';
let b = '';
let apiA = '';
let apiB = '';
let tokenA = '';
let tokenB = '';

test.describe('límites de la escucha para cursos', () => {
  test.beforeAll(async ({ nucleo }) => {
    test.setTimeout(TIEMPO_PRUEBA_DOCKER);
    const dueno = await sesion(nucleo, DUENO_REDES);
    a = idAleatorio('lia');
    b = idAleatorio('lib');
    await cursoListo(dueno, { id: a });
    await cursoListo(dueno, { id: b });
    await inscribirOk(dueno, a, [ALUMNO_REDES]);
    await inscribirOk(dueno, b, [ALUMNO_REDES]);
    apiA = apiDeCurso(nucleo, a);
    apiB = apiDeCurso(nucleo, b);
    tokenA = tokenDeCurso(nucleo, a);
    tokenB = tokenDeCurso(nucleo, b);
    expect(tokenA).toMatch(/^cct_/);
    expect(tokenB).toMatch(/^cct_/);
  });

  test('un cuerpo que llega gota a gota a la escucha para cursos se corta y no deja nada', async ({ nucleo }) => {
    const ident = identidad(nucleo, CLAVE.privada, b, ALUMNO_REDES, 'alumno', {});
    const url = new URL(apiB);
    const largo = 20_000;
    const cabecera =
      `POST /api/curso/archivos?nombre=lento.txt HTTP/1.1\r\nHost: ${url.host}\r\nAuthorization: Bearer ${tokenB}\r\n` +
      `X-Campus-Identidad: ${ident}\r\nContent-Type: application/octet-stream\r\nContent-Length: ${largo}\r\n\r\n`;
    const inicio = Date.now();
    const r = await new Promise<{ ms: number; enviados: number; respuesta: string }>((resolve) => {
      let enviados = 0;
      let respuesta = '';
      let goteo: NodeJS.Timeout | undefined;
      const s = net.connect({ host: url.hostname, port: Number(url.port || 80) }, () => {
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
    expect(r.ms, r.respuesta.slice(0, 80)).toBeLessThan(15_000);
    expect(r.ms).toBeGreaterThanOrEqual(2_500);
    expect(r.enviados).toBeLessThan(100);
    expect(r.respuesta).not.toMatch(/^HTTP\/1\.1 2\d\d/);
    await new Promise((res) => setTimeout(res, 300));
    expect(nucleo.consultar('SELECT COUNT(*) AS c FROM archivos WHERE curso_id = ?', b)[0].c).toBe(0);
    expect(archivosEnDisco(`${raizArchivos(nucleo)}/.subiendo`)).toEqual([]);
    const despues = await apiCurso(apiB, 'GET', '/api/curso/yo', { token: tokenB });
    expect(despues.status, despues.texto).toBe(200);
  });

  test('el token de un curso tiene un límite de pedidos por minuto que se controla antes que la identidad', async ({ nucleo }) => {
    const estados: number[] = [];
    const errores: string[] = [];
    for (let i = 0; i < LIMITE + 5; i++) {
      const r = await apiCurso(apiA, 'GET', '/api/curso/archivos', { token: tokenA, identidad: 'basura' });
      estados.push(r.status);
      errores.push(r.json?.error);
    }
    const primero = estados.indexOf(429);
    expect(primero, estados.join(',')).toBeGreaterThanOrEqual(LIMITE - 3);
    expect(primero).toBeLessThanOrEqual(LIMITE);
    expect(estados.slice(0, primero).every((s) => s === 401), estados.join(',')).toBe(true);
    expect(errores.slice(0, primero).every((e) => e === 'identidad_invalida')).toBe(true);
    expect(estados.slice(primero).every((s) => s === 429), estados.join(',')).toBe(true);
    expect(errores.slice(primero).every((e) => e === 'demasiados_intentos')).toBe(true);
    const valida = identidad(nucleo, CLAVE.privada, a, ALUMNO_REDES, 'alumno', {});
    const r = await apiCurso(apiA, 'GET', '/api/curso/archivos', { token: tokenA, identidad: valida });
    expect(r.status).toBe(429);
    expect(r.json?.error).toBe('demasiados_intentos');
    expect(Number(r.encabezados.get('retry-after'))).toBeGreaterThan(0);
    const yo = await apiCurso(apiA, 'GET', '/api/curso/yo', { token: tokenA });
    expect(yo.status).toBe(429);
    const otro = await apiCurso(apiB, 'GET', '/api/curso/archivos', { token: tokenB, identidad: identidad(nucleo, CLAVE.privada, b, ALUMNO_REDES, 'alumno', {}) });
    expect(otro.status, otro.texto).toBe(200);
    const salud = await apiCurso(apiA, 'GET', '/salud', { token: tokenA });
    expect(salud.status).not.toBe(429);
  });
});
