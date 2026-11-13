import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { crearTestCursos, expect, PROFE_AUSTRAL, PROFE2_AUSTRAL, ALUMNO_AUSTRAL } from '../fixtures.ts';
import { RAIZ_REPO } from '../../comun/entorno.ts';
import type { Cliente } from '../../comun/http.ts';
import { LINEA_SALUD, PLANTILLA } from '../lib/plantilla.ts';
import {
  TIEMPO_PRUEBA_DOCKER,
  auditoria,
  crearCurso,
  esperarHasta,
  esperarListo,
  getCurso,
  idAleatorio,
  inscribirOk,
  sesion,
} from '../lib/cursos.ts';

const PLANTILLA_SALUD = path.join(
  os.tmpdir(),
  `campusia-plantilla-salud-${crypto.createHash('sha256').update(RAIZ_REPO).digest('hex').slice(0, 10)}`,
);
const SALUD_CONDICIONAL =
  "  app.get('/salud', async (c) => ((await import('node:fs')).existsSync('/datos/listo') ? c.json({ estado: 'ok' }) : c.json({ estado: 'no' }, 503)));";

function prepararPlantillaSalud() {
  fs.rmSync(PLANTILLA_SALUD, { recursive: true, force: true });
  fs.cpSync(PLANTILLA, PLANTILLA_SALUD, {
    recursive: true,
    filter: (f) => {
      const partes = path.relative(PLANTILLA, f).split(path.sep);
      return !partes.includes('node_modules') && !partes.includes('dist') && !partes.includes('.git') && partes[0] !== 'datos';
    },
  });
  const app = path.join(PLANTILLA_SALUD, 'servidor', 'app.ts');
  const texto = fs.readFileSync(app, 'utf8');
  if (!texto.includes(LINEA_SALUD)) throw new Error(`La plantilla cambió: falta la línea ${LINEA_SALUD}`);
  fs.writeFileSync(app, texto.replace(LINEA_SALUD, SALUD_CONDICIONAL));
}

if (process.env.TEST_WORKER_INDEX !== undefined) prepararPlantillaSalud();

const test = crearTestCursos({ entorno: { PLANTILLA_CURSO_DIR: PLANTILLA_SALUD, ARRANQUE_CURSO_SEG: '4' } });
test.describe.configure({ mode: 'serial', timeout: TIEMPO_PRUEBA_DOCKER });

test.afterAll(() => {
  fs.rmSync(PLANTILLA_SALUD, { recursive: true, force: true });
});

async function esperarEstado(c: Cliente, id: string, estado: string) {
  await esperarHasta(
    async () => {
      const r = await c.get(`/api/cursos/${id}`);
      return r.json?.estado === estado;
    },
    480_000,
    `el curso ${id} pasa a ${estado}`,
  );
}

function git(dir: string, ...args: string[]) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

test.describe('cursos que fallan al prepararse', () => {
  test('el dueño reintenta desde la barra un curso en error y queda listo', async ({ nucleo, paginaComo }) => {
    const profe = await sesion(nucleo, PROFE_AUSTRAL);
    const id = idAleatorio('reint');
    expect((await crearCurso(profe, { id })).status).toBe(201);
    await inscribirOk(profe, id, [ALUMNO_AUSTRAL]);
    await esperarEstado(profe, id, 'error');
    expect(nucleo.consultar('SELECT error FROM contenedores WHERE curso_id = ?', id)[0].error).toBeTruthy();
    const alumno = await sesion(nucleo, ALUMNO_AUSTRAL);
    expect((await getCurso(alumno, id, '/')).status).toBe(503);
    expect((await crearCurso(profe, { id })).status).toBe(409);
    expect((await alumno.post(`/api/cursos/${id}/reintentar`)).status).toBe(403);
    const ajeno = await sesion(nucleo, PROFE2_AUSTRAL);
    expect((await ajeno.post(`/api/cursos/${id}/reintentar`)).status).toBe(404);
    fs.writeFileSync(path.join(nucleo.raizCursos, id, 'datos', 'listo'), 'ok');
    const pagina = await paginaComo(profe);
    await pagina.goto(nucleo.url(id, '/'));
    const boton = pagina.locator('[data-accion="reintentar"]');
    await expect(boton).toBeVisible({ timeout: 30_000 });
    await boton.click();
    await expect(boton).toBeHidden();
    await esperarListo(profe, id);
    await expect(pagina.locator('#curso-cargando')).toBeHidden({ timeout: 120_000 });
    expect((await getCurso(alumno, id, '/')).status).toBe(200);
    expect(auditoria(nucleo, 'curso_reintentado').some((e) => String(e.detalle).includes(id))).toBe(true);
    const otra = await profe.post(`/api/cursos/${id}/reintentar`);
    expect(otra.status).toBe(409);
  });

  test('reintentar rehace un repo que quedó a medias y conserva los datos', async ({ nucleo }) => {
    const profe = await sesion(nucleo, PROFE_AUSTRAL);
    const id = idAleatorio('medias');
    expect((await crearCurso(profe, { id })).status).toBe(201);
    await esperarEstado(profe, id, 'error');
    const repo = path.join(nucleo.raizCursos, id);
    fs.rmSync(path.join(repo, '.git'), { recursive: true, force: true });
    fs.rmSync(path.join(repo, 'package.json'), { force: true });
    fs.writeFileSync(path.join(repo, 'datos', 'listo'), 'ok');
    fs.writeFileSync(path.join(repo, 'datos', 'marca.txt'), 'sigue');
    const r = await profe.post(`/api/cursos/${id}/reintentar`);
    expect(r.status, r.texto).toBe(200);
    expect(r.json).toMatchObject({ id, estado: 'preparando', rol: 'dueño' });
    await esperarListo(profe, id);
    expect(git(repo, 'branch', '--format=%(refname:short)').split('\n').sort()).toEqual(['main', 'prueba']);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(fs.existsSync(path.join(repo, 'package.json'))).toBe(true);
    expect(fs.readFileSync(path.join(repo, 'datos', 'marca.txt'), 'utf8')).toBe('sigue');
  });

  test('si el núcleo se reinicia en medio de la preparación, la retoma en vez de dejar el curso roto', async ({ nucleo }) => {
    const profe = await sesion(nucleo, PROFE_AUSTRAL);
    const id = idAleatorio('retoma');
    expect((await crearCurso(profe, { id })).status).toBe(201);
    const datos = path.join(nucleo.raizCursos, id, 'datos');
    await esperarHasta(() => fs.existsSync(datos), 120_000, 'el repo del curso tiene su carpeta de datos');
    fs.writeFileSync(path.join(datos, 'listo'), 'ok');
    expect(nucleo.consultar('SELECT estado FROM cursos WHERE id = ?', id)[0].estado).toBe('preparando');
    const proceso = nucleo.proceso!;
    await new Promise<void>((resolve) => {
      proceso.once('exit', () => resolve());
      proceso.kill('SIGKILL');
    });
    nucleo.proceso = null;
    await nucleo.iniciar();
    await esperarListo(profe, id);
    expect(fs.readFileSync(nucleo.archivoRegistro, 'utf8')).toContain(`se retoma la preparación del curso ${id}`);
  });
});
