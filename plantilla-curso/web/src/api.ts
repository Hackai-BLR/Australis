import type { Entrega, Nota, Portada, Yo } from './tipos.ts';

export class ErrorPedido extends Error {
  readonly codigo: string;

  constructor(codigo: string) {
    super(codigo);
    this.codigo = codigo;
  }
}

async function pedirJson<T>(ruta: string, init: RequestInit = {}): Promise<T> {
  const respuesta = await fetch(ruta, {
    ...init,
    headers: { Accept: 'application/json', ...(init.headers ?? {}) },
    credentials: 'same-origin',
  });
  let datos: unknown = null;
  try {
    datos = await respuesta.json();
  } catch {
    datos = null;
  }
  if (!respuesta.ok) {
    const codigo = typeof datos === 'object' && datos !== null && typeof (datos as { error?: unknown }).error === 'string' ? (datos as { error: string }).error : String(respuesta.status);
    throw new ErrorPedido(codigo);
  }
  return datos as T;
}

export async function cargarPortada(senal?: AbortSignal): Promise<Portada> {
  const respuesta = await fetch('/api/portada', {
    headers: { Accept: 'application/json' },
    credentials: 'same-origin',
    signal: senal,
  });
  if (!respuesta.ok) throw new Error(String(respuesta.status));
  return (await respuesta.json()) as Portada;
}

export function cargarYo(senal?: AbortSignal): Promise<Yo> {
  return pedirJson<Yo>('/api/yo', { signal: senal });
}

export async function cargarEntregas(senal?: AbortSignal): Promise<Entrega[]> {
  return (await pedirJson<{ entregas: Entrega[] }>('/api/entregas', { signal: senal })).entregas;
}

export async function cargarNotas(senal?: AbortSignal): Promise<Nota[]> {
  return (await pedirJson<{ notas: Nota[] }>('/api/notas', { signal: senal })).notas;
}

export async function cargarHistorial(senal?: AbortSignal): Promise<Nota[]> {
  return (await pedirJson<{ notas: Nota[] }>('/api/notas/historial', { signal: senal })).notas;
}

export function enviarEntrega(datos: FormData): Promise<Entrega> {
  return pedirJson<Entrega>('/api/entregas', { method: 'POST', body: datos });
}

export function guardarNota(usuario: string, actividad: string, valor: string): Promise<Nota> {
  return pedirJson<Nota>('/api/notas', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario, actividad, valor }),
  });
}
