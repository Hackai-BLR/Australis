import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RAIZ_REPO } from '../../comun/entorno.ts';

export const PLANTILLA = path.join(RAIZ_REPO, 'plantilla-curso');
export const SDK = path.join(RAIZ_REPO, 'sdk');

export const LINEA_SALUD = "  app.get('/salud', (c) => c.json({ estado: 'ok' }));";

const ESPIA = `  const registroEspia: Array<{ metodo: string; ruta: string; encabezados: Record<string, string> }> = [];
  app.use('*', async (c, next) => {
    registroEspia.push({ metodo: c.req.method, ruta: new URL(c.req.url).pathname, encabezados: Object.fromEntries(c.req.raw.headers.entries()) });
    await next();
  });
  app.all('/espia/eco', async (c) => {
    const cuerpo = await c.req.text();
    return c.json({ metodo: c.req.method, ruta: new URL(c.req.url).pathname, consulta: new URL(c.req.url).search, encabezados: Object.fromEntries(c.req.raw.headers.entries()), cuerpo });
  });
  app.get('/espia/registro', (c) => c.json(registroEspia.splice(0, registroEspia.length)));
  app.get('/espia/cookie', (c) => {
    c.header('Set-Cookie', 'campusia_sesion=plantada; Domain=campusia.prueba; Path=/; HttpOnly', { append: true });
    c.header('Set-Cookie', 'curso_propia=1; Path=/', { append: true });
    return c.json({ ok: true });
  });
  app.get('/espia/red', async (c) => {
    const destino = c.req.query('url') ?? '';
    try {
      const r = await fetch(destino, { signal: AbortSignal.timeout(4000), redirect: 'manual' });
      const texto = await r.text();
      return c.json({ ok: true, estado: r.status, cuerpo: texto.slice(0, 4000) });
    } catch (e) {
      const causa = (e as { cause?: { code?: string } }).cause;
      return c.json({ ok: false, error: String((e as Error).message), codigo: causa?.code ?? null });
    }
  });
  app.get('/espia/tcp', async (c) => {
    const net = await import('node:net');
    const host = c.req.query('host') ?? '';
    const puerto = Number(c.req.query('puerto') ?? '0');
    const ok = await new Promise<boolean>((resolve) => {
      const s = net.connect({ host, port: puerto });
      const t = setTimeout(() => { s.destroy(); resolve(false); }, 3000);
      s.once('connect', () => { clearTimeout(t); s.destroy(); resolve(true); });
      s.once('error', () => { clearTimeout(t); resolve(false); });
    });
    return c.json({ ok });
  });
  app.get('/espia/entorno', (c) => {
    const variables: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (k.startsWith('CAMPUSIA_') || k === 'PORT') variables[k] = v ?? '';
    return c.json({ variables, claves: Object.keys(process.env) });
  });
`;

function copiar(origen: string, destino: string) {
  fs.cpSync(origen, destino, {
    recursive: true,
    filter: (f) => {
      const rel = path.relative(origen, f);
      const partes = rel.split(path.sep);
      return !partes.includes('node_modules') && !partes.includes('dist') && !partes.includes('.git') && partes[0] !== 'datos';
    },
  });
}

export function prepararPlantillaEspia(): string {
  const destino = fs.mkdtempSync(path.join(os.tmpdir(), 'campusia-plantilla-espia-'));
  copiar(PLANTILLA, destino);
  const app = path.join(destino, 'servidor', 'app.ts');
  const texto = fs.readFileSync(app, 'utf8');
  if (!texto.includes(LINEA_SALUD)) {
    throw new Error(`La plantilla cambió: no se encontró en servidor/app.ts la línea ${LINEA_SALUD}`);
  }
  fs.writeFileSync(app, texto.replace(LINEA_SALUD, ESPIA + LINEA_SALUD));
  return destino;
}
