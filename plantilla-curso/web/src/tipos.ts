export type Rol = 'dueño' | 'profesor' | 'alumno';

export interface Clase {
  id: number;
  numero: number;
  titulo: string;
  fecha: string | null;
  contenido: string;
}

export interface Portada {
  curso: { id: string; nombre: string; periodo: string };
  profesores: { nombre: string; rol: Rol }[];
  clases: Clase[];
  yo: { nombre: string; rol: Rol };
}

export interface Persona {
  id: string;
  nombre: string;
  email?: string;
}

export interface Archivo {
  id: string;
  nombre: string;
}

export interface Entrega {
  id: number;
  actividad: string;
  texto: string | null;
  archivo: Archivo | null;
  usuario: Persona;
  fecha: string;
}

export interface Nota {
  id: number;
  actividad: string;
  valor: string;
  anterior?: string | null;
  usuario: Persona;
  autor: Persona;
  fecha: string;
}

export interface Yo {
  usuario: string;
  nombre: string;
  rol: Rol;
}
