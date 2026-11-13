import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { crearTestCursos, expect, levantarNucleoCursos, PROFE_AUSTRAL, ALUMNO_AUSTRAL } from '../fixtures.ts';
import { RAIZ_REPO } from '../../comun/entorno.ts';
import { inspeccionar, inspeccionarRed, limpiarPrefijo } from '../lib/docker.ts';
import {
  TIEMPO_PRUEBA_DOCKER,
  apiDeCurso,
  contenedorDe,
  cursoListo,
  esperarHasta,
  getCurso,
  idAleatorio,
  inscribirOk,
  sesion,
} from '../lib/cursos.ts';

const FALSO = path.join(os.tmpdir(), `campusia-nsenter-${crypto.createHash('sha256').update(RAIZ_REPO).digest('hex').slice(0, 10)}`);
const REGISTRO = path.join(FALSO, 'nsenter.log');
const PID = path.join(FALSO, 'child_pid');

function prepararNsenterFalso() {
  fs.rmSync(FALSO, { recursive: true, force: true });
  fs.mkdirSync(FALSO, { recursive: true });
  fs.writeFileSync(
    path.join(FALSO, 'nsenter'),
    `#!/bin/bash
printf '%s\\n' "$*" >> '${REGISTRO}'
while [ $# -gt 0 ]; do
  case "$1" in
    -t) shift 2 ;;
    -*) shift ;;
    *) break ;;
  esac
done
exec "$@"
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(PID, '4242\n');
}

if (process.env.TEST_WORKER_INDEX !== undefined) prepararNsenterFalso();

const ENTORNO = {
  CONTENEDORES_SIN_ROOT: 'si',
  CONTENEDORES_PID_RED: PID,
  PATH: `${FALSO}:${process.env.PATH ?? ''}`,
};

const test = crearTestCursos({ entorno: ENTORNO });
test.describe.configure({ mode: 'serial', timeout: TIEMPO_PRUEBA_DOCKER });

test.afterAll(({ nucleo }) => {
  const base = process.env.XDG_RUNTIME_DIR || os.tmpdir();
  fs.rmSync(path.join(base, `campusia-${nucleo.prefijo}`), { recursive: true, force: true });
  fs.rmSync(FALSO, { recursive: true, force: true });
});

function lineasNsenter(): string[] {
  return fs.existsSync(REGISTRO) ? fs.readFileSync(REGISTRO, 'utf8').split('\n').filter(Boolean) : [];
}

let id = '';

test.describe('Docker sin root', () => {
  test.beforeAll(async ({ nucleo }) => {
    test.setTimeout(TIEMPO_PRUEBA_DOCKER);
    const profe = await sesion(nucleo, PROFE_AUSTRAL);
    id = idAleatorio('sinroot');
    await cursoListo(profe, { id, nombre: `Sin root ${id}`, periodo: 'Anual 2027' });
    await inscribirOk(profe, id, [ALUMNO_AUSTRAL]);
  });

  test('la escucha para cursos se abre dentro del espacio de red del demonio con nsenter', async ({ nucleo }) => {
    const lineas = lineasNsenter();
    expect(lineas.length).toBeGreaterThan(0);
    const partes = lineas[0].split(' ');
    expect(partes.slice(0, 5)).toEqual(['-U', '--preserve-credentials', '-n', '-t', '4242']);
    expect(partes[6]).toBe('puente');
    const red = inspeccionarRed(`${nucleo.prefijo}-cursos`);
    const puerta = red.IPAM.Config.map((c: any) => c.Gateway).find((g: string) => g && !g.includes(':'));
    expect(partes[7]).toBe(`${puerta}:${nucleo.puertoApiCursos}`);
    const registro = fs.readFileSync(nucleo.archivoRegistro, 'utf8');
    expect(registro).toContain('Docker sin root');
    expect(apiDeCurso(nucleo, id)).toBe(`http://${puerta}:${nucleo.puertoApiCursos}`);
  });

  test('el alumno llega al curso por el puente y el curso llega a la API para cursos', async ({ nucleo }) => {
    const alumno = await sesion(nucleo, ALUMNO_AUSTRAL);
    const portada = await getCurso(alumno, id, '/');
    expect(portada.status, portada.texto.slice(0, 300)).toBe(200);
    const datos = await getCurso(alumno, id, '/api/portada');
    expect(datos.status, datos.texto).toBe(200);
    expect(datos.json.curso).toEqual({ id, nombre: `Sin root ${id}`, periodo: 'Anual 2027' });
    const yo = await getCurso(alumno, id, '/api/yo');
    expect(yo.json?.rol).toBe('alumno');
  });

  test('el contenedor sigue sin puertos publicados', async ({ nucleo }) => {
    const info = inspeccionar(contenedorDe(nucleo, id));
    expect(info.HostConfig.PortBindings ?? {}).toEqual({});
    expect(info.HostConfig.NetworkMode).toBe(`${nucleo.prefijo}-cursos`);
  });

  test('si el demonio sin root cambia de proceso, el puente se rearma', async ({ nucleo }) => {
    fs.writeFileSync(PID, '4343\n');
    await esperarHasta(() => lineasNsenter().some((l) => l.includes('-t 4343')), 60_000, 'el puente se relanza con el proceso nuevo');
    const alumno = await sesion(nucleo, ALUMNO_AUSTRAL);
    await esperarHasta(
      async () => (await getCurso(alumno, id, '/api/portada')).status === 200,
      60_000,
      'el curso responde después de rearmar el puente',
    );
  });

  test('sin el proceso del demonio sin root el núcleo no arranca y lo dice', async () => {
    let error = '';
    try {
      const n = await levantarNucleoCursos({ entorno: { ...ENTORNO, CONTENEDORES_PID_RED: path.join(FALSO, 'no-existe') } });
      await n.cerrar();
      limpiarPrefijo(n.prefijo);
    } catch (e) {
      error = String((e as Error).message);
    }
    expect(error).toContain('Docker sin root');
  });
});
