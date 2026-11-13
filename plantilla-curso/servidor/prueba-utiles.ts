import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ErrorApi,
  type Archivo,
  type ArchivoBajado,
  type DatosCurso,
  type Entrega,
  type FiltroRegistros,
  type Inscripto,
  type NotaVigente,
  type Nota,
  type NuevaEntrega,
  type NuevaNota,
  type NuevoArchivo,
} from '@campusia/sdk';
import type { FuenteDatos } from './entregas.ts';
import { crearApp } from './app.ts';
import { abrirBaseEnMemoria } from './base.ts';
import type { FuentePlataforma } from './portada.ts';

export const CURSO: DatosCurso = { id: 'redes', nombre: 'Redes de Computadoras', periodo: '2.º cuatrimestre 2026' };

export const INSCRIPTOS: Inscripto[] = [
  { id: 'u-duenio', nombre: 'Lucía Fernández', email: 'lucia.fernandez@austral.edu.ar', rol: 'dueño' },
  { id: 'u-alumno-2', nombre: 'Bruno Díaz', email: 'bruno.diaz@austral.edu.ar', rol: 'alumno' },
  { id: 'u-profe-2', nombre: 'Martín Sosa', email: 'martin.sosa@austral.edu.ar', rol: 'profesor' },
  { id: 'u-alumno-1', nombre: 'Ana Gómez', email: 'ana.gomez@austral.edu.ar', rol: 'alumno' },
];

export const PERSONAS = {
  duenio: { usuario: 'u-duenio', email: 'lucia.fernandez@austral.edu.ar', nombre: 'Lucía Fernández', rol: 'dueño' },
  profesor: { usuario: 'u-profe-2', email: 'martin.sosa@austral.edu.ar', nombre: 'Martín Sosa', rol: 'profesor' },
  alumno: { usuario: 'u-alumno-1', email: 'ana.gomez@austral.edu.ar', nombre: 'Ana Gómez', rol: 'alumno' },
} as const;

export type Persona = keyof typeof PERSONAS;

export interface ParDeClaves {
  publica: string;
  privada: KeyObject;
}

export function nuevoParDeClaves(): ParDeClaves {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  return { publica: String(jwk.x), privada: privateKey };
}

export function ahoraSeg(): number {
  return Math.floor(Date.now() / 1000);
}

export function firmar(carga: Record<string, unknown>, privada: KeyObject): string {
  const c = Buffer.from(JSON.stringify(carga), 'utf8').toString('base64url');
  const f = sign(null, Buffer.from(c, 'ascii'), privada).toString('base64url');
  return `${c}.${f}`;
}

export function identidadDe(persona: Persona, privada: KeyObject, extra: Record<string, unknown> = {}): string {
  const t = ahoraSeg();
  return firmar({ v: 1, curso: 'redes', ...PERSONAS[persona], emitido: t, vence: t + 60, ...extra }, privada);
}

export interface LlamadaDatos {
  metodo: string;
  identidad: string;
  datos?: unknown;
}

export class PlataformaFalsa implements FuentePlataforma, FuenteDatos {
  llamadasYo = 0;
  llamadasInscriptos = 0;
  caida = false;
  llamadas: LlamadaDatos[] = [];
  error: ErrorApi | null = null;
  archivosGuardados = new Map<string, { archivo: Archivo; contenido: Uint8Array }>();
  entregasGuardadas: Entrega[] = [];
  notasGuardadas: Nota[] = [];

  #registrar(metodo: string, identidad: string, datos?: unknown): void {
    this.llamadas.push({ metodo, identidad, ...(datos === undefined ? {} : { datos }) });
    if (this.caida) throw new ErrorApi('red');
    if (this.error) throw this.error;
  }

  async subirArchivo(identidad: string, nuevo: NuevoArchivo): Promise<Archivo> {
    this.#registrar('subirArchivo', identidad, { nombre: nuevo.nombre });
    const contenido = nuevo.contenido as Uint8Array;
    const id = (this.archivosGuardados.size + 1).toString(16).padStart(32, '0');
    const archivo: Archivo = {
      id,
      nombre: nuevo.nombre,
      tipo: 'text/plain; charset=utf-8',
      tamano: contenido.byteLength,
      sha256: '0'.repeat(64),
      material: false,
      usuario: { id: 'u-alumno-1', nombre: 'Ana Gómez' },
      fecha: '2026-11-10T12:00:00Z',
    };
    this.archivosGuardados.set(id, { archivo, contenido: new Uint8Array(contenido) });
    return archivo;
  }

  async bajarArchivo(identidad: string, id: string): Promise<ArchivoBajado> {
    this.#registrar('bajarArchivo', identidad, { id });
    const guardado = this.archivosGuardados.get(id);
    if (!guardado) throw new ErrorApi('no_encontrado', 404);
    return { nombre: guardado.archivo.nombre, tipo: guardado.archivo.tipo, contenido: guardado.contenido };
  }

  async entregar(identidad: string, nueva: NuevaEntrega): Promise<Entrega> {
    this.#registrar('entregar', identidad, nueva);
    const entrega: Entrega = {
      id: this.entregasGuardadas.length + 1,
      actividad: nueva.actividad,
      texto: nueva.texto ?? null,
      archivo: nueva.archivoId ? (this.archivosGuardados.get(nueva.archivoId)?.archivo ?? null) : null,
      usuario: { id: 'u-alumno-1', nombre: 'Ana Gómez', email: 'ana.gomez@austral.edu.ar' },
      fecha: '2026-11-10T12:00:01Z',
      via: 'curso',
    };
    this.entregasGuardadas.push(entrega);
    return entrega;
  }

  async entregas(identidad: string, filtro?: FiltroRegistros): Promise<Entrega[]> {
    this.#registrar('entregas', identidad, filtro);
    return [...this.entregasGuardadas];
  }

  async ponerNota(identidad: string, nueva: NuevaNota): Promise<Nota> {
    this.#registrar('ponerNota', identidad, nueva);
    const previas = this.notasGuardadas.filter((n) => n.usuario.id === String(nueva.usuario) && n.actividad === nueva.actividad);
    const nota: Nota = {
      id: this.notasGuardadas.length + 1,
      actividad: nueva.actividad,
      valor: nueva.valor,
      comentario: nueva.comentario ?? null,
      anterior: previas.at(-1)?.valor ?? null,
      usuario: { id: String(nueva.usuario), nombre: 'Ana Gómez', email: 'ana.gomez@austral.edu.ar' },
      autor: { id: 'u-profe-2', nombre: 'Martín Sosa' },
      fecha: '2026-11-10T12:00:02Z',
      via: 'curso',
    };
    this.notasGuardadas.push(nota);
    return nota;
  }

  async notas(identidad: string, filtro?: FiltroRegistros): Promise<NotaVigente[]> {
    this.#registrar('notas', identidad, filtro);
    const vigentes = new Map<string, NotaVigente>();
    for (const { anterior: _anterior, ...n } of this.notasGuardadas) vigentes.set(`${n.usuario.id}/${n.actividad}`, n);
    return [...vigentes.values()];
  }

  async historialNotas(identidad: string, filtro?: FiltroRegistros): Promise<Nota[]> {
    this.#registrar('historialNotas', identidad, filtro);
    return [...this.notasGuardadas];
  }

  async yo(): Promise<DatosCurso> {
    this.llamadasYo += 1;
    if (this.caida) throw new Error('red');
    return { ...CURSO };
  }

  async inscriptos(): Promise<Inscripto[]> {
    this.llamadasInscriptos += 1;
    if (this.caida) throw new Error('red');
    return INSCRIPTOS.map((i) => ({ ...i }));
  }
}

export function carpetaWebDePrueba(): string {
  const raiz = mkdtempSync(join(tmpdir(), 'curso-web-'));
  const web = join(raiz, 'web');
  mkdirSync(join(web, 'assets'), { recursive: true });
  writeFileSync(join(web, 'index.html'), '<!doctype html><html lang="es"><head><meta name="viewport" content="width=device-width"></head><body><div id="raiz"></div></body></html>');
  writeFileSync(join(web, 'assets', 'app.js'), 'console.log("curso")');
  writeFileSync(join(raiz, 'secreto.txt'), 'no se sirve');
  return web;
}

export function armar() {
  const par = nuevoParDeClaves();
  const base = abrirBaseEnMemoria();
  const plataforma = new PlataformaFalsa();
  const app = crearApp({
    base,
    clavePublica: par.publica,
    curso: 'redes',
    plataforma: () => plataforma,
    carpetaWeb: carpetaWebDePrueba(),
  });
  const pedir = (ruta: string, init: RequestInit & { persona?: Persona } = {}) => {
    const { persona, ...resto } = init;
    const encabezados = new Headers(resto.headers);
    if (persona && !encabezados.has('X-Campus-Identidad')) encabezados.set('X-Campus-Identidad', identidadDe(persona, par.privada));
    return app.request(ruta, { ...resto, headers: encabezados });
  };
  const crear = (persona: Persona, cuerpo: unknown) =>
    pedir('/api/clases', {
      persona,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo),
    });
  return { app, par, base, plataforma, pedir, crear };
}
