import type { Rol } from './tipos.ts';

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

export function fechaCorta(fecha: string | null): string {
  if (!fecha) return '';
  const partes = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fecha);
  if (!partes) return fecha;
  const mes = MESES[Number(partes[2]) - 1];
  if (!mes) return fecha;
  return `${Number(partes[3])} ${mes} ${partes[1]}`;
}

export function etiquetaRol(rol: Rol): string | null {
  if (rol === 'dueño') return 'Dueño';
  if (rol === 'profesor') return 'Profesor';
  return null;
}

export function listaNombres(nombres: string[]): string {
  if (nombres.length <= 1) return nombres.join('');
  return `${nombres.slice(0, -1).join(', ')} y ${nombres[nombres.length - 1]}`;
}

export function fechaHora(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const mes = MESES[d.getMonth()] ?? '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getDate()} ${mes} ${d.getFullYear()} ${hh}:${mm}`;
}

const MENSAJES_ERROR: Record<string, string> = {
  datos_invalidos: 'Revisá la actividad y completá el texto o el archivo',
  nombre_invalido: 'El nombre del archivo no es válido',
  tipo_no_permitido: 'Ese tipo de archivo no está permitido',
  cuota_excedida: 'El curso no tiene más espacio para archivos',
  archivo_demasiado_grande: 'El archivo es demasiado grande',
  cuerpo_demasiado_grande: 'El archivo es demasiado grande',
  no_es_alumno: 'Solo se califica a alumnos',
  prohibido: 'No tenés permiso para esto',
  demasiados_intentos: 'Demasiados intentos; probá en un rato',
};

export function mensajeError(codigo: string): string {
  return MENSAJES_ERROR[codigo] ?? 'No se pudo completar; probá de nuevo';
}
