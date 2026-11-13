import { crearTestAgente, expect, TIEMPO_FASE3, PROFE_AUSTRAL, PROFE2_AUSTRAL } from '../fixtures.ts';
import { idUsuario, inscribirOk, pedirApiCursos, sesion, tokenDeCurso, getCurso, enCurso } from '../../fase-2/lib/cursos.ts';
import { ejecutarEn, inspeccionar, inspeccionarRed } from '../../fase-2/lib/docker.ts';
import { firmaValida, leerIdentidad } from '../../fase-2/lib/identidad.ts';
import type { Cliente } from '../../comun/http.ts';
import { ESPERA_RECARGA_MS, cursoConEspacio, enPrueba, entornoEspacio, esperarRespuesta, guion, nombreEspacio, pedidoOk } from '../lib/agente.ts';

const test = crearTestAgente({ espia: true });
test.describe.configure({ mode: 'serial', timeout: TIEMPO_FASE3 });

let id = '';
let profe: Cliente;
let profe2: Cliente;

test.describe('espacio de trabajo y versión de prueba', () => {
  test.beforeAll(async ({ nucleo }) => {
    test.setTimeout(TIEMPO_FASE3);
    profe = await sesion(nucleo, PROFE_AUSTRAL);
    profe2 = await sesion(nucleo, PROFE2_AUSTRAL);
    id = await cursoConEspacio(profe, { nombre: 'Curso del Espacio' });
    await inscribirOk(profe, id, [PROFE2_AUSTRAL], 'profesor');
  });

  test('el espacio es un contenedor propio con las variables justas', async ({ nucleo }) => {
    const nombre = nombreEspacio(nucleo, id);
    const info = inspeccionar(nombre);
    expect(info, `no existe el contenedor ${nombre}`).toBeTruthy();
    expect(info.State.Running).toBe(true);
    expect(info.Config.Image).toBe(nucleo.imagenEspacio);
    expect(info.Config.Labels['campusia.prefijo']).toBe(nucleo.prefijo);
    expect(info.Config.Labels['campusia.curso']).toBe(id);
    expect(info.Config.Labels['campusia.tipo']).toBe('espacio');

    const env = entornoEspacio(nucleo, id);
    const clave = nucleo.ejecutar(['clave-publica']).stdout.trim();
    expect(env.PORT).toBe('3000');
    expect(env.CAMPUSIA_CURSO).toBe(id);
    expect(env.CAMPUSIA_CLAVE_PUBLICA).toBe(clave);
    expect(env.CAMPUSIA_DATOS).toBe('/datos');
    expect(env.CAMPUSIA_TOKEN_CURSO).toMatch(/^cct_[A-Za-z0-9_-]{43}$/);
    expect(env.CAMPUSIA_TOKEN_CURSO).not.toBe(tokenDeCurso(nucleo, id));
    expect(env.ANTHROPIC_AUTH_TOKEN).toMatch(/^cmt_[A-Za-z0-9_-]{43}$/);
    const api = new URL(env.CAMPUSIA_API!);
    expect(Number(api.port)).toBe(nucleo.puertoEspacios);
    expect(env.ANTHROPIC_BASE_URL).toBe(`${env.CAMPUSIA_API!.replace(/\/$/, '')}/modelo`);
    const proxy = new URL(env.HTTPS_PROXY ?? env.https_proxy ?? '');
    expect(Number(proxy.port)).toBe(nucleo.puertoProxy);
    expect(proxy.hostname).toBe(api.hostname);
    for (const prohibida of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'SESSION_SECRET', 'IDENTIDAD_CLAVE_PRIVADA', 'DOCKER_HOST', 'MODELO_DESTINO', 'DATABASE_URL']) {
      expect(env[prohibida], prohibida).toBeUndefined();
    }
    expect(Object.values(env).join('\n')).not.toContain(nucleo.tokenReal);

    const redes = Object.keys(info.NetworkSettings.Networks);
    expect(redes).toEqual([`${nucleo.prefijo}-espacios`]);
    const red = inspeccionarRed(`${nucleo.prefijo}-espacios`);
    expect(red.Internal).toBe(true);
    expect(red.Options?.['com.docker.network.bridge.enable_icc']).toBe('false');

    const destinos = (info.Mounts ?? []).map((m: any) => m.Destination).sort();
    expect(destinos).toContain('/repo');
    expect(destinos).toContain('/datos');
    for (const m of info.Mounts ?? []) {
      if (m.Type === 'bind') {
        expect(m.Source.startsWith(nucleo.raizEspacios), `${m.Source} -> ${m.Destination}`).toBe(true);
        expect(m.Source).not.toContain(nucleo.raizCursos);
      }
    }
    expect(ejecutarEn(nombre, ['test', '-e', '/repo/.git']).estado).not.toBe(0);
    expect(ejecutarEn(nombre, ['test', '-f', '/repo/package.json']).estado).toBe(0);
    for (const comando of ['campusia-espacio', 'campusia-agente']) {
      expect(ejecutarEn(nombre, ['sh', '-c', `command -v ${comando}`]).estado, comando).toBe(0);
    }
    const version = ejecutarEn(nombre, ['claude', '--version']);
    expect(version.estado).toBe(0);
    expect(version.salida).toMatch(/\d+\.\d+\.\d+/);
  });

  test('cada docente entra a la prueba con su propia identidad firmada', async ({ nucleo }) => {
    const clave = nucleo.ejecutar(['clave-publica']).stdout.trim();
    const yo = await esperarRespuesta(() => enPrueba(profe, id, '/api/yo'), (r) => r.status === 200, ESPERA_RECARGA_MS, 'la prueba responde');
    expect(yo.json.rol).toBe('dueño');
    expect(yo.json.email).toBe(PROFE_AUSTRAL);
    const yo2 = await enPrueba(profe2, id, '/api/yo');
    expect(yo2.status).toBe(200);
    expect(yo2.json.rol).toBe('profesor');
    const eco = await enPrueba(profe2, id, '/espia/eco');
    expect(eco.status).toBe(200);
    const identidad = eco.json.encabezados['x-campus-identidad'];
    expect(firmaValida(identidad, clave)).toBe(true);
    const carga = leerIdentidad(identidad);
    expect(carga.curso).toBe(id);
    expect(carga.usuario).toBe(String(idUsuario(nucleo, PROFE2_AUSTRAL)));
    expect(carga.rol).toBe('profesor');
    expect(eco.json.encabezados.cookie).toBeUndefined();
    expect(eco.encabezados['content-security-policy']).toContain(`frame-ancestors ${nucleo.origen(id)}`);
    expect(eco.encabezados['x-content-type-options']).toBe('nosniff');
  });

  test('la versión de prueba usa sus propios datos y la API para cursos', async ({ nucleo }) => {
    const nueva = await profe.post('/api/clases', { titulo: 'Solo en prueba' }, { sub: `${id}-prueba` });
    expect(nueva.status, nueva.texto).toBe(201);
    const enP = await enPrueba(profe, id, '/api/clases');
    expect(enP.json.map((c: any) => c.titulo)).toContain('Solo en prueba');
    const pub = await getCurso(profe, id, '/api/clases');
    expect(pub.status).toBe(200);
    expect(pub.json.map((c: any) => c.titulo)).not.toContain('Solo en prueba');
    const publicada = await enCurso(profe, id, 'POST', '/api/clases', { titulo: 'Solo publicada' });
    expect(publicada.status).toBe(201);
    expect((await enPrueba(profe, id, '/api/clases')).json.map((c: any) => c.titulo)).not.toContain('Solo publicada');

    const env = entornoEspacio(nucleo, id);
    const base = env.CAMPUSIA_API!.replace(/\/$/, '');
    const yo = await pedirApiCursos(`${base}/api/curso/yo`, env.CAMPUSIA_TOKEN_CURSO!);
    expect(yo.status).toBe(200);
    expect(yo.json.id).toBe(id);
    const ins = await pedirApiCursos(`${base}/api/curso/inscriptos`, env.CAMPUSIA_TOKEN_CURSO!);
    expect(ins.status).toBe(200);
    expect(ins.json.map((x: any) => x.email)).toEqual(expect.arrayContaining([PROFE_AUSTRAL, PROFE2_AUSTRAL]));
    const portada = await enPrueba(profe, id, '/api/portada');
    expect(portada.status).toBe(200);
    expect(portada.json.curso.id ?? portada.json.curso.nombre).toBeTruthy();
  });

  test('el agente sigue la conversación del curso con su sesión completa mientras el espacio sigue encendido', async ({ nucleo }) => {
    const marca = `FIN-DE-LA-RESPUESTA-${Date.now()}`;
    const larga = `${'Expliqué con detalle cada clase del curso y cómo quedó organizada. '.repeat(30)}${marca}`;
    guion(nucleo, 'contexto-uno', [
      { texto: 'Reviso la clase.', herramientas: [{ nombre: 'Write', entrada: { file_path: '/repo/clase-2.md', content: '# Clase 2\n' } }] },
      { texto: larga },
    ]);
    await pedidoOk(profe, id, 'Armá la clase 2 [guion:contexto-uno]');
    guion(nucleo, 'contexto-dos', [{ herramientas: [{ nombre: 'Write', entrada: { file_path: '/repo/clase-3.md', content: '# Clase 3\n' } }] }, { texto: 'Hecho.' }]);
    const desde = nucleo.modelo.pedidos.length;
    const pedido = 'Ahora hacé lo mismo en la clase 3 [guion:contexto-dos]';
    const { respuesta } = await pedidoOk(profe2, id, pedido);
    expect(respuesta.archivos).toEqual([{ ruta: 'clase-3.md', cambio: 'agregado' }]);
    const principal = nucleo.modelo.pedidos.slice(desde).find((p) => p.ruta === '/v1/messages' && Array.isArray(p.json?.tools) && p.json.tools.length > 0);
    expect(principal, 'el agente no consultó al modelo').toBeTruthy();
    const mensajes: any[] = principal!.json.messages;
    const usos = mensajes.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b: any) => b?.type === 'tool_use');
    expect(usos.some((b: any) => b.name === 'Write' && b.input?.file_path === '/repo/clase-2.md'), 'falta la llamada a herramienta de la ejecución anterior').toBe(true);
    const texto = JSON.stringify(mensajes);
    expect(texto, 'la respuesta anterior llegó recortada').toContain(marca);
    expect(texto).toContain('Armá la clase 2');
    expect(texto).toContain(pedido);
  });
});

