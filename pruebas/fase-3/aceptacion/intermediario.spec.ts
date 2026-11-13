import { crearTestAgente, expect, TIEMPO_FASE3, PROFE_AUSTRAL } from '../fixtures.ts';
import { sesion } from '../../fase-2/lib/cursos.ts';
import { cuerpoMensaje, cursoConEspacio, llamarModelo, tokenModelo, urlModelo } from '../lib/agente.ts';

const test = crearTestAgente();
test.describe.configure({ mode: 'serial', timeout: TIEMPO_FASE3 });

let id = '';
let token = '';
let base = '';
let prefijo = '';

function ultimo(nucleo: any) {
  return nucleo.modelo.pedidos[nucleo.modelo.pedidos.length - 1];
}

function valores(crudos: string[], nombre: string): string[] {
  const salida: string[] = [];
  for (let i = 0; i < crudos.length; i += 2) if (crudos[i]!.toLowerCase() === nombre) salida.push(crudos[i + 1]!);
  return salida;
}

test.describe('intermediario del modelo', () => {
  test.beforeAll(async ({ nucleo }) => {
    test.setTimeout(TIEMPO_FASE3);
    const profe = await sesion(nucleo, PROFE_AUSTRAL);
    id = await cursoConEspacio(profe, { nombre: 'Curso del Intermediario' });
    token = tokenModelo(nucleo, id);
    base = urlModelo(nucleo, id);
    prefijo = new URL(base).pathname.replace(/\/$/, '');
  });

  test('el espacio recibe la dirección del intermediario y un token de modelo propio', async ({ nucleo }) => {
    expect(token).toMatch(/^cmt_[A-Za-z0-9_-]{43}$/);
    const u = new URL(base);
    expect(u.protocol).toBe('http:');
    expect(Number(u.port)).toBe(nucleo.puertoEspacios);
    expect(u.pathname).toBe('/modelo');
    const salud = await llamarModelo(base, '/salud', { metodo: 'GET' });
    expect(salud.status).toBe(200);
    expect(salud.json).toEqual({ ok: true });
  });

  test('reenvía con la credencial de suscripción y el beta, sin la credencial del curso', async ({ nucleo }) => {
    const antes = nucleo.modelo.pedidos.length;
    const cuerpo = JSON.stringify(cuerpoMensaje('hola'));
    const r = await llamarModelo(base, `${prefijo}/v1/messages?beta=true`, {
      token,
      crudo: cuerpo,
      encabezados: {
        'anthropic-beta': 'claude-code-20250219,interleaved-thinking-2025-05-14',
        'user-agent': 'claude-cli/prueba (external, sdk-cli)',
        'x-app': 'cli',
        'x-stainless-lang': 'js',
        cookie: 'campusia_sesion=robada',
        'x-campus-curso': 'otro-curso',
        'x-campus-identidad': 'falsa.falsa',
      },
    });
    expect(r.status, r.texto).toBe(200);
    expect(r.json.content[0].text).toBe('ok');
    expect(nucleo.modelo.pedidos.length).toBe(antes + 1);
    const p = ultimo(nucleo);
    expect(p.metodo).toBe('POST');
    expect(p.ruta).toBe('/v1/messages');
    expect(p.consulta).toBe('?beta=true');
    expect(p.cuerpo).toBe(cuerpo);
    expect(valores(p.crudos, 'authorization')).toEqual([`Bearer ${nucleo.tokenReal}`]);
    expect(valores(p.crudos, 'x-api-key')).toEqual([]);
    const beta = valores(p.crudos, 'anthropic-beta').join(',').split(',').map((s) => s.trim());
    expect(beta).toEqual(expect.arrayContaining(['claude-code-20250219', 'interleaved-thinking-2025-05-14', 'oauth-2025-04-20']));
    expect(beta.filter((b) => b === 'oauth-2025-04-20')).toHaveLength(1);
    expect(p.encabezados['anthropic-version']).toBe('2023-06-01');
    expect(p.encabezados['user-agent']).toBe('claude-cli/prueba (external, sdk-cli)');
    expect(p.encabezados['x-app']).toBe('cli');
    expect(p.encabezados['x-stainless-lang']).toBe('js');
    expect(p.encabezados.cookie).toBeUndefined();
    expect(p.encabezados['x-campus-curso']).toBeUndefined();
    expect(p.encabezados['x-campus-identidad']).toBeUndefined();
    expect(p.encabezados.host).toBe(`127.0.0.1:${nucleo.modelo.puerto}`);
    expect(p.crudos.join('\n')).not.toContain(token);
  });

  test('el cliente también puede mandar el token en x-api-key', async ({ nucleo }) => {
    const r = await llamarModelo(base, `${prefijo}/v1/messages`, { xApiKey: token, cuerpo: cuerpoMensaje('hola') });
    expect(r.status, r.texto).toBe(200);
    const p = ultimo(nucleo);
    expect(valores(p.crudos, 'authorization')).toEqual([`Bearer ${nucleo.tokenReal}`]);
    expect(valores(p.crudos, 'x-api-key')).toEqual([]);
  });

  test('el streaming llega trozo a trozo, sin esperar al final', async () => {
    const r = await llamarModelo(base, `${prefijo}/v1/messages?beta=true`, { token, cuerpo: cuerpoMensaje('[lento] contame', { stream: true }) });
    expect(r.status).toBe(200);
    expect(String(r.encabezados['content-type'])).toContain('text/event-stream');
    expect(r.texto).toContain('message_start');
    expect(r.texto).toContain('message_stop');
    const conInicio = r.trozos.find((t) => t.texto.includes('message_start'));
    const conFin = r.trozos.find((t) => t.texto.includes('message_stop'));
    expect(conInicio && conFin).toBeTruthy();
    expect(conInicio!.ms).toBeLessThan(2000);
    expect(conFin!.ms - conInicio!.ms).toBeGreaterThan(1500);
  });

  test('count_tokens se reenvía', async ({ nucleo }) => {
    const r = await llamarModelo(base, `${prefijo}/v1/messages/count_tokens`, { token, cuerpo: cuerpoMensaje('hola') });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ input_tokens: 1234 });
    expect(ultimo(nucleo).ruta).toBe('/v1/messages/count_tokens');
  });

  test('el token real nunca vuelve al espacio aunque el destino lo repita', async ({ nucleo }) => {
    const r = await llamarModelo(base, `${prefijo}/v1/messages`, { token, cuerpo: cuerpoMensaje('[eco]') });
    expect(r.status).toBe(200);
    const todo = `${JSON.stringify(r.encabezados)}\n${r.texto}`;
    expect(todo).not.toContain(nucleo.tokenReal);
    expect(todo).toContain('[token-oculto]');
  });
});
