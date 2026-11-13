import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, expect } from '@playwright/test';
import type { Nucleo } from '../../comun/nucleo.ts';
import { ALUMNA_REDES, ALUMNO_REDES, DUENO_REDES, OWNER, PROFE_REDES, REDES, SEMILLA } from '../fixtures.ts';
import { bajar, entregarOk, idUsuario, listarArchivos, ponerNotaOk, sesion, sha256, subirOk, verEntregas, verHistorial, verNotas } from '../lib/datos.ts';
import { git, levantarNucleoEnRaiz, listarTar, raizNueva, respaldar, respaldosEn, restaurarEn } from '../lib/respaldo.ts';

test.describe.configure({ mode: 'serial', timeout: 300_000 });

const limpiar: Array<() => Promise<void> | void> = [];

test.afterAll(async () => {
  for (const f of limpiar.reverse()) await f();
});

async function instantanea(nucleo: Nucleo) {
  const dueno = await sesion(nucleo, DUENO_REDES);
  const alumno = await sesion(nucleo, ALUMNO_REDES);
  const entregas = (await verEntregas(dueno, REDES)).json;
  const historial = (await verHistorial(dueno, REDES)).json;
  const notas = (await verNotas(dueno, REDES)).json;
  const notasAlumno = (await verNotas(alumno, REDES)).json;
  const archivos = (await listarArchivos(dueno, REDES)).json;
  const contenidos: Record<string, string> = {};
  for (const a of archivos.archivos) {
    const b = await bajar(dueno, REDES, a.id);
    expect(b.status).toBe(200);
    contenidos[a.id] = sha256(b.cuerpo);
  }
  return { entregas, historial, notas, notasAlumno, archivos, contenidos };
}

test('respaldar y restaurar devuelve entregas, notas, archivos y cursos tal como estaban', async () => {
  const raiz = raizNueva();
  limpiar.push(() => fs.rmSync(raiz, { recursive: true, force: true }));
  let nucleo = await levantarNucleoEnRaiz(raiz, { semilla: SEMILLA, owner: OWNER });
  limpiar.push(() => nucleo.cerrar());

  const repo = path.join(raiz, 'cursos', REDES);
  fs.mkdirSync(path.join(repo, 'datos'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'README.md'), '# Redes\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'datos/\n');
  git(repo, ['init', '-q']);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'inicial']);
  const commit = git(repo, ['rev-parse', 'HEAD']);
  const baseCurso = new DatabaseSync(path.join(repo, 'datos', 'curso.sqlite'));
  baseCurso.exec("CREATE TABLE clases (id INTEGER PRIMARY KEY, titulo TEXT); INSERT INTO clases (titulo) VALUES ('Modelo OSI');");
  baseCurso.close();

  const alumno = await sesion(nucleo, ALUMNO_REDES);
  const alumna = await sesion(nucleo, ALUMNA_REDES);
  const profe = await sesion(nucleo, PROFE_REDES);
  const binario = crypto.randomBytes(200 * 1024);
  const a1 = await subirOk(alumno, REDES, 'tp1.zip', binario);
  const a2 = await subirOk(alumna, REDES, 'tp1-sofia.pdf', '%PDF-1.4 sofia');
  const material = await subirOk(profe, REDES, 'Guía 1.pdf', '%PDF-1.4 guia', { material: true });
  await entregarOk(alumno, REDES, { actividad: 'tp1', texto: 'Entrego el TP', archivo_id: a1.id });
  await entregarOk(alumna, REDES, { actividad: 'tp1', archivo_id: a2.id });
  await ponerNotaOk(profe, REDES, { usuario_id: idUsuario(nucleo, ALUMNO_REDES), actividad: 'tp1', valor: '6' });
  await ponerNotaOk(profe, REDES, { usuario_id: idUsuario(nucleo, ALUMNO_REDES), actividad: 'tp1', valor: '9', comentario: 'Corregido' });
  await ponerNotaOk(profe, REDES, { usuario_id: idUsuario(nucleo, ALUMNA_REDES), actividad: 'tp1', valor: '10' });

  const antes = await instantanea(nucleo);
  expect(antes.entregas.entregas).toHaveLength(2);
  expect(antes.historial.notas).toHaveLength(3);
  expect(antes.archivos.archivos.map((x: any) => x.id).sort()).toEqual([a1.id, a2.id, material.id].sort());

  fs.mkdirSync(path.join(raiz, 'archivos', '.subiendo'), { recursive: true });
  fs.writeFileSync(path.join(raiz, 'archivos', '.subiendo', 'a-medias'), 'parcial');

  const r = respaldar(raiz);
  expect(r.status, r.stderr + r.stdout).toBe(0);
  const lista = respaldosEn(path.join(raiz, 'respaldos'));
  expect(lista).toHaveLength(1);
  const respaldo = path.join(raiz, 'respaldos', lista[0]);
  const entradas = listarTar(path.join(respaldo, 'respaldo.tar.gz'));
  expect(entradas).toContain('plataforma/campusia.db');
  for (const a of [a1, a2, material]) expect(entradas).toContain(`archivos/${REDES}/${a.id}`);
  expect(entradas.some((e) => e.includes('.subiendo'))).toBe(false);
  expect(entradas.some((e) => e.includes('tp1.zip') || e.includes('Guía'))).toBe(false);

  const owner = await sesion(nucleo, OWNER);
  const estado = await owner.get('/api/owner/estado');
  expect(estado.status, estado.texto).toBe(200);
  expect(estado.json.respaldo.ultimo.nombre).toBe(lista[0]);

  await entregarOk(alumno, REDES, { actividad: 'tp2', texto: 'Después del respaldo' });
  await nucleo.detener();

  const destino = path.join(raiz, 'restaurado');
  const rr = restaurarEn(raiz, destino, respaldo);
  expect(rr.status, rr.stderr + rr.stdout).toBe(0);
  for (const a of [a1, a2, material]) {
    expect(fs.existsSync(path.join(destino, 'archivos', REDES, a.id))).toBe(true);
  }
  expect(git(path.join(destino, 'cursos', REDES), ['rev-parse', 'HEAD'])).toBe(commit);
  const restaurada = new DatabaseSync(path.join(destino, 'cursos', REDES, 'datos', 'curso.sqlite'));
  expect((restaurada.prepare('SELECT titulo FROM clases').all() as any[]).map((x) => x.titulo)).toEqual(['Modelo OSI']);
  restaurada.close();

  await nucleo.cerrar();
  nucleo = await levantarNucleoEnRaiz(destino);
  const despues = await instantanea(nucleo);
  expect(despues.entregas).toEqual(antes.entregas);
  expect(despues.historial).toEqual(antes.historial);
  expect(despues.notas).toEqual(antes.notas);
  expect(despues.notasAlumno).toEqual(antes.notasAlumno);
  expect(despues.archivos).toEqual(antes.archivos);
  expect(despues.contenidos).toEqual(antes.contenidos);
  expect(despues.contenidos[a1.id]).toBe(sha256(binario));
  expect(JSON.stringify(despues.entregas)).not.toContain('Después del respaldo');

  const alumnoOtraVez = await sesion(nucleo, ALUMNO_REDES);
  const nueva = await entregarOk(alumnoOtraVez, REDES, { actividad: 'tp2', texto: 'Después de restaurar' });
  expect(nueva.id).toBeGreaterThan(Math.max(...antes.entregas.entregas.map((x: any) => x.id)));
});
