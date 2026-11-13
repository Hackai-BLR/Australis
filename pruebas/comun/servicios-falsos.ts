import http from 'node:http';
import type { AddressInfo } from 'node:net';

export const TURNSTILE_SITE_KEY = '1x00000000000000000000AA';
export const TURNSTILE_SECRET = '1x0000000000000000000000000000000AA';
export const TURNSTILE_TOKEN_VALIDO = 'XXXX.DUMMY.TOKEN.XXXX';
export const BREVO_CLAVE_PRUEBA = 'clave-brevo-de-prueba';

export interface PedidoRecibido {
  ruta: string;
  encabezados: http.IncomingHttpHeaders;
  cuerpo: any;
}

export interface ServicioFalso {
  url: string;
  pedidos: PedidoRecibido[];
  fallar: boolean;
  cerrar(): Promise<void>;
}

function leerCuerpo(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const partes: Buffer[] = [];
    req.on('data', (p) => partes.push(p));
    req.on('end', () => resolve(Buffer.concat(partes).toString('utf8')));
    req.on('error', reject);
  });
}

function interpretar(texto: string, tipo: string | undefined): any {
  if (tipo && tipo.includes('application/json')) {
    try {
      return JSON.parse(texto);
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(texto));
}

async function levantar(manejar: (p: PedidoRecibido, s: ServicioFalso) => { status: number; cuerpo: any }): Promise<ServicioFalso> {
  const servicio: ServicioFalso = { url: '', pedidos: [], fallar: false, cerrar: async () => {} };
  const servidor = http.createServer(async (req, res) => {
    const texto = await leerCuerpo(req);
    const pedido: PedidoRecibido = {
      ruta: req.url ?? '/',
      encabezados: req.headers,
      cuerpo: interpretar(texto, req.headers['content-type']),
    };
    servicio.pedidos.push(pedido);
    const r = servicio.fallar ? { status: 500, cuerpo: { error: 'falla simulada' } } : manejar(pedido, servicio);
    res.writeHead(r.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(r.cuerpo));
  });
  await new Promise<void>((resolve) => servidor.listen(0, '127.0.0.1', () => resolve()));
  const puerto = (servidor.address() as AddressInfo).port;
  servicio.cerrar = () => new Promise<void>((resolve) => servidor.close(() => resolve()));
  servicio.url = `http://127.0.0.1:${puerto}`;
  return servicio;
}

export async function turnstileFalso(): Promise<ServicioFalso> {
  const s = await levantar((p) => {
    const ok = p.cuerpo.secret === TURNSTILE_SECRET && p.cuerpo.response === TURNSTILE_TOKEN_VALIDO;
    return {
      status: 200,
      cuerpo: ok
        ? { success: true, 'error-codes': [], hostname: 'campusia.prueba' }
        : { success: false, 'error-codes': ['invalid-input-response'] },
    };
  });
  s.url = `${s.url}/turnstile/v0/siteverify`;
  return s;
}

export async function brevoFalso(): Promise<ServicioFalso> {
  const s = await levantar((p) => {
    if (p.encabezados['api-key'] !== BREVO_CLAVE_PRUEBA) return { status: 401, cuerpo: { code: 'unauthorized' } };
    return { status: 201, cuerpo: { messageId: `<prueba-${Date.now()}@brevo>` } };
  });
  s.url = `${s.url}/v3/smtp/email`;
  return s;
}

export async function puertoLibre(): Promise<number> {
  const servidor = http.createServer();
  await new Promise<void>((resolve) => servidor.listen(0, '127.0.0.1', () => resolve()));
  const puerto = (servidor.address() as AddressInfo).port;
  await new Promise<void>((resolve) => servidor.close(() => resolve()));
  return puerto;
}
