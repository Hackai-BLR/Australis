export {
  verificarIdentidad,
  ErrorIdentidad,
  ROLES,
  LARGO_MAXIMO_ENCABEZADO,
  VIGENCIA_MAXIMA,
  TOLERANCIA_FUTURO,
} from './identidad.js';
export type { Rol, Identidad, CodigoErrorIdentidad, OpcionesVerificacion } from './identidad.js';
export { ClienteCampus, ErrorApi, clienteDesdeEntorno } from './cliente.js';
export type {
  DatosCurso,
  Inscripto,
  CodigoErrorApi,
  OpcionesCliente,
  Via,
  PersonaResumen,
  PersonaConEmail,
  Archivo,
  ListaArchivos,
  ArchivoBajado,
  Entrega,
  Nota,
  NotaVigente,
  NuevoArchivo,
  NuevaEntrega,
  NuevaNota,
  FiltroRegistros,
  RolInscripcion,
  InscriptoAccion,
  ListaInscriptos,
  ResultadoInscripcion,
  RechazoSiu,
  ResultadoSiu,
  CodigoCurso,
  TipoConfirmacion,
  EstadoConfirmacion,
  Confirmacion,
} from './cliente.js';

export const ENCABEZADO_IDENTIDAD = 'X-Campus-Identidad';
