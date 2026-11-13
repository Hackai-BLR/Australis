import type { Base } from './base.ts';

export interface Clase {
  id: number;
  numero: number;
  titulo: string;
  fecha: string | null;
  contenido: string;
}

export interface NuevaClase {
  titulo: string;
  fecha: string | null;
  contenido: string;
  numero: number | null;
}

const LARGO_TITULO = 200;
const LARGO_CONTENIDO = 20000;

function largo(texto: string): number {
  return Array.from(texto).length;
}

export function fechaValida(valor: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(valor);
  if (!m) return false;
  const [anio, mes, dia] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(anio, mes - 1, dia));
  return d.getUTCFullYear() === anio && d.getUTCMonth() === mes - 1 && d.getUTCDate() === dia;
}

export function validarNuevaClase(datos: unknown): NuevaClase | null {
  if (typeof datos !== 'object' || datos === null || Array.isArray(datos)) return null;
  const { titulo, fecha, contenido, numero } = datos as Record<string, unknown>;
  if (typeof titulo !== 'string') return null;
  const recortado = titulo.trim();
  if (largo(recortado) < 1 || largo(recortado) > LARGO_TITULO) return null;
  if (fecha !== undefined && fecha !== null && (typeof fecha !== 'string' || !fechaValida(fecha))) return null;
  if (contenido !== undefined && (typeof contenido !== 'string' || largo(contenido) > LARGO_CONTENIDO)) return null;
  if (numero !== undefined && (typeof numero !== 'number' || !Number.isSafeInteger(numero) || numero < 0)) return null;
  return {
    titulo: recortado,
    fecha: typeof fecha === 'string' ? fecha : null,
    contenido: typeof contenido === 'string' ? contenido : '',
    numero: typeof numero === 'number' ? numero : null,
  };
}

export function listarClases(base: Base): Clase[] {
  return base
    .prepare('SELECT id, numero, titulo, fecha, contenido FROM clases ORDER BY numero, id')
    .all() as Clase[];
}

export function crearClase(base: Base, nueva: NuevaClase, ahora: Date = new Date()): Clase {
  const crear = base.transaction((): Clase => {
    const numero =
      nueva.numero ??
      (base.prepare('SELECT COALESCE(MAX(numero), 0) + 1 AS siguiente FROM clases').get() as { siguiente: number })
        .siguiente;
    const resultado = base
      .prepare('INSERT INTO clases (numero, titulo, fecha, contenido, creada) VALUES (?, ?, ?, ?, ?)')
      .run(numero, nueva.titulo, nueva.fecha, nueva.contenido, ahora.toISOString());
    return {
      id: Number(resultado.lastInsertRowid),
      numero,
      titulo: nueva.titulo,
      fecha: nueva.fecha,
      contenido: nueva.contenido,
    };
  });
  return crear.immediate();
}
