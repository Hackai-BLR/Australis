import { ROLES, type Rol } from './identidad.js';

export interface DatosCurso {
  id: string;
  nombre: string;
  periodo: string;
}

export interface Inscripto {
  id: string;
  nombre: string;
  email: string;
  rol: Rol;
}

export type CodigoErrorApi =
  | 'configuracion'
  | 'no_autorizado'
  | 'prohibido'
  | 'no_encontrado'
  | 'servidor'
  | 'red'
  | 'respuesta_invalida'
  | 'datos_invalidos'
  | 'nombre_invalido'
  | 'tipo_no_permitido'
  | 'no_es_alumno'
  | 'cuota_excedida'
  | 'archivo_demasiado_grande'
  | 'identidad_invalida'
  | 'demasiados_intentos'
  | 'email_invalido'
  | 'dominio_no_habilitado'
  | 'no_es_profesor'
  | 'es_dueno'
  | 'archivo_invalido';

export type Via = 'plataforma' | 'curso';

export interface PersonaResumen {
  id: string;
  nombre: string;
}

export interface PersonaConEmail extends PersonaResumen {
  email: string;
}

export interface Archivo {
  id: string;
  nombre: string;
  tipo: string;
  tamano: number;
  sha256: string;
  material: boolean;
  usuario: PersonaResumen;
  fecha: string;
}

export interface ListaArchivos {
  archivos: Archivo[];
  usado: number;
  cuota: number;
}

export interface ArchivoBajado {
  nombre: string;
  tipo: string;
  contenido: Uint8Array;
}

export interface Entrega {
  id: number;
  actividad: string;
  texto: string | null;
  archivo: Archivo | null;
  usuario: PersonaConEmail;
  fecha: string;
  via: Via;
}

export interface NotaVigente {
  id: number;
  actividad: string;
  valor: string;
  comentario: string | null;
  usuario: PersonaConEmail;
  autor: PersonaResumen;
  fecha: string;
  via: Via;
}

export interface Nota extends NotaVigente {
  anterior: string | null;
}

export interface NuevoArchivo {
  nombre: string;
  contenido: Uint8Array | ArrayBuffer | Blob;
  material?: boolean;
}

export interface NuevaEntrega {
  actividad: string;
  texto?: string;
  archivoId?: string;
}

export interface NuevaNota {
  usuario: string | number;
  actividad: string;
  valor: string;
  comentario?: string | null;
}

export interface FiltroRegistros {
  actividad?: string;
  usuario?: string | number;
}

export type RolInscripcion = 'alumno' | 'profesor';

export interface InscriptoAccion {
  id: string;
  nombre: string;
  email: string;
  rol: Rol;
  pendiente: boolean;
  suspendida: boolean;
}

export interface ListaInscriptos {
  inscriptos: InscriptoAccion[];
  alumnos: number;
  profesores: number;
}

export interface ResultadoInscripcion {
  agregados: string[];
  ya_estaban: string[];
  creados: string[];
}

export interface RechazoSiu {
  fila: number;
  email: string;
  motivo: string;
}

export interface ResultadoSiu extends ResultadoInscripcion {
  rechazados: RechazoSiu[];
}

export interface CodigoCurso {
  codigo: string | null;
  activo: boolean;
  vence: string | null;
}

export type TipoConfirmacion = 'quitar' | 'rol';

export type EstadoConfirmacion = 'pendiente' | 'aprobada' | 'rechazada' | 'fallida';

export interface Confirmacion {
  id: number;
  tipo: TipoConfirmacion;
  persona: PersonaConEmail;
  rol: RolInscripcion | null;
  estado: EstadoConfirmacion;
  pedida_por: PersonaResumen;
  creada: string;
  resuelta: string | null;
  error: string | null;
}

const MENSAJES: Record<CodigoErrorApi, string> = {
  configuracion: 'Falta configurar la URL de la API o el token del curso',
  no_autorizado: 'La plataforma rechazó el token del curso',
  prohibido: 'El curso no tiene permiso para esta operación',
  no_encontrado: 'La plataforma no encontró el recurso pedido',
  servidor: 'La plataforma respondió con un error',
  red: 'No se pudo conectar con la plataforma',
  respuesta_invalida: 'La plataforma devolvió una respuesta inesperada',
  datos_invalidos: 'La plataforma rechazó los datos enviados',
  nombre_invalido: 'El nombre del archivo no es válido',
  tipo_no_permitido: 'El tipo de archivo no está permitido',
  no_es_alumno: 'La persona no es alumno del curso',
  cuota_excedida: 'Se superó la cuota de archivos del curso',
  archivo_demasiado_grande: 'El archivo supera el tamaño máximo',
  identidad_invalida: 'La plataforma rechazó la identidad de la persona',
  demasiados_intentos: 'Demasiados pedidos a la plataforma; probá en un rato',
  email_invalido: 'Hay mails que no son válidos',
  dominio_no_habilitado: 'Hay mails que no son de un dominio de la universidad del curso',
  no_es_profesor: 'La persona no tiene la marca de profesor',
  es_dueno: 'Esa acción no se puede hacer sobre el dueño del curso',
  archivo_invalido: 'El archivo no es un listado válido',
};

const CODIGOS_DE_PLATAFORMA: ReadonlySet<string> = new Set<CodigoErrorApi>([
  'datos_invalidos',
  'nombre_invalido',
  'tipo_no_permitido',
  'no_es_alumno',
  'cuota_excedida',
  'archivo_demasiado_grande',
  'identidad_invalida',
  'demasiados_intentos',
  'email_invalido',
  'dominio_no_habilitado',
  'no_es_profesor',
  'es_dueno',
  'archivo_invalido',
]);

export class ErrorApi extends Error {
  readonly codigo: CodigoErrorApi;
  readonly estado?: number;
  readonly emails?: string[];

  constructor(codigo: CodigoErrorApi, estado?: number, mensaje?: string, emails?: string[]) {
    super(mensaje ?? (estado === undefined ? MENSAJES[codigo] : `${MENSAJES[codigo]} (${estado})`));
    this.name = 'ErrorApi';
    this.codigo = codigo;
    if (estado !== undefined) this.estado = estado;
    if (emails !== undefined) this.emails = emails;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface OpcionesCliente {
  api: string;
  token: string;
  fetch?: typeof fetch;
}

const TIEMPO_MAXIMO_MS = 10000;
const TOKEN_VALIDO = /^[\x21-\x7e]+$/;

function normalizarBase(api: unknown): string {
  if (typeof api !== 'string' || api.trim() === '') throw new ErrorApi('configuracion');
  let url: URL;
  try {
    url = new URL(api.trim());
  } catch {
    throw new ErrorApi('configuracion');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ErrorApi('configuracion');
  if (url.username || url.password || url.search || url.hash) throw new ErrorApi('configuracion');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function esTexto(valor: unknown): valor is string {
  return typeof valor === 'string';
}

function esObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

function aDatosCurso(valor: unknown): DatosCurso {
  if (!esObjeto(valor) || !esTexto(valor.id) || !esTexto(valor.nombre) || !esTexto(valor.periodo)) {
    throw new ErrorApi('respuesta_invalida', 200);
  }
  return { id: valor.id, nombre: valor.nombre, periodo: valor.periodo };
}

function aInscripto(valor: unknown): Inscripto {
  if (
    !esObjeto(valor) ||
    !esTexto(valor.id) ||
    !esTexto(valor.nombre) ||
    !esTexto(valor.email) ||
    !esTexto(valor.rol) ||
    !(ROLES as readonly string[]).includes(valor.rol)
  ) {
    throw new ErrorApi('respuesta_invalida', 200);
  }
  return { id: valor.id, nombre: valor.nombre, email: valor.email, rol: valor.rol as Rol };
}

function invalida(): never {
  throw new ErrorApi('respuesta_invalida', 200);
}

function esNumero(valor: unknown): valor is number {
  return typeof valor === 'number' && Number.isFinite(valor);
}

function idPersona(valor: unknown): string {
  if (esTexto(valor) && valor !== '') return valor;
  if (esNumero(valor) && Number.isSafeInteger(valor)) return String(valor);
  return invalida();
}

function textoONulo(valor: unknown): string | null {
  if (valor === null || valor === undefined) return null;
  return esTexto(valor) ? valor : invalida();
}

function aVia(valor: unknown): Via {
  return valor === 'plataforma' || valor === 'curso' ? valor : invalida();
}

function aPersonaResumen(valor: unknown): PersonaResumen {
  if (!esObjeto(valor) || !esTexto(valor.nombre)) return invalida();
  return { id: idPersona(valor.id), nombre: valor.nombre };
}

function aPersonaConEmail(valor: unknown): PersonaConEmail {
  if (!esObjeto(valor) || !esTexto(valor.nombre) || !esTexto(valor.email)) return invalida();
  return { id: idPersona(valor.id), nombre: valor.nombre, email: valor.email };
}

function aArchivo(valor: unknown): Archivo {
  if (
    !esObjeto(valor) ||
    !esTexto(valor.id) ||
    !esTexto(valor.nombre) ||
    !esTexto(valor.tipo) ||
    !esNumero(valor.tamano) ||
    !esTexto(valor.sha256) ||
    !esTexto(valor.fecha)
  ) {
    return invalida();
  }
  return {
    id: valor.id,
    nombre: valor.nombre,
    tipo: valor.tipo,
    tamano: valor.tamano,
    sha256: valor.sha256,
    material: valor.material === true || valor.material === 1,
    usuario: aPersonaResumen(valor.usuario),
    fecha: valor.fecha,
  };
}

function aEntrega(valor: unknown): Entrega {
  if (!esObjeto(valor) || !esNumero(valor.id) || !esTexto(valor.actividad) || !esTexto(valor.fecha)) return invalida();
  return {
    id: valor.id,
    actividad: valor.actividad,
    texto: textoONulo(valor.texto),
    archivo: valor.archivo === null || valor.archivo === undefined ? null : aArchivo(valor.archivo),
    usuario: aPersonaConEmail(valor.usuario),
    fecha: valor.fecha,
    via: aVia(valor.via),
  };
}

function aNotaVigente(valor: unknown): NotaVigente {
  if (
    !esObjeto(valor) ||
    !esNumero(valor.id) ||
    !esTexto(valor.actividad) ||
    !esTexto(valor.valor) ||
    !esTexto(valor.fecha)
  ) {
    return invalida();
  }
  return {
    id: valor.id,
    actividad: valor.actividad,
    valor: valor.valor,
    comentario: textoONulo(valor.comentario),
    usuario: aPersonaConEmail(valor.usuario),
    autor: aPersonaResumen(valor.autor),
    fecha: valor.fecha,
    via: aVia(valor.via),
  };
}

function aNota(valor: unknown): Nota {
  const vigente = aNotaVigente(valor);
  return { ...vigente, anterior: textoONulo((valor as Record<string, unknown>).anterior) };
}

function booleano(valor: unknown): boolean {
  if (valor === true || valor === 1) return true;
  if (valor === false || valor === 0 || valor === null || valor === undefined) return false;
  return invalida();
}

function entero(valor: unknown): number {
  return esNumero(valor) && Number.isSafeInteger(valor) ? valor : invalida();
}

function textos(valor: unknown): string[] {
  if (!Array.isArray(valor) || !valor.every(esTexto)) return invalida();
  return [...valor];
}

function aRol(valor: unknown): Rol {
  return esTexto(valor) && (ROLES as readonly string[]).includes(valor) ? (valor as Rol) : invalida();
}

function aInscriptoAccion(valor: unknown): InscriptoAccion {
  if (!esObjeto(valor) || !esTexto(valor.nombre) || !esTexto(valor.email)) return invalida();
  return {
    id: idPersona(valor.id),
    nombre: valor.nombre,
    email: valor.email,
    rol: aRol(valor.rol),
    pendiente: booleano(valor.pendiente),
    suspendida: booleano(valor.suspendida),
  };
}

function aListaInscriptos(valor: unknown): ListaInscriptos {
  if (!esObjeto(valor)) return invalida();
  return {
    inscriptos: lista(valor, 'inscriptos', aInscriptoAccion),
    alumnos: entero(valor.alumnos),
    profesores: entero(valor.profesores),
  };
}

function aResultadoInscripcion(valor: unknown): ResultadoInscripcion {
  if (!esObjeto(valor)) return invalida();
  return { agregados: textos(valor.agregados), ya_estaban: textos(valor.ya_estaban), creados: textos(valor.creados) };
}

function aRechazoSiu(valor: unknown): RechazoSiu {
  if (!esObjeto(valor) || !esTexto(valor.motivo)) return invalida();
  return { fila: entero(valor.fila), email: esTexto(valor.email) ? valor.email : '', motivo: valor.motivo };
}

function aResultadoSiu(valor: unknown): ResultadoSiu {
  return { ...aResultadoInscripcion(valor), rechazados: lista(valor, 'rechazados', aRechazoSiu) };
}

function aCodigoCurso(valor: unknown): CodigoCurso {
  if (!esObjeto(valor) || typeof valor.activo !== 'boolean') return invalida();
  return { codigo: textoONulo(valor.codigo), activo: valor.activo, vence: textoONulo(valor.vence) };
}

function idConfirmacion(valor: unknown): number {
  if (esNumero(valor) && Number.isSafeInteger(valor)) return valor;
  if (esTexto(valor) && /^[0-9]{1,15}$/.test(valor)) return Number(valor);
  return invalida();
}

function aConfirmacion(valor: unknown): Confirmacion {
  if (!esObjeto(valor) || !esTexto(valor.creada)) return invalida();
  const tipo = valor.tipo === 'quitar' || valor.tipo === 'rol' ? valor.tipo : invalida();
  const rol = valor.rol === null || valor.rol === undefined ? null : valor.rol === 'alumno' || valor.rol === 'profesor' ? valor.rol : invalida();
  const estado =
    valor.estado === 'pendiente' || valor.estado === 'aprobada' || valor.estado === 'rechazada' || valor.estado === 'fallida'
      ? valor.estado
      : invalida();
  return {
    id: idConfirmacion(valor.id),
    tipo,
    persona: aPersonaConEmail(valor.persona),
    rol,
    estado,
    pedida_por: aPersonaResumen(valor.pedida_por),
    creada: valor.creada,
    resuelta: textoONulo(valor.resuelta),
    error: textoONulo(valor.error),
  };
}

function aBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  let binario = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binario += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binario);
}

function lista<T>(valor: unknown, clave: string, convertir: (v: unknown) => T): T[] {
  if (!esObjeto(valor)) return invalida();
  const elementos = valor[clave];
  if (!Array.isArray(elementos)) return invalida();
  return elementos.map(convertir);
}

function codigoPorEstado(estado: number): CodigoErrorApi {
  if (estado === 401) return 'no_autorizado';
  if (estado === 403) return 'prohibido';
  if (estado === 404) return 'no_encontrado';
  if (estado >= 500 && estado <= 599) return 'servidor';
  return 'respuesta_invalida';
}

function valorIdentidad(identidad: unknown): string {
  const texto = typeof identidad === 'string' ? identidad : String(identidad ?? '');
  const limpio = texto.replace(/[^\x21-\x7e]/g, '_');
  return limpio === '' ? '_' : limpio;
}

function consulta(filtro: FiltroRegistros | undefined): string {
  const params = new URLSearchParams();
  if (filtro?.actividad !== undefined) params.set('actividad', String(filtro.actividad));
  if (filtro?.usuario !== undefined) params.set('usuario', String(filtro.usuario));
  const texto = params.toString();
  return texto ? `?${texto}` : '';
}

function nombreDeDisposicion(valor: string | null): string {
  if (!valor) return '';
  const extendido = /filename\*\s*=\s*([^;]+)/i.exec(valor);
  if (extendido) {
    const crudo = extendido[1]!.trim();
    const m = /^([A-Za-z0-9!#$&+.^_`|~-]+)'[^']*'(.*)$/.exec(crudo);
    const codificado = m ? m[2]! : crudo;
    try {
      return decodeURIComponent(codificado);
    } catch {
      return codificado;
    }
  }
  const simple = /filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]+))/i.exec(valor);
  if (simple) return (simple[1] ?? simple[2] ?? '').replace(/\\(.)/g, '$1').trim();
  return '';
}

async function aBytes(contenido: unknown): Promise<Uint8Array> {
  if (contenido instanceof Uint8Array) return contenido;
  if (contenido instanceof ArrayBuffer) return new Uint8Array(contenido);
  if (ArrayBuffer.isView(contenido)) return new Uint8Array(contenido.buffer, contenido.byteOffset, contenido.byteLength);
  if (typeof Blob !== 'undefined' && contenido instanceof Blob) return new Uint8Array(await contenido.arrayBuffer());
  throw new TypeError('contenido tiene que ser Uint8Array, ArrayBuffer o Blob');
}

interface Pedido {
  metodo?: 'GET' | 'POST';
  identidad?: unknown;
  cuerpo?: Uint8Array | string;
  tipo?: string;
  binario?: boolean;
}

export class ClienteCampus {
  readonly #base: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(opciones: OpcionesCliente) {
    if (typeof opciones !== 'object' || opciones === null) throw new ErrorApi('configuracion');
    const { api, token } = opciones;
    if (typeof token !== 'string' || !TOKEN_VALIDO.test(token)) throw new ErrorApi('configuracion');
    this.#base = normalizarBase(api);
    this.#token = token;
    const f = opciones.fetch ?? globalThis.fetch;
    if (typeof f !== 'function') throw new ErrorApi('configuracion');
    this.#fetch = f;
  }

  async yo(): Promise<DatosCurso> {
    return aDatosCurso(await this.#pedirJson('/api/curso/yo'));
  }

  async inscriptos(): Promise<Inscripto[]> {
    const datos = await this.#pedirJson('/api/curso/inscriptos');
    if (!Array.isArray(datos)) throw new ErrorApi('respuesta_invalida', 200);
    return datos.map(aInscripto);
  }

  async subirArchivo(identidad: string, archivo: NuevoArchivo): Promise<Archivo> {
    if (!esObjeto(archivo) || typeof archivo.nombre !== 'string') throw new TypeError('falta el nombre del archivo');
    const contenido = await aBytes(archivo.contenido);
    const params = new URLSearchParams({ nombre: archivo.nombre });
    if (archivo.material === true) params.set('material', '1');
    const datos = await this.#pedirJson(`/api/curso/archivos?${params.toString()}`, {
      metodo: 'POST',
      identidad,
      cuerpo: contenido,
      tipo: 'application/octet-stream',
    });
    return aArchivo(datos);
  }

  async archivos(identidad: string): Promise<ListaArchivos> {
    const datos = await this.#pedirJson('/api/curso/archivos', { identidad });
    if (!esObjeto(datos) || !esNumero(datos.usado) || !esNumero(datos.cuota)) return invalida();
    return { archivos: lista(datos, 'archivos', aArchivo), usado: datos.usado, cuota: datos.cuota };
  }

  async bajarArchivo(identidad: string, id: string): Promise<ArchivoBajado> {
    const respuesta = await this.#pedir(`/api/curso/archivos/${encodeURIComponent(String(id))}`, { identidad, binario: true });
    let contenido: Uint8Array;
    try {
      contenido = new Uint8Array(await respuesta.arrayBuffer());
    } catch {
      throw new ErrorApi('red', respuesta.status);
    }
    return {
      nombre: nombreDeDisposicion(respuesta.headers.get('content-disposition')),
      tipo: respuesta.headers.get('content-type') ?? 'application/octet-stream',
      contenido,
    };
  }

  async entregar(identidad: string, entrega: NuevaEntrega): Promise<Entrega> {
    if (!esObjeto(entrega)) throw new TypeError('falta la entrega');
    const cuerpo: Record<string, unknown> = { actividad: entrega.actividad };
    if (entrega.texto !== undefined) cuerpo.texto = entrega.texto;
    if (entrega.archivoId !== undefined) cuerpo.archivo_id = entrega.archivoId;
    return aEntrega(await this.#pedirJson('/api/curso/entregas', { metodo: 'POST', identidad, ...json(cuerpo) }));
  }

  async entregas(identidad: string, filtro?: FiltroRegistros): Promise<Entrega[]> {
    return lista(await this.#pedirJson(`/api/curso/entregas${consulta(filtro)}`, { identidad }), 'entregas', aEntrega);
  }

  async ponerNota(identidad: string, nota: NuevaNota): Promise<Nota> {
    if (!esObjeto(nota)) throw new TypeError('falta la nota');
    const cuerpo: Record<string, unknown> = { usuario_id: nota.usuario, actividad: nota.actividad, valor: nota.valor };
    if (nota.comentario !== undefined) cuerpo.comentario = nota.comentario;
    return aNota(await this.#pedirJson('/api/curso/notas', { metodo: 'POST', identidad, ...json(cuerpo) }));
  }

  async notas(identidad: string, filtro?: FiltroRegistros): Promise<NotaVigente[]> {
    return lista(await this.#pedirJson(`/api/curso/notas${consulta(filtro)}`, { identidad }), 'notas', aNotaVigente);
  }

  async historialNotas(identidad: string, filtro?: FiltroRegistros): Promise<Nota[]> {
    return lista(await this.#pedirJson(`/api/curso/notas/historial${consulta(filtro)}`, { identidad }), 'notas', aNota);
  }

  async listarInscriptos(): Promise<ListaInscriptos> {
    return aListaInscriptos(await this.#pedirJson('/api/curso/acciones/inscriptos'));
  }

  async inscribir(emails: readonly string[], rol: RolInscripcion = 'alumno'): Promise<ResultadoInscripcion> {
    if (!Array.isArray(emails)) throw new TypeError('emails tiene que ser un arreglo de mails');
    const datos = await this.#pedirJson('/api/curso/acciones/inscriptos', { metodo: 'POST', ...json({ emails: [...emails], rol }) });
    return aResultadoInscripcion(datos);
  }

  async importarSiu(archivo: string, contenido: Uint8Array | ArrayBuffer | Blob): Promise<ResultadoSiu> {
    if (typeof archivo !== 'string') throw new TypeError('falta el nombre del archivo');
    const bytes = await aBytes(contenido);
    const datos = await this.#pedirJson('/api/curso/acciones/inscriptos/siu', {
      metodo: 'POST',
      ...json({ archivo, contenido: aBase64(bytes) }),
    });
    return aResultadoSiu(datos);
  }

  async codigoInscripcion(): Promise<CodigoCurso> {
    return aCodigoCurso(await this.#pedirJson('/api/curso/acciones/codigo'));
  }

  async generarCodigo(dias?: number): Promise<CodigoCurso> {
    const cuerpo = dias === undefined ? {} : { dias };
    return aCodigoCurso(await this.#pedirJson('/api/curso/acciones/codigo', { metodo: 'POST', ...json(cuerpo) }));
  }

  async activarCodigo(activo: boolean): Promise<CodigoCurso> {
    if (typeof activo !== 'boolean') throw new TypeError('activo tiene que ser true o false');
    return aCodigoCurso(await this.#pedirJson('/api/curso/acciones/codigo/activo', { metodo: 'POST', ...json({ activo }) }));
  }

  async pedirQuitar(usuarioId: string | number): Promise<Confirmacion> {
    const datos = await this.#pedirJson('/api/curso/acciones/quitar', { metodo: 'POST', ...json({ usuario_id: String(usuarioId) }) });
    return aConfirmacion(datos);
  }

  async pedirCambioDeRol(usuarioId: string | number, rol: RolInscripcion): Promise<Confirmacion> {
    const datos = await this.#pedirJson('/api/curso/acciones/rol', {
      metodo: 'POST',
      ...json({ usuario_id: String(usuarioId), rol }),
    });
    return aConfirmacion(datos);
  }

  async confirmaciones(): Promise<Confirmacion[]> {
    return lista(await this.#pedirJson('/api/curso/acciones/confirmaciones'), 'confirmaciones', aConfirmacion);
  }

  async #pedirJson(ruta: string, pedido: Pedido = {}): Promise<unknown> {
    const respuesta = await this.#pedir(ruta, pedido);
    let texto: string;
    try {
      texto = await respuesta.text();
    } catch {
      throw new ErrorApi('red', respuesta.status);
    }
    try {
      return JSON.parse(texto) as unknown;
    } catch {
      throw new ErrorApi('respuesta_invalida', respuesta.status);
    }
  }

  async #pedir(ruta: string, pedido: Pedido): Promise<Response> {
    const encabezados: Record<string, string> = {
      Authorization: `Bearer ${this.#token}`,
      Accept: pedido.binario ? '*/*' : 'application/json',
    };
    if ('identidad' in pedido) encabezados['X-Campus-Identidad'] = valorIdentidad(pedido.identidad);
    if (pedido.tipo) encabezados['Content-Type'] = pedido.tipo;
    let respuesta: Response;
    try {
      respuesta = await this.#fetch(`${this.#base}${ruta}`, {
        method: pedido.metodo ?? 'GET',
        headers: encabezados,
        ...(pedido.cuerpo === undefined ? {} : { body: pedido.cuerpo }),
        redirect: 'manual',
        credentials: 'omit',
        signal: AbortSignal.timeout(TIEMPO_MAXIMO_MS),
      });
    } catch {
      throw new ErrorApi('red');
    }
    const estado = respuesta.status;
    if (respuesta.type === 'opaqueredirect' || estado < 200 || estado > 299) {
      if (respuesta.type === 'opaqueredirect' || estado === 0) {
        await respuesta.body?.cancel().catch(() => undefined);
        throw new ErrorApi('respuesta_invalida');
      }
      const error = await errorDeCuerpo(respuesta);
      throw new ErrorApi(error.codigo ?? codigoPorEstado(estado), estado, undefined, error.emails);
    }
    return respuesta;
  }
}

function json(cuerpo: Record<string, unknown>): { cuerpo: string; tipo: string } {
  return { cuerpo: JSON.stringify(cuerpo), tipo: 'application/json' };
}

async function errorDeCuerpo(respuesta: Response): Promise<{ codigo: CodigoErrorApi | null; emails?: string[] }> {
  try {
    const datos = JSON.parse(await respuesta.text()) as unknown;
    if (!esObjeto(datos)) return { codigo: null };
    const codigo = esTexto(datos.error) && CODIGOS_DE_PLATAFORMA.has(datos.error) ? (datos.error as CodigoErrorApi) : null;
    const emails = Array.isArray(datos.emails) ? datos.emails.filter(esTexto) : undefined;
    return emails === undefined ? { codigo } : { codigo, emails };
  } catch {
    return { codigo: null };
  }
}

export function clienteDesdeEntorno(env?: Record<string, string | undefined>): ClienteCampus {
  const fuente = env ?? (typeof process === 'undefined' ? {} : process.env);
  const agente = fuente.CAMPUSIA_TOKEN_AGENTE;
  const token = typeof agente === 'string' && agente !== '' ? agente : fuente.CAMPUSIA_TOKEN_CURSO;
  return new ClienteCampus({ api: fuente.CAMPUSIA_API ?? '', token: token ?? '' });
}
