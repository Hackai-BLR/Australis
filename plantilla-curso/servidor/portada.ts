import type { DatosCurso, Inscripto } from '@campusia/sdk';

export interface FuentePlataforma {
  yo(): Promise<DatosCurso>;
  inscriptos(): Promise<Inscripto[]>;
}

export interface Docente {
  nombre: string;
  rol: 'dueño' | 'profesor';
}

export function docentes(inscriptos: Inscripto[]): Docente[] {
  const lista: Docente[] = [];
  for (const i of inscriptos) {
    if (i.rol === 'dueño' || i.rol === 'profesor') lista.push({ nombre: i.nombre, rol: i.rol });
  }
  return lista;
}

export function datosCursoConCache(obtener: () => FuentePlataforma, duracionMs = 60000, ahora: () => number = Date.now) {
  let guardado: { valor: DatosCurso; hasta: number } | null = null;
  return async (): Promise<DatosCurso> => {
    const t = ahora();
    if (guardado && t < guardado.hasta) return guardado.valor;
    const datos = await obtener().yo();
    const valor = { id: datos.id, nombre: datos.nombre, periodo: datos.periodo };
    guardado = { valor, hasta: t + duracionMs };
    return valor;
  };
}
