import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cliente, ahoraUtc, pdf, tokenDeInvitacion } from './cliente.ts';
import { CLAVE_SECRETARIA, CORREO_SECRETARIA } from './pila.ts';

export const CLAVE = 'una-clave-larga-1';
export const ETICA = 'Agregá una semana sobre ética antes del examen';

const aqui = path.dirname(fileURLToPath(import.meta.url));
export const XLSX = fs.readFileSync(path.join(aqui, '..', 'checkpoint-a', 'datos', 'alumnos.xlsx'));

export function correoUnico(prefijo: string): string {
  return `${prefijo}-${Math.random().toString(36).slice(2, 8)}@pruebas.example`;
}

export async function secretaria(): Promise<Cliente> {
  return Cliente.conSesion(CORREO_SECRETARIA, CLAVE_SECRETARIA);
}

export async function crearDocente(sec: Cliente, nombre = 'Docente Prueba'): Promise<{ cliente: Cliente; correo: string; id: number }> {
  const correo = correoUnico('docente');
  const creado = await sec.post('/api/users', { email: correo, full_name: nombre, role: 'professor' });
  if (creado.estado !== 201) throw new Error(`No se pudo crear el docente: ${creado.texto}`);
  const cliente = await Cliente.nuevo();
  const aceptada = await cliente.post(`/api/auth/invites/${tokenDeInvitacion(creado.json.invite_url)}/accept`, { password: CLAVE });
  if (aceptada.estado !== 200) throw new Error(`No se pudo aceptar la invitación: ${aceptada.texto}`);
  return { cliente, correo, id: creado.json.user?.id ?? creado.json.id };
}

export async function crearCampus(docente: Cliente, nombre = 'Seminario de prueba'): Promise<number> {
  const r = await docente.post('/api/campuses', { name: nombre, template_key: 'weekly_topics' });
  if (r.estado !== 201) throw new Error(`No se pudo crear el campus: ${r.texto}`);
  return r.json.id;
}

export type Alumno = { correo: string; id: number; invitacion: string | null };

export async function importarAlumnos(docente: Cliente, campus: number, texto: string): Promise<Alumno[]> {
  const vista = await docente.post(`/api/campuses/${campus}/roster/imports`, { text: texto });
  if (vista.estado !== 201) throw new Error(`Importación rechazada: ${vista.texto}`);
  const confirmada = await docente.post(`/api/campuses/${campus}/roster/imports/${vista.json.id}/confirm`, {});
  if (confirmada.estado !== 200) throw new Error(`Confirmación rechazada: ${confirmada.texto}`);
  const miembros = await docente.get(`/api/campuses/${campus}/members`);
  const enlaces = new Map<string, string>(confirmada.json.invites.map((i: any) => [i.email, i.invite_url]));
  return miembros.json
    .filter((m: any) => m.role === 'student')
    .map((m: any) => ({ correo: m.email, id: m.user_id, invitacion: enlaces.get(m.email) ?? null }));
}

export function listaDeAlumnos(cantidad: number, prefijo = 'alumno'): string {
  const filas = Array.from({ length: cantidad }, (_, i) => `Alumno ${String(i + 1).padStart(2, '0')} Prueba,${prefijo}${String(i + 1).padStart(2, '0')}@alumnos.test`);
  return ['Nombre,Correo', ...filas].join('\n');
}

export async function alumnoConSesion(docente: Cliente, campus: number, correo: string): Promise<Cliente> {
  const sesion = await Cliente.nuevo();
  const reinvitacion = await docente.post(`/api/campuses/${campus}/members/${await idDe(docente, campus, correo)}/invite`, {});
  if (reinvitacion.estado !== 200 && reinvitacion.estado !== 201) throw new Error(`Sin invitación: ${reinvitacion.texto}`);
  const aceptada = await sesion.post(`/api/auth/invites/${tokenDeInvitacion(reinvitacion.json.invite_url)}/accept`, { password: CLAVE });
  if (aceptada.estado !== 200) throw new Error(`No se pudo aceptar: ${aceptada.texto}`);
  return sesion;
}

async function idDe(docente: Cliente, campus: number, correo: string): Promise<number> {
  const miembros = await docente.get(`/api/campuses/${campus}/members`);
  return miembros.json.find((m: any) => m.email === correo).user_id;
}

export async function crearEvaluacion(docente: Cliente, campus: number, titulo: string, peso: number): Promise<number> {
  const r = await docente.post(`/api/campuses/${campus}/gradebook/items`, { title: titulo, weight: peso });
  if (r.estado !== 200) throw new Error(`No se pudo crear la evaluación: ${r.texto}`);
  return r.json.id;
}

export async function crearClaseDeHoy(docente: Cliente, campus: number, titulo = 'Clase 1'): Promise<number> {
  const r = await docente.post(`/api/campuses/${campus}/classes`, { title: titulo, starts_at: ahoraUtc(), duration_min: 90 });
  if (r.estado !== 201) throw new Error(`No se pudo crear la clase: ${r.texto}`);
  return r.json.id;
}

export async function subirPdf(docente: Cliente, campus: number, paginas: number): Promise<{ id: number; page_count: number }> {
  const r = await docente.subir(`/api/campuses/${campus}/presentations`, {
    title: 'Clase 1',
    file: { name: 'clase.pdf', mimeType: 'application/pdf', buffer: pdf(paginas) },
  });
  if (r.estado !== 201) throw new Error(`No se pudo subir el PDF: ${r.texto}`);
  return r.json;
}
