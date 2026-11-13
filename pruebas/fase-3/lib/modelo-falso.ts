import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';

export interface Herramienta {
  nombre: string;
  entrada: Record<string, unknown>;
}

export interface PasoGuion {
  texto?: string;
  herramientas?: Herramienta[];
}

export interface PedidoModelo {
  metodo: string;
  ruta: string;
  consulta: string;
  encabezados: http.IncomingHttpHeaders;
  crudos: string[];
  cuerpo: string;
  json: any;
  momento: number;
}

export interface UsoFalso {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface Credencial {
  tipo: 'bearer' | 'x-api-key';
  valor: string;
  beta?: string | null;
}

export interface ModeloFalso {
  url: string;
  puerto: number;
  pedidos: PedidoModelo[];
  guiones: Map<string, PasoGuion[]>;
  uso: UsoFalso;
  credencial: Credencial | null;
  cerrar(): Promise<void>;
}

export const USO_POR_RESPUESTA: UsoFalso = {
  input_tokens: 1000,
  output_tokens: 2000,
  cache_creation_input_tokens: 400,
  cache_read_input_tokens: 2000,
};

export const TEXTO_FINAL = 'Listo, ya está en la versión de prueba.';

function textoDeContenido(contenido: any): string {
  if (typeof contenido === 'string') return contenido;
  if (!Array.isArray(contenido)) return '';
  return contenido
    .map((b: any) => {
      if (b?.type === 'text') return String(b.text ?? '');
      if (b?.type === 'tool_result') return textoDeContenido(b.content);
      return '';
    })
    .join('\n');
}

function textoPropioDeUsuario(contenido: any): string {
  if (typeof contenido === 'string') return contenido;
  if (!Array.isArray(contenido)) return '';
  return contenido
    .filter((b: any) => b?.type === 'text')
    .map((b: any) => String(b.text ?? ''))
    .join('\n');
}

export function guionDelPedido(json: any): { nombre: string; paso: number } | null {
  const mensajes: any[] = Array.isArray(json?.messages) ? json.messages : [];
  for (let i = mensajes.length - 1; i >= 0; i--) {
    const m = mensajes[i];
    if (m?.role !== 'user') continue;
    const marca = /\[guion:([a-z0-9-]+)\]/.exec(textoPropioDeUsuario(m.content));
    if (!marca) continue;
    const paso = mensajes.slice(i + 1).filter((x) => x?.role === 'assistant').length;
    return { nombre: marca[1]!, paso };
  }
  return null;
}

function sse(res: http.ServerResponse, evento: string, datos: unknown) {
  res.write(`event: ${evento}\ndata: ${JSON.stringify(datos)}\n\n`);
}

function bloques(paso: PasoGuion): any[] {
  const salida: any[] = [];
  if (paso.texto) salida.push({ type: 'text', text: paso.texto });
  for (const h of paso.herramientas ?? []) {
    salida.push({ type: 'tool_use', id: `toolu_${crypto.randomBytes(12).toString('hex')}`, name: h.nombre, input: h.entrada });
  }
  if (!salida.length) salida.push({ type: 'text', text: TEXTO_FINAL });
  return salida;
}

async function responder(res: http.ServerResponse, json: any, paso: PasoGuion, uso: UsoFalso, demoraMs: number) {
  const contenido = bloques(paso);
  const motivo = contenido.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn';
  const modelo = typeof json?.model === 'string' && json.model ? json.model : 'claude-falso';
  const id = `msg_${crypto.randomBytes(10).toString('hex')}`;
  if (!json?.stream) {
    res.writeHead(200, { 'content-type': 'application/json', 'request-id': `req_${id}` });
    res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model: modelo, content: contenido, stop_reason: motivo, stop_sequence: null, usage: uso }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': `req_${id}` });
  sse(res, 'message_start', {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: modelo,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { ...uso, output_tokens: 1 },
    },
  });
  if (demoraMs > 0) await new Promise((r) => setTimeout(r, demoraMs));
  contenido.forEach((b, i) => {
    if (b.type === 'text') {
      sse(res, 'content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } });
      const t = String(b.text);
      const mitad = Math.ceil(t.length / 2);
      for (const parte of [t.slice(0, mitad), t.slice(mitad)]) {
        if (parte) sse(res, 'content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: parte } });
      }
    } else {
      sse(res, 'content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
    }
    sse(res, 'content_block_stop', { type: 'content_block_stop', index: i });
  });
  sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: motivo, stop_sequence: null }, usage: { output_tokens: uso.output_tokens } });
  sse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

function errorAnthropic(res: http.ServerResponse, estado: number, tipo: string, mensaje: string) {
  res.writeHead(estado, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: tipo, message: mensaje } }));
}

function credencialValida(m: ModeloFalso, enc: http.IncomingHttpHeaders): boolean {
  const c = m.credencial;
  if (!c) return true;
  if (c.tipo === 'bearer') {
    if (enc['x-api-key'] !== undefined) return false;
    if (enc.authorization !== `Bearer ${c.valor}`) return false;
  } else {
    if (enc.authorization !== undefined) return false;
    if (enc['x-api-key'] !== c.valor) return false;
  }
  const beta = String(enc['anthropic-beta'] ?? '')
    .split(',')
    .map((s) => s.trim());
  if (c.beta && !beta.includes(c.beta)) return false;
  if (c.beta === null && beta.includes('oauth-2025-04-20')) return false;
  return true;
}

export async function levantarModeloFalso(credencial: Credencial | null = null): Promise<ModeloFalso> {
  const modelo: ModeloFalso = {
    url: '',
    puerto: 0,
    pedidos: [],
    guiones: new Map(),
    uso: { ...USO_POR_RESPUESTA },
    credencial,
    cerrar: async () => {},
  };
  const servidor = http.createServer((req, res) => {
    const partes: Buffer[] = [];
    req.on('data', (p) => partes.push(p));
    req.on('end', async () => {
      const cuerpo = Buffer.concat(partes).toString('utf8');
      const u = new URL(req.url ?? '/', 'http://modelo-falso');
      let json: any = null;
      try {
        json = cuerpo ? JSON.parse(cuerpo) : null;
      } catch {
        json = null;
      }
      modelo.pedidos.push({
        metodo: req.method ?? '',
        ruta: u.pathname,
        consulta: u.search,
        encabezados: req.headers,
        crudos: req.rawHeaders,
        cuerpo,
        json,
        momento: Date.now(),
      });
      try {
        if (!credencialValida(modelo, req.headers)) {
          errorAnthropic(res, 401, 'authentication_error', 'credencial inválida');
          return;
        }
        if (req.method === 'POST' && u.pathname === '/v1/messages/count_tokens') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ input_tokens: 1234 }));
          return;
        }
        if (req.method !== 'POST' || u.pathname !== '/v1/messages') {
          errorAnthropic(res, 404, 'not_found_error', 'ruta desconocida en el modelo falso');
          return;
        }
        const texto = (Array.isArray(json?.messages) ? json.messages : []).map((m: any) => textoDeContenido(m?.content)).join('\n');
        if (texto.includes('[eco]')) {
          const eco = `authorization=${req.headers.authorization ?? ''} x-api-key=${req.headers['x-api-key'] ?? ''}`;
          res.writeHead(200, { 'content-type': 'application/json', 'x-eco': eco });
          res.end(JSON.stringify({ id: 'msg_eco', type: 'message', role: 'assistant', model: json?.model ?? 'x', content: [{ type: 'text', text: eco }], stop_reason: 'end_turn', stop_sequence: null, usage: modelo.uso }));
          return;
        }
        const demora = texto.includes('[lento]') ? 2500 : 0;
        const tieneHerramientas = Array.isArray(json?.tools) && json.tools.length > 0;
        const g = tieneHerramientas ? guionDelPedido(json) : null;
        let paso: PasoGuion = { texto: tieneHerramientas ? TEXTO_FINAL : 'ok' };
        if (g) {
          const pasos = modelo.guiones.get(g.nombre);
          if (pasos && g.paso < pasos.length) paso = pasos[g.paso]!;
        }
        await responder(res, json, paso, modelo.uso, demora);
      } catch (e) {
        if (!res.headersSent) errorAnthropic(res, 500, 'api_error', String(e));
        else res.end();
      }
    });
  });
  await new Promise<void>((resolve) => servidor.listen(0, '127.0.0.1', () => resolve()));
  modelo.puerto = (servidor.address() as AddressInfo).port;
  modelo.url = `http://127.0.0.1:${modelo.puerto}`;
  modelo.cerrar = () =>
    new Promise<void>((resolve) => {
      servidor.closeAllConnections?.();
      servidor.close(() => resolve());
    });
  return modelo;
}

export interface ResultadoHerramienta {
  id: string;
  nombre: string;
  entrada: any;
  contenido: string;
  error: boolean;
}

export function resultadosDeHerramientas(m: ModeloFalso, desde = 0): ResultadoHerramienta[] {
  const usos = new Map<string, { nombre: string; entrada: any }>();
  const resultados = new Map<string, ResultadoHerramienta>();
  const previos = new Set<string>();
  for (const p of m.pedidos.slice(0, desde)) {
    for (const msj of (p.json?.messages ?? []) as any[]) {
      if (!Array.isArray(msj?.content)) continue;
      for (const b of msj.content) if (b?.type === 'tool_result') previos.add(b.tool_use_id);
    }
  }
  for (const p of m.pedidos.slice(desde)) {
    for (const msj of (p.json?.messages ?? []) as any[]) {
      if (!Array.isArray(msj?.content)) continue;
      for (const b of msj.content) {
        if (msj.role === 'assistant' && b?.type === 'tool_use') usos.set(b.id, { nombre: b.name, entrada: b.input });
        if (msj.role === 'user' && b?.type === 'tool_result' && !previos.has(b.tool_use_id)) {
          const u = usos.get(b.tool_use_id);
          resultados.set(b.tool_use_id, {
            id: b.tool_use_id,
            nombre: u?.nombre ?? '',
            entrada: u?.entrada,
            contenido: textoDeContenido(b.content),
            error: b.is_error === true,
          });
        }
      }
    }
  }
  return [...resultados.values()];
}

export function cuerposDesde(m: ModeloFalso, desde = 0): string {
  return m.pedidos
    .slice(desde)
    .map((p) => `${p.crudos.join('\n')}\n${p.cuerpo}`)
    .join('\n');
}
