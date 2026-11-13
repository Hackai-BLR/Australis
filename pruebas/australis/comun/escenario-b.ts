import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { COOKIE_SESION, DOMINIO } from './datos-b.ts';
import { estadoB, type EstadoPilaB } from './pila-b.ts';

export type RespuestaB = { estado: number; json: any; texto: string; encabezados: http.IncomingHttpHeaders };

export type OpcionesPedidoB = {
  sub?: string;
  origen?: string | null;
  encabezados?: Record<string, string>;
  sinCookies?: boolean;
};

export const TOKEN_TURNSTILE = 'XXXX.DUMMY.TOKEN.XXXX';

export const SCRIPT_TURNSTILE_FALSO = `
(function(){
  var src = (document.currentScript && document.currentScript.src) || '';
  var onload = null;
  try { onload = new URL(src).searchParams.get('onload'); } catch (e) {}
  window.turnstile = {
    render: function(el, op){
      setTimeout(function(){ if (op && op.callback) op.callback('${TOKEN_TURNSTILE}'); }, 50);
      return 'widget-falso';
    },
    reset: function(){}, remove: function(){}, getResponse: function(){ return '${TOKEN_TURNSTILE}'; },
    ready: function(f){ f(); }, execute: function(){}
  };
  if (onload && typeof window[onload] === 'function') { window[onload](); }
})();
`;

export function ipAleatoria() {
  const b = crypto.randomBytes(3);
  return `10.${b[0]}.${b[1]}.${Math.max(1, b[2])}`;
}

export function aleatorio(prefijo: string) {
  return `${prefijo}${crypto.randomBytes(4).toString('hex')}`;
}

export function pausa(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function dormirHasta<T>(ms: number, leer: () => Promise<T | null | undefined | false>, mensaje: string): Promise<T> {
  const limite = Date.now() + ms;
  const paso = async (): Promise<T> => {
    for (;;) {
      const valor = await leer();
      if (valor) return valor as T;
      if (Date.now() > limite) throw new Error(mensaje);
      await pausa(500);
    }
  };
  return paso();
}

export function hostDe(estado: EstadoPilaB, sub?: string) {
  return sub ? `${sub}.${DOMINIO}:${estado.puerto}` : `${DOMINIO}:${estado.puerto}`;
}

export function origenDe(sub?: string) {
  return `http://${hostDe(estadoB(), sub)}`;
}

function solicitar(opciones: http.RequestOptions, datos?: string): Promise<RespuestaB> {
  return new Promise((resolve, reject) => {
    const req = http.request({ ...opciones, timeout: 60_000 }, (res) => {
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
        resolve({ estado: res.statusCode ?? 0, json, texto, encabezados: res.headers });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`Tiempo agotado en ${opciones.method} ${opciones.path}`)));
    if (datos !== undefined) req.write(datos);
    req.end();
  });
}

export class Sesion {
  cookies = new Map<string, string>();
  email: string | null = null;
  readonly ip = ipAleatoria();
  readonly estado = estadoB();

  get cookieSesion(): string | undefined {
    return this.cookies.get(COOKIE_SESION);
  }

  async pedir(metodo: string, ruta: string, cuerpo?: unknown, op: OpcionesPedidoB = {}): Promise<RespuestaB> {
    const host = hostDe(this.estado, op.sub);
    const encabezados: Record<string, string> = { host, 'cf-connecting-ip': this.ip };
    if (!['GET', 'HEAD', 'OPTIONS'].includes(metodo)) {
      const origen = op.origen === undefined ? `http://${host}` : op.origen;
      if (origen !== null) encabezados.origin = origen;
      encabezados['x-campusia'] = '1';
    }
    const cookies = op.sinCookies ? '' : [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookies) encabezados.cookie = cookies;
    let datos: string | undefined;
    if (cuerpo !== undefined) {
      datos = JSON.stringify(cuerpo);
      encabezados['content-type'] = 'application/json';
      encabezados['content-length'] = String(Buffer.byteLength(datos));
    }
    Object.assign(encabezados, op.encabezados ?? {});
    const r = await solicitar({ host: '127.0.0.1', port: this.estado.puerto, path: ruta, method: metodo, headers: encabezados }, datos);
    for (const sc of ([] as string[]).concat((r.encabezados['set-cookie'] as string[] | undefined) ?? [])) {
      const [par, ...atributos] = sc.split(';').map((p) => p.trim());
      const i = par.indexOf('=');
      const nombre = par.slice(0, i);
      const valor = par.slice(i + 1);
      const vencida = valor === '' || atributos.some((a) => /^max-age=0$/i.test(a));
      if (vencida) this.cookies.delete(nombre);
      else this.cookies.set(nombre, valor);
    }
    return r;
  }

  get(ruta: string, op?: OpcionesPedidoB) {
    return this.pedir('GET', ruta, undefined, op);
  }

  post(ruta: string, cuerpo: unknown = {}, op?: OpcionesPedidoB) {
    return this.pedir('POST', ruta, cuerpo, op);
  }

  put(ruta: string, cuerpo: unknown = {}, op?: OpcionesPedidoB) {
    return this.pedir('PUT', ruta, cuerpo, op);
  }

  delete(ruta: string, op?: OpcionesPedidoB) {
    return this.pedir('DELETE', ruta, undefined, op);
  }

  campus(metodo: string, ruta: string, cuerpo?: unknown, op: OpcionesPedidoB = {}) {
    return this.pedir(metodo, ruta, cuerpo, { ...op, sub: 'campus' });
  }
}

export function mailsEnviados(): Array<{ para: string; asunto: string; texto: string }> {
  const e = estadoB();
  let salida = '';
  try {
    salida = execFileSync('docker', ['exec', e.nucleo, 'sh', '-c', 'cat /datos/mails.jsonl 2>/dev/null || true'], { encoding: 'utf8' });
  } catch {
    return [];
  }
  return salida
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

export function cantidadMails() {
  return mailsEnviados().length;
}

export async function esperarCodigo(correo: string, desde: number): Promise<string> {
  return dormirHasta(
    15_000,
    async () => {
      const m = mailsEnviados()
        .slice(desde)
        .filter((x) => x.para.toLowerCase() === correo.toLowerCase())
        .map((x) => x.texto.match(/(?<!\d)(\d{6})(?!\d)/)?.[1])
        .filter(Boolean);
      return m.length ? m[m.length - 1] : null;
    },
    `No llegó el código a ${correo}`,
  );
}

export async function entrar(correo: string): Promise<Sesion> {
  const s = new Sesion();
  const desde = cantidadMails();
  const pedido = await s.post('/api/login/codigo', { email: correo });
  if (pedido.estado !== 200) throw new Error(`No se pudo pedir el código de ${correo}: ${pedido.estado} ${pedido.texto}`);
  const codigo = await esperarCodigo(correo, desde);
  const r = await s.post('/api/login/verificar', { email: correo, codigo });
  if (r.estado !== 200) throw new Error(`No se pudo verificar el código de ${correo}: ${r.estado} ${r.texto}`);
  s.email = correo;
  return s;
}

export async function contextoDe(browser: Browser, sesion: Sesion | null): Promise<BrowserContext> {
  const ctx = await browser.newContext({ extraHTTPHeaders: { 'CF-Connecting-IP': ipAleatoria() } });
  await ctx.route('https://challenges.cloudflare.com/turnstile/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/javascript', body: SCRIPT_TURNSTILE_FALSO }),
  );
  if (sesion?.cookieSesion) {
    await ctx.addCookies([{ name: COOKIE_SESION, value: sesion.cookieSesion, domain: `.${DOMINIO}`, path: '/', httpOnly: true, sameSite: 'Lax' }]);
  }
  return ctx;
}

export async function paginaDe(browser: Browser, sesion: Sesion | null): Promise<{ ctx: BrowserContext; pagina: Page }> {
  const ctx = await contextoDe(browser, sesion);
  return { ctx, pagina: await ctx.newPage() };
}

export function firmarIdentidad(
  carga: Record<string, unknown>,
  semilla: string,
): string {
  const privada = crypto.createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(semilla, 'base64url')]),
    format: 'der',
    type: 'pkcs8',
  });
  const cuerpo = Buffer.from(JSON.stringify(carga)).toString('base64url');
  const firma = crypto.sign(null, Buffer.from(cuerpo, 'ascii'), privada).toString('base64url');
  return `${cuerpo}.${firma}`;
}

export function cargaDeIdentidad(correo: string, sobrescribir: Record<string, unknown> = {}) {
  const ahora = Math.floor(Date.now() / 1000);
  return {
    v: 1,
    curso: 'australis',
    usuario: '999',
    email: correo,
    nombre: 'Persona de prueba',
    rol: 'profesor',
    administrador: false,
    emitido: ahora,
    vence: ahora + 60,
    ...sobrescribir,
  };
}

export function semillaAjena(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function pedirAlBackend(metodo: string, ruta: string, encabezados: Record<string, string> = {}, cuerpo?: unknown): Promise<RespuestaB> {
  const e = estadoB();
  const datos = cuerpo === undefined ? undefined : JSON.stringify(cuerpo);
  const cabeceras: Record<string, string> = { ...encabezados };
  if (datos !== undefined) {
    cabeceras['content-type'] = 'application/json';
    cabeceras['content-length'] = String(Buffer.byteLength(datos));
  }
  return solicitar({ host: '127.0.0.1', port: e.puertoBackend, path: ruta, method: metodo, headers: cabeceras }, datos);
}

export type PedidoAlModelo = {
  claveRecibida: string | null;
  autorizacion: string | null;
  usuario: string | null;
  herramientas: string[];
  texto: string;
};

export async function pedidosAlModelo(): Promise<PedidoAlModelo[]> {
  const e = estadoB();
  const r = await solicitar({ host: '127.0.0.1', port: e.puertoControl, path: '/pedidos', method: 'GET' });
  return r.json as PedidoAlModelo[];
}

export async function reiniciarModelo() {
  const e = estadoB();
  await solicitar({ host: '127.0.0.1', port: e.puertoControl, path: '/reiniciar', method: 'POST', headers: { 'content-length': '0' } });
}

export function entornoDelContenedor(contenedor: string): string {
  return execFileSync('docker', ['exec', contenedor, 'sh', '-c', 'env; cat /proc/1/environ 2>/dev/null | tr "\\0" "\\n"'], { encoding: 'utf8' });
}

export function inspeccionar(contenedor: string): string {
  return execFileSync('docker', ['inspect', contenedor], { encoding: 'utf8' });
}

function llamarDesde(contenedor: string, guion: string, destino: string, token: string | null, correo: string | null): number {
  const args = ['exec', '-e', `DESTINO=${destino}`];
  if (token) args.push('-e', `TOKEN=${token}`);
  if (correo) args.push('-e', `CORREO=${correo}`);
  args.push(contenedor, 'node', '-e', guion);
  return Number(execFileSync('docker', args, { encoding: 'utf8' }).trim());
}

export function llamarAlIntermediario(contenedor: string, token: string | null, correo: string | null): number {
  const guion = `
    const h = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
    if (process.env.TOKEN) h['x-api-key'] = process.env.TOKEN;
    if (process.env.CORREO) h['x-campus-usuario'] = process.env.CORREO;
    fetch(process.env.DESTINO, { method: 'POST', headers: h, body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 16, messages: [{ role: 'user', content: 'hola' }] }) })
      .then((r) => { console.log(r.status); })
      .catch(() => { console.log(0); });
  `;
  return llamarDesde(contenedor, guion, 'http://127.0.0.1:8082/modelo/v1/messages', token, correo);
}

export function llamarAlModeloFalso(contenedor: string, token: string): number {
  const guion = `
    fetch(process.env.DESTINO, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': process.env.TOKEN }, body: JSON.stringify({ model: 'x', max_tokens: 8, messages: [{ role: 'user', content: 'hola' }] }) })
      .then((r) => { console.log(r.status); })
      .catch(() => { console.log(0); });
  `;
  return llamarDesde(contenedor, guion, 'http://127.0.0.1:8091/v1/messages', token, null);
}

export function buscarEnContenedor(contenedor: string, texto: string, rutas: string[]): string {
  try {
    return execFileSync('docker', ['exec', contenedor, 'sh', '-c', `grep -rla "${texto}" ${rutas.join(' ')} 2>/dev/null || true`], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}
