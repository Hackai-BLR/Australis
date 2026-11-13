import crypto from 'node:crypto';
import http from 'node:http';

const SECRETO_TURNSTILE = process.env.TURNSTILE_SECRET ?? '1x0000000000000000000000000000000AA';
const TOKEN_TURNSTILE = 'XXXX.DUMMY.TOKEN.XXXX';
const CLAVE_MODELO = process.env.CLAVE_MODELO ?? 'sk-ant-clave-falsa-de-prueba';
const USO = { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

const pedidos = [];

function leer(req) {
  return new Promise((resolve, reject) => {
    const partes = [];
    req.on('data', (p) => partes.push(p));
    req.on('end', () => resolve(Buffer.concat(partes).toString('utf8')));
    req.on('error', reject);
  });
}

function responder(res, estado, cuerpo) {
  res.writeHead(estado, { 'content-type': 'application/json' });
  res.end(typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo));
}

function normalizar(texto) {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

function textoDelPedido(json) {
  const mensajes = Array.isArray(json?.messages) ? json.messages : [];
  return mensajes
    .map((m) => (typeof m.content === 'string' ? m.content : (m.content ?? []).map((b) => b.text ?? '').join('\n')))
    .join('\n');
}

function pedidoDelProfesor(texto) {
  const marca = 'Request:\n';
  const i = texto.lastIndexOf(marca);
  return normalizar(i === -1 ? texto : texto.slice(i + marca.length));
}

const GUION = [
  {
    clave: ['nota', 'calificacion', 'asistencia', 'acta'],
    texto: 'No puedo cambiar notas, asistencia ni actas cerradas. Solo propongo cambios en la estructura y el contenido del campus.',
    herramientas: [],
  },
  {
    clave: ['etica'],
    texto: 'Propongo agregar una semana sobre ética profesional con una lectura breve y una consigna de debate.',
    herramientas: [
      {
        name: 'add_section',
        input: {
          title: 'Semana de ética profesional',
          kind: 'week',
          placement: { at: 'end' },
          blocks: [
            { type: 'text', text: 'Esta semana trabajamos los dilemas éticos más frecuentes de la práctica profesional.' },
            { type: 'checklist', items: ['Leer el caso de la semana', 'Traer una postura por escrito', 'Participar del debate'] },
            { type: 'callout', text: 'La participación en el debate no lleva nota.' },
          ],
        },
      },
    ],
  },
  {
    clave: ['bibliografia', 'lectura', 'material'],
    texto: 'Propongo agregar una sección de bibliografía.',
    herramientas: [
      {
        name: 'add_section',
        input: {
          title: 'Bibliografía',
          kind: 'resources',
          placement: { at: 'end' },
          blocks: [{ type: 'text', text: 'Lecturas obligatorias y complementarias.' }],
        },
      },
    ],
  },
];

function respuestaDeMensajes(json) {
  const ofrecidas = new Set((json?.tools ?? []).map((t) => t.name));
  const pedido = pedidoDelProfesor(textoDelPedido(json));
  const paso = GUION.find((p) => p.clave.some((c) => pedido.includes(c)));
  const contenido = [];
  if (!paso) {
    contenido.push({ type: 'text', text: 'Esta es una respuesta del modelo falso: no tengo una propuesta preparada para ese pedido.' });
  } else {
    contenido.push({ type: 'text', text: paso.texto });
    for (const h of paso.herramientas) {
      if (ofrecidas.has(h.name)) {
        contenido.push({ type: 'tool_use', id: `toolu_${crypto.randomBytes(12).toString('hex')}`, name: h.name, input: h.input });
      }
    }
  }
  const usaHerramientas = contenido.some((b) => b.type === 'tool_use');
  return {
    id: `msg_${crypto.randomBytes(10).toString('hex')}`,
    type: 'message',
    role: 'assistant',
    model: typeof json?.model === 'string' ? json.model : 'claude-falso',
    content: contenido,
    stop_reason: usaHerramientas ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: USO,
  };
}

const turnstile = http.createServer(async (req, res) => {
  const cuerpo = new URLSearchParams(await leer(req));
  const ok = cuerpo.get('secret') === SECRETO_TURNSTILE && cuerpo.get('response') === TOKEN_TURNSTILE;
  responder(res, 200, ok ? { success: true, 'error-codes': [] } : { success: false, 'error-codes': ['invalid-input-response'] });
});

const modelo = http.createServer(async (req, res) => {
  const texto = await leer(req);
  let json = null;
  try {
    json = texto ? JSON.parse(texto) : null;
  } catch {
    json = null;
  }
  const clave = req.headers['x-api-key'];
  pedidos.push({
    metodo: req.method,
    ruta: req.url,
    claveRecibida: clave ?? null,
    autorizacion: req.headers.authorization ?? null,
    usuario: req.headers['x-campus-usuario'] ?? null,
    herramientas: (json?.tools ?? []).map((t) => t.name),
    texto: json ? textoDelPedido(json) : '',
    momento: Date.now(),
  });
  if (clave !== CLAVE_MODELO) {
    responder(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'credencial inválida' } });
    return;
  }
  if (req.method !== 'POST' || !req.url?.startsWith('/v1/messages')) {
    responder(res, 404, { type: 'error', error: { type: 'not_found_error', message: 'ruta desconocida' } });
    return;
  }
  responder(res, 200, respuestaDeMensajes(json));
});

const control = http.createServer((req, res) => {
  if (req.url === '/salud') return responder(res, 200, { ok: true });
  if (req.url === '/pedidos' && req.method === 'GET') return responder(res, 200, pedidos);
  if (req.url === '/reiniciar' && req.method === 'POST') {
    pedidos.length = 0;
    return responder(res, 200, { ok: true });
  }
  return responder(res, 404, { error: 'no existe' });
});

turnstile.listen(8090, '0.0.0.0');
modelo.listen(8091, '0.0.0.0');
control.listen(9000, '0.0.0.0');
