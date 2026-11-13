import { readFileSync, statSync } from 'node:fs';
import { extname, join, posix, resolve, sep } from 'node:path';
import type { Context } from 'hono';

const TIPOS: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.webmanifest': 'application/manifest+json',
};

export function resolverArchivo(raiz: string, rutaPedida: string): string | null {
  let decodificada: string;
  try {
    decodificada = decodeURIComponent(rutaPedida);
  } catch {
    return null;
  }
  if (decodificada.includes('\0') || decodificada.includes('\\')) return null;
  const normalizada = posix.normalize('/' + decodificada);
  if (normalizada.split('/').some((parte) => parte.startsWith('.'))) return null;
  const base = resolve(raiz);
  const destino = resolve(join(base, normalizada));
  if (!destino.startsWith(base + sep)) return null;
  try {
    return statSync(destino).isFile() ? destino : null;
  } catch {
    return null;
  }
}

const POLITICA = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

function responderArchivo(c: Context, archivo: string, cache: string): Response {
  const tipo = TIPOS[extname(archivo).toLowerCase()] ?? 'application/octet-stream';
  const encabezados: Record<string, string> = { 'Content-Type': tipo, 'Cache-Control': cache };
  if (tipo.startsWith('text/html')) encabezados['Content-Security-Policy'] = POLITICA;
  return c.body(readFileSync(archivo), 200, encabezados);
}

export function servirWeb(raiz: string) {
  return (c: Context): Response => {
    const ruta = new URL(c.req.url).pathname;
    const archivo = ruta === '/' ? null : resolverArchivo(raiz, ruta);
    if (archivo && !archivo.endsWith(`${sep}index.html`)) {
      const inmutable = archivo.startsWith(resolve(raiz, 'assets') + sep);
      return responderArchivo(c, archivo, inmutable ? 'private, max-age=31536000, immutable' : 'private, no-cache');
    }
    const indice = resolverArchivo(raiz, '/index.html');
    if (!indice) return c.text('La interfaz del curso no está compilada', 503);
    return responderArchivo(c, indice, 'private, no-cache');
  };
}
