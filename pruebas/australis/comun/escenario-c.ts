import { execFileSync } from 'node:child_process';
import { expect, type Browser } from '@playwright/test';
import { aleatorio, origenDe, paginaDe, type Sesion } from './escenario-b.ts';
import { pdf } from './cliente.ts';
import { estadoB } from './pila-b.ts';

export type Alumno = { nombre: string; correo: string };
export type CampusC = { nucleo: number; australis: number };

const NOMBRES = ['Ines', 'Bruno', 'Celia', 'Dario', 'Elena', 'Fabio', 'Gala', 'Hugo'];
const APELLIDOS = ['Acosta', 'Benitez', 'Cabrera', 'Duarte', 'Escobar', 'Ferreyra', 'Godoy', 'Heredia'];

export function alumnosDePrueba(cantidad: number): Alumno[] {
  const marca = aleatorio('');
  return Array.from({ length: cantidad }, (_, i) => ({
    nombre: `${NOMBRES[i % NOMBRES.length]} ${APELLIDOS[i % APELLIDOS.length]}`,
    correo: `${NOMBRES[i % NOMBRES.length].toLowerCase()}.${marca}@mail.austral.edu.ar`,
  }));
}

export async function crearCampusConAlumnos(profe: Sesion, nombre: string, alumnos: Alumno[]): Promise<CampusC> {
  const creado = await profe.post('/api/cursos-modulos', { nombre });
  expect(creado.estado, creado.texto).toBe(201);
  const campus = { nucleo: creado.json.campus_id as number, australis: creado.json.campus_externo as number };
  const texto = ['Nombre,Correo', ...alumnos.map((a) => `${a.nombre},${a.correo}`)].join('\n');
  const vista = await profe.campus('POST', `/api/campuses/${campus.australis}/roster/imports`, { text: texto });
  expect(vista.estado, vista.texto).toBe(201);
  const confirmada = await profe.campus('POST', `/api/campuses/${campus.australis}/roster/imports/${vista.json.id}/confirm`, {});
  expect(confirmada.estado, confirmada.texto).toBe(200);
  return campus;
}

export async function crearClase(profe: Sesion, campus: CampusC, titulo: string, minutosDesdeInicio: number, duracionMin: number): Promise<number> {
  const empieza = new Date(Date.now() - minutosDesdeInicio * 60_000).toISOString();
  const r = await profe.campus('POST', `/api/campuses/${campus.australis}/classes`, { title: titulo, starts_at: empieza, duration_min: duracionMin });
  expect(r.estado, r.texto).toBe(201);
  return r.json.id as number;
}

export async function terminarClase(profe: Sesion, claseId: number) {
  const r = await profe.campus('POST', `/api/classes/${claseId}/end`, {});
  expect(r.estado, r.texto).toBe(200);
  expect(r.json.recording_status).toBe('transcript_ready');
}

export async function cargarNotas(profe: Sesion, campus: CampusC, nota: (indice: number) => number): Promise<number> {
  const item = await profe.campus('POST', `/api/campuses/${campus.australis}/gradebook/items`, { title: 'Parcial', weight: 1 });
  expect(item.estado, item.texto).toBe(200);
  const libro = await profe.campus('GET', `/api/campuses/${campus.australis}/gradebook`);
  const entradas = libro.json.students.map((s: any, i: number) => ({ item_id: item.json.id, student_id: s.user_id, score: nota(i) }));
  const guardado = await profe.campus('PUT', `/api/campuses/${campus.australis}/gradebook/entries`, { entries: entradas });
  expect(guardado.estado, guardado.texto).toBe(200);
  return item.json.id as number;
}

export async function subirPdfPorPantalla(browser: Browser, profe: Sesion, campus: CampusC, titulo: string, paginas: number) {
  const { ctx, pagina } = await paginaDe(browser, profe);
  await pagina.goto(`${origenDe('campus')}/campuses/${campus.australis}/slides`);
  await pagina.getByLabel('Título (opcional)').fill(titulo);
  await pagina.getByLabel('Archivo PDF').setInputFiles({ name: 'clase.pdf', mimeType: 'application/pdf', buffer: pdf(paginas) });
  await pagina.getByRole('button', { name: 'Subir', exact: true }).click();
  await expect(pagina.getByText(new RegExp(`clase\\.pdf · ${paginas} páginas`)).first()).toBeVisible();
  const lista = await profe.campus('GET', `/api/campuses/${campus.australis}/presentations`);
  expect(lista.estado, lista.texto).toBe(200);
  const fila = lista.json.find((p: any) => p.title === titulo);
  expect(fila, 'la presentación subida está en la lista').toBeTruthy();
  return { ctx, pagina, presentacion: fila.id as number };
}

export function fijarAjusteGlobal(clave: string, valorJson: string) {
  const guion = `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync('/data/australis.db');
    db.exec('PRAGMA busy_timeout = 10000');
    const r = db.prepare("UPDATE core_settings SET value_json = ? WHERE scope = 'global' AND key = ?").run(process.env.VALOR, process.env.CLAVE);
    console.log(r.changes);
    db.close();
  `;
  const salida = execFileSync(
    'docker',
    ['run', '--rm', '--volumes-from', estadoB().backend, '-e', `VALOR=${valorJson}`, '-e', `CLAVE=${clave}`, '--entrypoint', 'node', 'node:22-alpine', '-e', guion],
    { encoding: 'utf8' },
  );
  expect(Number(salida.trim().split('\n').pop()), `el ajuste ${clave} existe`).toBe(1);
}
