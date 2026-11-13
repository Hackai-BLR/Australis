import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { ClienteCampus } from '@campusia/sdk';
import { crearApp } from './app.ts';
import { abrirBase } from './base.ts';
import { leerConfiguracion, type Configuracion } from './configuracion.ts';

let configuracion: Configuracion;
try {
  configuracion = leerConfiguracion();
} catch (error) {
  console.error(`No se puede arrancar el curso: ${(error as Error).message}`);
  process.exit(1);
}

const base = abrirBase(configuracion.datos);

const fetchConLimite: typeof fetch = (entrada, init) =>
  fetch(entrada, { ...init, signal: init?.signal ?? AbortSignal.timeout(10000) });

let cliente: ClienteCampus | null = null;
const plataforma = (): ClienteCampus => {
  cliente ??= new ClienteCampus({
    api: process.env.CAMPUSIA_API ?? '',
    token: process.env.CAMPUSIA_TOKEN_CURSO ?? '',
    fetch: fetchConLimite,
  });
  return cliente;
};

const app = crearApp({
  base,
  clavePublica: configuracion.clavePublica,
  curso: configuracion.curso,
  plataforma,
  carpetaWeb: fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../dist/web' : '../web', import.meta.url)),
});

const servidor = serve({ fetch: app.fetch, port: configuracion.puerto, hostname: '0.0.0.0' }, (info) => {
  console.log(`Curso ${configuracion.curso} escuchando en el puerto ${info.port}`);
});

function terminar() {
  servidor.close(() => {
    base.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', terminar);
process.on('SIGINT', terminar);
