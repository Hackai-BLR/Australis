import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { identidadCampus, obtenerIdentidad, requiereRol } from '@campusia/sdk/hono';
import type { Base } from './base.ts';
import { crearClase, listarClases, validarNuevaClase } from './clases.ts';
import { servirWeb } from './estaticos.ts';
import { rutasEntregas, type FuenteDatos } from './entregas.ts';
import { datosCursoConCache, docentes, type FuentePlataforma } from './portada.ts';

export const LIMITE_CUERPO = 100 * 1024;

export interface OpcionesApp {
  base: Base;
  clavePublica: string;
  curso: string;
  plataforma: () => FuentePlataforma & FuenteDatos;
  carpetaWeb: string;
  ahora?: () => number;
  cacheCursoMs?: number;
}

function tipoDeContenido(valor: string | undefined): string {
  return (valor ?? '').split(';')[0]!.trim().toLowerCase();
}

export function crearApp(opciones: OpcionesApp): Hono {
  const { base } = opciones;
  const app = new Hono();
  const datosCurso = datosCursoConCache(opciones.plataforma, opciones.cacheCursoMs ?? 60000);

  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'same-origin');
  });

  app.get('/salud', (c) => c.json({ estado: 'ok' }));

  app.use(
    '*',
    identidadCampus({
      clavePublica: opciones.clavePublica,
      curso: opciones.curso,
      ...(opciones.ahora ? { ahora: opciones.ahora } : {}),
    }),
  );

  app.use('/api/*', async (c, next) => {
    await next();
    if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
  });

  app.get('/api/yo', (c) => {
    const { usuario, email, nombre, rol } = obtenerIdentidad(c);
    return c.json({ usuario, email, nombre, rol });
  });

  app.get('/api/portada', async (c) => {
    const yo = obtenerIdentidad(c);
    let curso, inscriptos;
    try {
      [curso, inscriptos] = await Promise.all([datosCurso(), opciones.plataforma().inscriptos()]);
    } catch {
      return c.json({ error: 'plataforma_no_disponible' }, 502);
    }
    return c.json({
      curso,
      profesores: docentes(inscriptos),
      clases: listarClases(base),
      yo: { nombre: yo.nombre, rol: yo.rol },
    });
  });

  app.get('/api/clases', (c) => c.json(listarClases(base)));

  app.post(
    '/api/clases',
    requiereRol('profesor'),
    async (c, next) => {
      if (tipoDeContenido(c.req.header('Content-Type')) !== 'application/json') {
        return c.json({ error: 'tipo_no_admitido' }, 415, { Connection: 'close' });
      }
      await next();
    },
    bodyLimit({ maxSize: LIMITE_CUERPO, onError: (c) => c.json({ error: 'cuerpo_demasiado_grande' }, 413, { Connection: 'close' }) }),
    async (c) => {
      let datos: unknown;
      try {
        datos = JSON.parse(await c.req.text());
      } catch {
        return c.json({ error: 'datos_invalidos' }, 400);
      }
      const nueva = validarNuevaClase(datos);
      if (!nueva) return c.json({ error: 'datos_invalidos' }, 400);
      return c.json(crearClase(base, nueva), 201);
    },
  );

  rutasEntregas(app, opciones.plataforma);

  app.all('/api/*', (c) => c.json({ error: 'no_encontrado' }, 404));

  app.get('*', servirWeb(opciones.carpetaWeb));

  app.notFound((c) => c.json({ error: 'no_encontrado' }, 404));

  app.onError((error, c) => {
    console.error(error);
    return c.json({ error: 'error_interno' }, 500);
  });

  return app;
}
