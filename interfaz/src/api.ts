export class ErrorApi extends Error {
  constructor(
    public status: number,
    public codigo: string,
    mensaje: string,
    public datos: any = null,
  ) {
    super(mensaje);
  }

  get mensaje() {
    return this.message;
  }
}

export interface Universidad {
  id: number;
  nombre: string;
}

export interface Usuario {
  id: number;
  email: string;
  nombre: string;
  universidad: Universidad | null;
  profesor: boolean;
  administrador: boolean;
  owner: boolean;
}

export interface Config {
  dominio_base: string;
  turnstile_site_key: string;
  reautenticacion?: 'sesion' | 'codigo';
}

export interface CursoPropio {
  id: string;
  nombre: string;
  periodo: string;
  color: string;
  rol: 'dueño' | 'profesor' | 'alumno';
  version_publicada: number | null;
  archivado?: boolean;
  tipo?: 'libre' | 'modulos';
  campus_externo?: number;
}

export type RolCurso = 'dueño' | 'profesor' | 'alumno';

export interface CursoDetalle extends CursoPropio {
  estado: 'sin_repo' | 'preparando' | 'listo' | 'error';
  contenedor: 'ninguno' | 'apagado' | 'encendiendo' | 'encendido';
}

export interface Inscripto {
  id: number;
  nombre: string;
  email: string;
  rol: RolCurso;
  pendiente: boolean;
  profesor?: boolean;
  suspendida?: boolean;
}

export interface ListaInscriptos {
  inscriptos: Inscripto[];
  alumnos: number;
  profesores: number;
}

export interface CodigoCurso {
  codigo: string;
  activo: boolean;
  vence: string | null;
}

interface Opciones {
  reautenticar?: boolean;
  avisarSesion?: boolean;
}

let alPerderSesion: () => void = () => {};
let reautenticador: (() => Promise<void>) | null = null;

export function alNoAutenticado(f: () => void) {
  alPerderSesion = f;
}

export function usarReautenticador(f: (() => Promise<void>) | null) {
  reautenticador = f;
}

async function crudo(metodo: string, ruta: string, cuerpo?: unknown): Promise<any> {
  const modifica = metodo !== 'GET' && metodo !== 'HEAD';
  const encabezados: Record<string, string> = { Accept: 'application/json' };
  let datos: string | undefined;
  if (modifica) {
    encabezados['X-Campusia'] = '1';
    if (metodo !== 'DELETE' || cuerpo !== undefined) {
      encabezados['Content-Type'] = 'application/json';
      datos = JSON.stringify(cuerpo ?? {});
    }
  }
  let r: Response;
  try {
    r = await fetch(ruta, { method: metodo, headers: encabezados, body: datos, credentials: 'same-origin' });
  } catch {
    throw new ErrorApi(0, 'sin_conexion', 'No hay conexión. Probá de nuevo.');
  }
  const texto = await r.text();
  let json: any = null;
  if (texto) {
    try {
      json = JSON.parse(texto);
    } catch {
      json = null;
    }
  }
  if (!r.ok) {
    throw new ErrorApi(r.status, json?.error ?? 'error', json?.mensaje ?? 'No se pudo completar. Probá de nuevo.', json);
  }
  return json;
}

export async function api<T = any>(metodo: string, ruta: string, cuerpo?: unknown, op: Opciones = {}): Promise<T> {
  try {
    return await crudo(metodo, ruta, cuerpo);
  } catch (e) {
    if (e instanceof ErrorApi) {
      if (e.codigo === 'reautenticacion_requerida' && reautenticador && op.reautenticar !== false) {
        await reautenticador();
        return await crudo(metodo, ruta, cuerpo);
      }
      if (e.status === 401 && op.avisarSesion !== false) alPerderSesion();
    }
    throw e;
  }
}

export const get = <T = any>(ruta: string) => api<T>('GET', ruta);
export const post = <T = any>(ruta: string, cuerpo?: unknown) => api<T>('POST', ruta, cuerpo ?? {});
export const put = <T = any>(ruta: string, cuerpo?: unknown) => api<T>('PUT', ruta, cuerpo ?? {});
export const borrar = <T = any>(ruta: string) => api<T>('DELETE', ruta);

export function esCancelado(e: unknown) {
  return e instanceof ErrorApi && e.codigo === 'cancelado';
}
