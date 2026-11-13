import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { ErrorApi, type ClienteCampus } from '@campusia/sdk';
import { encabezadoIdentidad, requiereRol } from '@campusia/sdk/hono';

export type FuenteDatos = Pick<
  ClienteCampus,
  'subirArchivo' | 'bajarArchivo' | 'entregar' | 'entregas' | 'ponerNota' | 'notas' | 'historialNotas'
>;

export const ARCHIVOS_MAX_BYTES = 25 * 1024 * 1024;
export const LIMITE_FORMULARIO = ARCHIVOS_MAX_BYTES + 256 * 1024;
export const LIMITE_NOTA = 16 * 1024;

const ACTIVIDAD = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const LARGO_TEXTO = 20000;

const TIPOS: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  csv: 'text/plain; charset=utf-8',
  py: 'text/plain; charset=utf-8',
  c: 'text/plain; charset=utf-8',
  cpp: 'text/plain; charset=utf-8',
  h: 'text/plain; charset=utf-8',
  java: 'text/plain; charset=utf-8',
  ts: 'text/plain; charset=utf-8',
  sql: 'text/plain; charset=utf-8',
  ipynb: 'text/plain; charset=utf-8',
  json: 'application/json',
  zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
};

const SIN_CODIFICAR = /[A-Za-z0-9!#$&+\-.^_`|~]/;

export function tipoPorNombre(nombre: string): string {
  const punto = nombre.lastIndexOf('.');
  if (punto <= 0) return 'application/octet-stream';
  return TIPOS[nombre.slice(punto + 1).toLowerCase()] ?? 'application/octet-stream';
}

export function disposicion(nombre: string): string {
  let codificado = '';
  for (const byte of new TextEncoder().encode(nombre)) {
    const caracter = String.fromCharCode(byte);
    codificado += byte < 0x80 && SIN_CODIFICAR.test(caracter) ? caracter : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  const ascii = nombre.replace(/[^\x20-\x7e]|["\\;]/gu, '_') || 'archivo';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${codificado || 'archivo'}`;
}

function tipoDeContenido(valor: string | undefined): string {
  return (valor ?? '').split(';')[0]!.trim().toLowerCase();
}

function errorDePlataforma(c: Context, error: unknown): Response {
  if (error instanceof ErrorApi && error.estado !== undefined && error.estado >= 400 && error.estado <= 499) {
    return c.json({ error: error.codigo }, error.estado as 400);
  }
  if (error instanceof ErrorApi || error instanceof TypeError) {
    return c.json({ error: 'plataforma_no_disponible' }, 502);
  }
  throw error;
}

function texto(valor: unknown): string | null {
  return typeof valor === 'string' ? valor : null;
}

export function rutasEntregas(app: Hono, plataforma: () => FuenteDatos): void {
  app.get('/api/entregas', async (c) => {
    try {
      return c.json({ entregas: await plataforma().entregas(encabezadoIdentidad(c)) });
    } catch (error) {
      return errorDePlataforma(c, error);
    }
  });

  app.post(
    '/api/entregas',
    async (c, next) => {
      if (tipoDeContenido(c.req.header('Content-Type')) !== 'multipart/form-data') {
        return c.json({ error: 'tipo_no_admitido' }, 415, { Connection: 'close' });
      }
      await next();
    },
    bodyLimit({ maxSize: LIMITE_FORMULARIO, onError: (c) => c.json({ error: 'cuerpo_demasiado_grande' }, 413, { Connection: 'close' }) }),
    async (c) => {
      const identidad = encabezadoIdentidad(c);
      let formulario: FormData;
      try {
        formulario = await c.req.formData();
      } catch {
        return c.json({ error: 'datos_invalidos' }, 400);
      }
      const actividad = (texto(formulario.get('actividad')) ?? '').trim();
      const crudo = formulario.get('texto');
      if (crudo !== null && typeof crudo !== 'string') return c.json({ error: 'datos_invalidos' }, 400);
      const contenido = crudo !== null && crudo.trim() !== '' ? crudo : undefined;
      const adjunto = formulario.get('archivo');
      if (adjunto !== null && typeof adjunto === 'string' && adjunto !== '') return c.json({ error: 'datos_invalidos' }, 400);
      const archivo = adjunto instanceof File && (adjunto.size > 0 || adjunto.name !== '') ? adjunto : null;
      if (!ACTIVIDAD.test(actividad)) return c.json({ error: 'datos_invalidos' }, 400);
      if (contenido !== undefined && Array.from(contenido).length > LARGO_TEXTO) return c.json({ error: 'datos_invalidos' }, 400);
      if (contenido === undefined && !archivo) return c.json({ error: 'datos_invalidos' }, 400);
      if (archivo && archivo.size > ARCHIVOS_MAX_BYTES) return c.json({ error: 'archivo_demasiado_grande' }, 413);
      try {
        let archivoId: string | undefined;
        if (archivo) {
          const subido = await plataforma().subirArchivo(identidad, {
            nombre: archivo.name,
            contenido: new Uint8Array(await archivo.arrayBuffer()),
          });
          archivoId = subido.id;
        }
        const entrega = await plataforma().entregar(identidad, {
          actividad,
          ...(contenido === undefined ? {} : { texto: contenido }),
          ...(archivoId === undefined ? {} : { archivoId }),
        });
        return c.json(entrega, 201);
      } catch (error) {
        return errorDePlataforma(c, error);
      }
    },
  );

  app.get('/api/archivos/:id', async (c) => {
    let bajado;
    try {
      bajado = await plataforma().bajarArchivo(encabezadoIdentidad(c), c.req.param('id'));
    } catch (error) {
      return errorDePlataforma(c, error);
    }
    const nombre = bajado.nombre || 'archivo';
    return c.body(bajado.contenido as Uint8Array<ArrayBuffer>, 200, {
      'Content-Type': tipoPorNombre(nombre),
      'Content-Disposition': disposicion(nombre),
      'Content-Length': String(bajado.contenido.byteLength),
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cache-Control': 'private, no-store',
    });
  });

  app.get('/api/notas', async (c) => {
    try {
      return c.json({ notas: await plataforma().notas(encabezadoIdentidad(c)) });
    } catch (error) {
      return errorDePlataforma(c, error);
    }
  });

  app.get('/api/notas/historial', requiereRol('profesor'), async (c) => {
    try {
      return c.json({ notas: await plataforma().historialNotas(encabezadoIdentidad(c)) });
    } catch (error) {
      return errorDePlataforma(c, error);
    }
  });

  app.post(
    '/api/notas',
    requiereRol('profesor'),
    async (c, next) => {
      if (tipoDeContenido(c.req.header('Content-Type')) !== 'application/json') {
        return c.json({ error: 'tipo_no_admitido' }, 415, { Connection: 'close' });
      }
      await next();
    },
    bodyLimit({ maxSize: LIMITE_NOTA, onError: (c) => c.json({ error: 'cuerpo_demasiado_grande' }, 413, { Connection: 'close' }) }),
    async (c) => {
      let datos: unknown;
      try {
        datos = JSON.parse(await c.req.text());
      } catch {
        return c.json({ error: 'datos_invalidos' }, 400);
      }
      if (typeof datos !== 'object' || datos === null || Array.isArray(datos)) return c.json({ error: 'datos_invalidos' }, 400);
      const { usuario, actividad, valor, comentario } = datos as Record<string, unknown>;
      if (
        (typeof usuario !== 'string' && typeof usuario !== 'number') ||
        typeof actividad !== 'string' ||
        typeof valor !== 'string' ||
        (comentario !== undefined && comentario !== null && typeof comentario !== 'string')
      ) {
        return c.json({ error: 'datos_invalidos' }, 400);
      }
      try {
        const nota = await plataforma().ponerNota(encabezadoIdentidad(c), {
          usuario,
          actividad,
          valor,
          ...(comentario === undefined ? {} : { comentario }),
        });
        return c.json(nota, 201);
      } catch (error) {
        return errorDePlataforma(c, error);
      }
    },
  );
}
