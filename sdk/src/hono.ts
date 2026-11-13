import type { Context, MiddlewareHandler } from 'hono';
import { ErrorIdentidad, ROLES, verificarIdentidad, type Identidad, type Rol } from './identidad.js';

declare module 'hono' {
  interface ContextVariableMap {
    identidad: Identidad;
  }
}

export interface OpcionesIdentidadCampus {
  clavePublica?: string;
  curso?: string;
  ahora?: () => number;
}

function entorno(nombre: string): string {
  if (typeof process === 'undefined') return '';
  return process.env[nombre] ?? '';
}

const crudas = new WeakMap<Context, string>();

function negar(c: Context, codigo: string): Response {
  c.header('Cache-Control', 'no-store');
  return c.json({ error: 'identidad_invalida', codigo }, 401);
}

export function identidadCampus(opciones: OpcionesIdentidadCampus = {}): MiddlewareHandler {
  return async (c, next) => {
    let identidad: Identidad;
    const encabezado = c.req.header('X-Campus-Identidad');
    try {
      const ahora = opciones.ahora ? opciones.ahora() : undefined;
      identidad = verificarIdentidad(encabezado, {
        clavePublica: opciones.clavePublica ?? entorno('CAMPUSIA_CLAVE_PUBLICA'),
        curso: opciones.curso ?? entorno('CAMPUSIA_CURSO'),
        ...(ahora === undefined ? {} : { ahora }),
      });
    } catch (error) {
      return negar(c, error instanceof ErrorIdentidad ? error.codigo : 'configuracion');
    }
    c.set('identidad', identidad);
    crudas.set(c, encabezado as string);
    await next();
  };
}

function leerIdentidad(c: Context): Identidad | undefined {
  const valor: unknown = c.get('identidad');
  if (typeof valor !== 'object' || valor === null) return undefined;
  const rol = (valor as { rol?: unknown }).rol;
  if (typeof rol !== 'string' || !(ROLES as readonly string[]).includes(rol)) return undefined;
  return valor as Identidad;
}

export function requiereRol(...roles: Rol[]): MiddlewareHandler {
  for (const rol of roles) {
    if (!(ROLES as readonly string[]).includes(rol)) throw new TypeError(`Rol desconocido: ${String(rol)}`);
  }
  const permitidos = new Set<Rol>(roles);
  if (permitidos.has('profesor')) permitidos.add('dueño');
  return async (c, next) => {
    const identidad = leerIdentidad(c);
    if (!identidad) return negar(c, 'ausente');
    if (!permitidos.has(identidad.rol)) return c.json({ error: 'prohibido' }, 403);
    await next();
  };
}

export function obtenerIdentidad(c: Context): Identidad {
  const identidad = leerIdentidad(c);
  if (!identidad) throw new ErrorIdentidad('ausente');
  return identidad;
}

export type { Identidad, Rol } from './identidad.js';

export function encabezadoIdentidad(c: Context): string {
  const crudo = crudas.get(c);
  if (!leerIdentidad(c) || typeof crudo !== 'string' || crudo === '') throw new ErrorIdentidad('ausente');
  return crudo;
}
