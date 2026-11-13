import fs from 'node:fs';
import http from 'node:http';
import { crearTestCursos, expect, PROFE_AUSTRAL, ALUMNO_AUSTRAL } from '../fixtures.ts';
import { COOKIE_SESION, DOMINIO } from '../../comun/entorno.ts';
import { TIEMPO_PRUEBA_DOCKER, cursoListo, getCurso, idAleatorio, inscribirOk, sesion } from '../lib/cursos.ts';

const test = crearTestCursos({ espia: true });
test.describe.configure({ mode: 'serial', timeout: TIEMPO_PRUEBA_DOCKER });

const MB = 1024 * 1024;

function rssKb(pid: number): number {
  const m = fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+) kB/);
  return m ? Number(m[1]) : 0;
}

let id = '';

test.describe('cuerpos grandes hacia un curso', () => {
  test.beforeAll(async ({ nucleo }) => {
    test.setTimeout(TIEMPO_PRUEBA_DOCKER);
    const profe = await sesion(nucleo, PROFE_AUSTRAL);
    id = idAleatorio('cuerpo');
    await cursoListo(profe, { id, nombre: `Cuerpos ${id}` });
    await inscribirOk(profe, id, [ALUMNO_AUSTRAL]);
  });

  test('muchas subidas grandes y lentas no se acumulan en la memoria del núcleo', async ({ nucleo }) => {
    const alumno = await sesion(nucleo, ALUMNO_AUSTRAL);
    expect((await getCurso(alumno, id, '/espia/registro')).status).toBe(200);
    const pid = nucleo.proceso!.pid!;
    const base = rssKb(pid);
    let maximo = base;
    const muestreo = setInterval(() => {
      maximo = Math.max(maximo, rssKb(pid));
    }, 100);
    const host = `${id}-curso.${DOMINIO}:${nucleo.puerto}`;
    const pedidos: http.ClientRequest[] = [];
    const enviar = (n: number) =>
      new Promise<number>((resolve) => {
        const req = http.request({
          host: '127.0.0.1',
          port: nucleo.puerto,
          path: `/sin-ruta?n=${n}`,
          method: 'POST',
          headers: {
            host,
            cookie: `${COOKIE_SESION}=${alumno.sesion}`,
            origin: `http://${host}`,
            'content-type': 'application/octet-stream',
            'content-length': String(45 * MB),
          },
        });
        pedidos.push(req);
        req.on('error', () => resolve(enviado));
        req.on('response', (res) => res.resume());
        const bloque = Buffer.alloc(MB, 0x61);
        let enviado = 0;
        const limite = Date.now() + 20_000;
        const seguir = () => {
          while (enviado < 30 * MB && Date.now() < limite) {
            enviado += bloque.length;
            if (!req.write(bloque)) {
              req.once('drain', seguir);
              return;
            }
          }
          resolve(enviado);
        };
        seguir();
        setTimeout(() => resolve(enviado), 25_000);
      });
    const enviados = await Promise.all(Array.from({ length: 6 }, (_, i) => enviar(i)));
    await new Promise((r) => setTimeout(r, 1500));
    clearInterval(muestreo);
    maximo = Math.max(maximo, rssKb(pid));
    for (const p of pedidos) p.destroy();
    expect(nucleo.proceso!.exitCode).toBeNull();
    const total = enviados.reduce((a, b) => a + b, 0);
    expect(total, 'las subidas avanzaron').toBeGreaterThan(6 * MB);
    expect((maximo - base) * 1024, `el núcleo retuvo ${(maximo - base) / 1024} MB`).toBeLessThan(64 * MB);
    const despues = await getCurso(alumno, id, '/espia/registro');
    expect(despues.status).toBe(200);
  });

  test('un cuerpo declarado de más de 50 MB se rechaza sin leerlo', async ({ nucleo }) => {
    const alumno = await sesion(nucleo, ALUMNO_AUSTRAL);
    const host = `${id}-curso.${DOMINIO}:${nucleo.puerto}`;
    const estado = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: nucleo.puerto,
          path: '/espia/eco',
          method: 'POST',
          headers: { host, cookie: `${COOKIE_SESION}=${alumno.sesion}`, origin: `http://${host}`, 'content-length': String(60 * MB) },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
          req.destroy();
        },
      );
      req.on('error', reject);
      req.write(Buffer.alloc(1024));
    });
    expect(estado).toBe(413);
    const registro = await getCurso(alumno, id, '/espia/registro');
    expect(registro.json.filter((p: any) => p.metodo === 'POST' && p.ruta === '/espia/eco')).toEqual([]);
  });

  test('las subidas chicas y medianas siguen llegando enteras al curso', async ({ nucleo }) => {
    const alumno = await sesion(nucleo, ALUMNO_AUSTRAL);
    for (const largo of [0, 10, 70 * 1024, 3 * MB]) {
      const cuerpo = 'x'.repeat(largo);
      const p = await alumno.pedir('POST', '/espia/eco', undefined, {
        sub: `${id}-curso`,
        cuerpoCrudo: cuerpo,
        tipo: 'text/plain',
        origen: `http://${id}-curso.${DOMINIO}:${nucleo.puerto}`,
      });
      expect(p.status, p.texto.slice(0, 300)).toBe(200);
      expect(p.json.cuerpo.length).toBe(largo);
    }
  });
});
