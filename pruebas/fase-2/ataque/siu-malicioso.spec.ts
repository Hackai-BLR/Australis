import fs from 'node:fs';
import http from 'node:http';
import { crearTestCursos, expect, PROFE_AUSTRAL } from '../fixtures.ts';
import { aleatorio } from '../../comun/sesion.ts';
import type { Respuesta } from '../../comun/http.ts';
import { crearXlsx } from '../lib/xlsx.ts';
import { crearXlsGigante, crearXlsxBombaCompartidas, crearXlsxEsquinaLejana } from '../lib/planillas.ts';
import { crearCurso, idAleatorio, sesion } from '../lib/cursos.ts';

const test = crearTestCursos();
test.describe.configure({ mode: 'serial', timeout: 300_000 });

function memoriaKb(pid: number, campo: 'VmHWM' | 'VmRSS'): number {
  const estado = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
  const m = estado.match(new RegExp(`${campo}:\\s+(\\d+) kB`));
  if (!m) throw new Error(`No se pudo leer ${campo} del núcleo`);
  return Number(m[1]);
}

function vivo(puerto: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: puerto, path: '/salud', headers: { host }, timeout: 3000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

let id = '';

test.describe('planillas del SIU manipuladas', () => {
  test.beforeAll(async ({ nucleo }) => {
    const profe = await sesion(nucleo, PROFE_AUSTRAL);
    id = idAleatorio('siumal');
    const r = await crearCurso(profe, { id, nombre: `SIU ${id}` });
    expect(r.status, r.texto).toBe(201);
  });

  for (const [nombre, archivo, armar] of [
    ['un xlsx con una celda en XFD1048576', 'lejana.xlsx', async () => crearXlsxEsquinaLejana()],
    ['un xlsx con sharedStrings que se descomprime a cientos de MB', 'bomba.xlsx', async () => crearXlsxBombaCompartidas(700)],
    ['un xls con dimensiones y celdas en la última fila y columna de muchas hojas', 'gigante.xls', async () => crearXlsGigante(12)],
  ] as const) {
    test(`${nombre} se rechaza sin tirar abajo ni inflar el núcleo`, async ({ nucleo }) => {
      const pid = nucleo.proceso!.pid!;
      const pico = memoriaKb(pid, 'VmHWM');
      const contenido = await armar();
      expect(contenido.length).toBeLessThan(2 * 1024 * 1024);
      const profe = await sesion(nucleo, PROFE_AUSTRAL);
      const inicio = Date.now();
      let r: Respuesta | null = null;
      let falla: unknown = null;
      try {
        r = await profe.post(`/api/cursos/${id}/inscriptos/siu`, { archivo, contenido: contenido.toString('base64') });
      } catch (e) {
        falla = e;
      }
      expect(falla, 'el pedido no tiene que cortar la conexión').toBeNull();
      expect(nucleo.proceso!.exitCode, 'el núcleo sigue corriendo').toBeNull();
      expect(r!.status, r!.texto).toBe(400);
      expect(r!.json.error).toBe('archivo_invalido');
      expect(Date.now() - inicio).toBeLessThan(60_000);
      expect(await vivo(nucleo.puerto, nucleo.host())).toBe(true);
      expect(memoriaKb(pid, 'VmHWM') - pico, 'el pico de memoria del núcleo no crece con el archivo').toBeLessThan(250 * 1024);
      const curso = nucleo.consultar('SELECT estado FROM cursos WHERE id = ?', id)[0];
      expect(curso.estado).not.toBe('error');
    });
  }

  test('después de los ataques, un xlsx normal se sigue importando', async ({ nucleo }) => {
    const profe = await sesion(nucleo, PROFE_AUSTRAL);
    const n1 = `${aleatorio('trasbomba')}@mail.austral.edu.ar`;
    const libro = crearXlsx([
      ['Nombre y Apellido', 'E-mail'],
      ['Ana Torres', n1],
    ]);
    const r = await profe.post(`/api/cursos/${id}/inscriptos/siu`, { archivo: 'ok.xlsx', contenido: libro.toString('base64') });
    expect(r.status, r.texto).toBe(200);
    expect(r.json.agregados).toEqual([n1]);
  });

  test('varias importaciones manipuladas al mismo tiempo tampoco lo tiran abajo', async ({ nucleo }) => {
    const pid = nucleo.proceso!.pid!;
    const pico = memoriaKb(pid, 'VmHWM');
    const profe = await sesion(nucleo, PROFE_AUSTRAL);
    const contenido = crearXlsxEsquinaLejana().toString('base64');
    const rs = await Promise.all(
      Array.from({ length: 6 }, () => profe.post(`/api/cursos/${id}/inscriptos/siu`, { archivo: 'lejana.xlsx', contenido })),
    );
    for (const r of rs) {
      expect(r.status).toBe(400);
      expect(r.json.error).toBe('archivo_invalido');
    }
    expect(nucleo.proceso!.exitCode).toBeNull();
    expect(memoriaKb(pid, 'VmHWM') - pico).toBeLessThan(250 * 1024);
  });
});
