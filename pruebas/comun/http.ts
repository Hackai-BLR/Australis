import http from 'node:http';
import crypto from 'node:crypto';
import { COOKIE_SESION } from './entorno.ts';
import type { Nucleo } from './nucleo.ts';

export interface Respuesta {
  status: number;
  encabezados: http.IncomingHttpHeaders;
  texto: string;
  json: any;
  setCookies: string[];
}

export interface OpcionesPedido {
  sub?: string;
  host?: string;
  origen?: string | null;
  sinEncabezadoPropio?: boolean;
  sinCookies?: boolean;
  cookie?: string;
  bearer?: string;
  encabezados?: Record<string, string>;
  cuerpoCrudo?: string;
  tipo?: string;
}

export function ipAleatoria() {
  const b = crypto.randomBytes(3);
  return `10.${b[0]}.${b[1]}.${Math.max(1, b[2])}`;
}

export function atributosCookie(setCookie: string) {
  const partes = setCookie.split(';').map((p) => p.trim());
  const [nombreValor, ...resto] = partes;
  const i = nombreValor.indexOf('=');
  const atributos: Record<string, string | true> = {};
  for (const a of resto) {
    const j = a.indexOf('=');
    if (j === -1) atributos[a.toLowerCase()] = true;
    else atributos[a.slice(0, j).toLowerCase()] = a.slice(j + 1);
  }
  return { nombre: nombreValor.slice(0, i), valor: nombreValor.slice(i + 1), atributos };
}

export class Cliente {
  cookies = new Map<string, string>();
  ip: string;
  bearer: string | null = null;
  email: string | null = null;

  constructor(public nucleo: Nucleo, ip?: string) {
    this.ip = ip ?? ipAleatoria();
  }

  get sesion(): string | undefined {
    return this.cookies.get(COOKIE_SESION);
  }

  set sesion(valor: string | undefined) {
    if (valor === undefined) this.cookies.delete(COOKIE_SESION);
    else this.cookies.set(COOKIE_SESION, valor);
  }

  clonarSesion(): Cliente {
    const otro = new Cliente(this.nucleo, this.ip);
    for (const [k, v] of this.cookies) otro.cookies.set(k, v);
    otro.email = this.email;
    return otro;
  }

  pedir(metodo: string, ruta: string, cuerpo?: any, op: OpcionesPedido = {}): Promise<Respuesta> {
    const host = op.host ?? this.nucleo.host(op.sub);
    const encabezados: Record<string, string> = { host, 'cf-connecting-ip': this.ip };
    const modifica = !['GET', 'HEAD', 'OPTIONS'].includes(metodo);
    if (modifica) {
      const origen = op.origen === undefined ? `${this.nucleo.esquema()}://${host}` : op.origen;
      if (origen !== null) encabezados.origin = origen;
      if (!op.sinEncabezadoPropio) encabezados['x-campusia'] = '1';
    }
    const cookies = op.cookie ?? (op.sinCookies ? '' : [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    if (cookies) encabezados.cookie = cookies;
    const bearer = op.bearer ?? this.bearer;
    if (bearer) encabezados.authorization = `Bearer ${bearer}`;
    let datos: string | undefined;
    if (op.cuerpoCrudo !== undefined) {
      datos = op.cuerpoCrudo;
      encabezados['content-type'] = op.tipo ?? 'application/json';
    } else if (cuerpo !== undefined) {
      datos = JSON.stringify(cuerpo);
      encabezados['content-type'] = 'application/json';
    }
    if (datos !== undefined) encabezados['content-length'] = String(Buffer.byteLength(datos));
    Object.assign(encabezados, op.encabezados ?? {});
    for (const k of Object.keys(encabezados)) if (encabezados[k] === '') delete encabezados[k];
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: this.nucleo.puerto, path: ruta, method: metodo, headers: encabezados, timeout: 30_000 },
        (res) => {
          const partes: Buffer[] = [];
          res.on('data', (p) => partes.push(p));
          res.on('end', () => {
            const texto = Buffer.concat(partes).toString('utf8');
            let json: any = null;
            try {
              json = texto ? JSON.parse(texto) : null;
            } catch {
              json = null;
            }
            const setCookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
            if (!op.cookie && !op.sinCookies) {
              for (const sc of setCookies) {
                const { nombre, valor, atributos } = atributosCookie(sc);
                const maxAge = atributos['max-age'];
                const vencida =
                  valor === '' ||
                  (typeof maxAge === 'string' && Number(maxAge) <= 0) ||
                  (typeof atributos.expires === 'string' && Date.parse(atributos.expires) < Date.now());
                if (vencida) this.cookies.delete(nombre);
                else this.cookies.set(nombre, valor);
              }
            }
            resolve({ status: res.statusCode ?? 0, encabezados: res.headers, texto, json, setCookies });
          });
        },
      );
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error(`Tiempo agotado en ${metodo} ${ruta}`)));
      if (datos !== undefined) req.write(datos);
      req.end();
    });
  }

  get(ruta: string, op?: OpcionesPedido) {
    return this.pedir('GET', ruta, undefined, op);
  }

  post(ruta: string, cuerpo?: any, op?: OpcionesPedido) {
    return this.pedir('POST', ruta, cuerpo ?? {}, op);
  }

  put(ruta: string, cuerpo?: any, op?: OpcionesPedido) {
    return this.pedir('PUT', ruta, cuerpo ?? {}, op);
  }

  delete(ruta: string, op?: OpcionesPedido) {
    return this.pedir('DELETE', ruta, undefined, op);
  }
}
