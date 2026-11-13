import { ErrorApi, get, post } from './api';

export type EstadoEspacio = 'ninguno' | 'apagado' | 'encendiendo' | 'encendido' | 'error';

export interface ArchivoCambiado {
  ruta: string;
  cambio: 'agregado' | 'modificado' | 'borrado';
}

export interface Mensaje {
  id: number;
  rol: 'profesor' | 'agente';
  texto: string;
  autor: { id: number; nombre: string; email: string } | null;
  archivos: ArchivoCambiado[];
  estado: 'en_curso' | 'ok' | 'error';
  fecha: string;
}

export interface Version {
  numero: number;
  fecha: string;
  descripcion: string;
  autor: { id: number; nombre: string } | null;
  commit: string;
  origen: number | null;
}

export interface ListaVersiones {
  publicada: number | null;
  cambios_sin_publicar: boolean;
  versiones: Version[];
}

export interface Publicacion {
  id: number;
  tipo: 'publicar' | 'volver';
  estado: 'en_curso' | 'ok' | 'error';
  etapa: string;
  version: number | null;
  desde_version: number | null;
  descripcion: string;
  error: string | null;
  registro: string;
  autor: { id: number; nombre: string } | null;
  creada: string;
  terminada: string | null;
}

const ruta = (id: string, resto = '') => `/api/cursos/${encodeURIComponent(id)}${resto}`;

export const leerEspacio = (id: string) => get<{ espacio: EstadoEspacio; error: string | null }>(ruta(id, '/espacio'));
export const encenderEspacio = (id: string) => post<{ espacio: EstadoEspacio; error: string | null }>(ruta(id, '/espacio'));
export const leerConversacion = (id: string) => get<{ mensajes: Mensaje[]; en_curso: boolean }>(ruta(id, '/agente'));
export const leerVersiones = (id: string) => get<ListaVersiones>(ruta(id, '/versiones'));
export const leerPublicaciones = (id: string) => get<{ publicaciones: Publicacion[] }>(ruta(id, '/publicaciones'));
export const leerPublicacion = (id: string, pid: number) => get<Publicacion>(ruta(id, `/publicaciones/${pid}`));
export const publicar = (id: string) => post<Publicacion>(ruta(id, '/publicar'));
export const volverA = (id: string, n: number) => post<Publicacion>(ruta(id, `/versiones/${n}/volver`));

export const esperar = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

export async function seguirPublicacion(id: string, p: Publicacion, vigente: () => boolean): Promise<Publicacion> {
  let actual = p;
  let fallos = 0;
  while (actual.estado === 'en_curso' && vigente()) {
    await esperar(2000);
    try {
      actual = await leerPublicacion(id, p.id);
      fallos = 0;
    } catch (e) {
      fallos++;
      if (e instanceof ErrorApi && (e.status === 404 || e.status === 403 || e.status === 401)) throw e;
      if (fallos > 30) throw e;
    }
  }
  return actual;
}

export interface EventosAgente {
  inicio: (pedido: Mensaje, respuesta: Mensaje) => void;
  texto: (texto: string) => void;
  herramienta: (nombre: string, ruta: string | null) => void;
  fin: (respuesta: Mensaje) => void;
}

export async function pedirAlAgente(id: string, pedido: string, ev: EventosAgente): Promise<boolean> {
  let r: Response;
  try {
    r = await fetch(ruta(id, '/agente'), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json', 'X-Campusia': '1' },
      body: JSON.stringify({ pedido }),
    });
  } catch {
    throw new ErrorApi(0, 'sin_conexion', 'No hay conexión. Probá de nuevo.');
  }
  const tipo = r.headers.get('content-type') ?? '';
  if (!r.ok || !tipo.includes('event-stream') || !r.body) {
    let json: any = null;
    try {
      json = await r.json();
    } catch {
      json = null;
    }
    const codigo = json?.error ?? 'error';
    let mensaje = json?.mensaje ?? 'No se pudo completar. Probá de nuevo.';
    throw new ErrorApi(r.status, codigo, mensaje, json);
  }
  const lector = r.body.pipeThrough(new TextDecoderStream()).getReader();
  let resto = '';
  let terminado = false;
  const procesar = (bloque: string) => {
    let evento = 'message';
    const datos: string[] = [];
    for (const linea of bloque.split(/\r?\n/)) {
      if (linea === '' || linea.startsWith(':')) continue;
      if (linea.startsWith('event:')) evento = linea.slice(6).trim();
      else if (linea.startsWith('data:')) datos.push(linea.slice(5).replace(/^ /, ''));
    }
    if (!datos.length) return;
    let d: any;
    try {
      d = JSON.parse(datos.join('\n'));
    } catch {
      return;
    }
    if (evento === 'inicio' && d?.pedido && d?.respuesta) ev.inicio(d.pedido, d.respuesta);
    else if (evento === 'texto' && typeof d?.texto === 'string') ev.texto(d.texto);
    else if (evento === 'herramienta' && d?.nombre) ev.herramienta(String(d.nombre), d.ruta ?? null);
    else if (evento === 'fin' && d?.respuesta) {
      terminado = true;
      ev.fin(d.respuesta);
    }
  };
  try {
    for (;;) {
      const { value, done } = await lector.read();
      if (done) break;
      resto += value;
      const partes = resto.split(/\r?\n\r?\n/);
      resto = partes.pop() ?? '';
      for (const p of partes) procesar(p);
    }
    if (resto.trim()) procesar(resto);
  } catch {
    return terminado;
  }
  return terminado;
}
