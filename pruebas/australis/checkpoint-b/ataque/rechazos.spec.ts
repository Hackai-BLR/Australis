import { test, expect } from '@playwright/test';
import {
  buscarEnContenedor,
  cargaDeIdentidad,
  cantidadMails,
  entornoDelContenedor,
  entrar,
  firmarIdentidad,
  inspeccionar,
  llamarAlIntermediario,
  llamarAlModeloFalso,
  mailsEnviados,
  origenDe,
  paginaDe,
  pausa,
  pedirAlBackend,
  pedidosAlModelo,
  reiniciarModelo,
  semillaAjena,
  Sesion,
} from '../../comun/escenario-b.ts';
import { ADMIN_AUSTRAL, ADMIN_DEMO, ALUMNO_AUSTRAL, OWNER, PROFE2_AUSTRAL, PROFE_AUSTRAL } from '../../comun/datos-b.ts';
import { estadoB } from '../../comun/pila-b.ts';

let profe: Sesion;
let admin: Sesion;
let campus = { nucleo: 0, australis: 0 };

async function idDe(correo: string): Promise<number> {
  const r = await admin.get('/api/admin/personas');
  expect(r.estado, r.texto).toBe(200);
  return r.json.personas.find((p: any) => p.email === correo).id;
}

function encabezado(correo: string, sobrescribir: Record<string, unknown> = {}, semilla = estadoB().semilla) {
  return { 'x-campus-identidad': firmarIdentidad(cargaDeIdentidad(correo, sobrescribir), semilla) };
}

test.beforeAll(async () => {
  profe = await entrar(PROFE_AUSTRAL);
  admin = await entrar(ADMIN_AUSTRAL);
  const creado = await profe.post('/api/cursos-modulos', { nombre: 'Campus de los rechazos' });
  expect(creado.estado, creado.texto).toBe(201);
  campus = { nucleo: creado.json.campus_id, australis: creado.json.campus_externo };
});

test.describe('encabezado de identidad falso o vencido', () => {
  test('con la clave del núcleo y una carga válida, Australis acepta el encabezado: la prueba de control', async () => {
    const r = await pedirAlBackend('GET', '/api/auth/me', encabezado('control@austral.edu.ar'));
    expect(r.estado, r.texto).toBe(200);
  });

  const casos: Array<[string, () => Record<string, string>]> = [
    ['firmado con una clave que no es la del núcleo', () => encabezado('falso@austral.edu.ar', { rol: 'dueño', administrador: true }, semillaAjena())],
    ['vencido', () => {
      const ahora = Math.floor(Date.now() / 1000);
      return encabezado('viejo@austral.edu.ar', { emitido: ahora - 200, vence: ahora - 100 });
    }],
    ['para otro destinatario', () => encabezado('otro@austral.edu.ar', { curso: 'un-curso' })],
    ['de otra versión', () => encabezado('version@austral.edu.ar', { v: 2 })],
    ['emitido en el futuro', () => {
      const ahora = Math.floor(Date.now() / 1000);
      return encabezado('futuro@austral.edu.ar', { emitido: ahora + 300, vence: ahora + 360 });
    }],
    ['con una vigencia mayor a la permitida', () => {
      const ahora = Math.floor(Date.now() / 1000);
      return encabezado('largo@austral.edu.ar', { emitido: ahora, vence: ahora + 600 });
    }],
    ['con la carga cambiada después de firmar', () => {
      const bueno = encabezado('chico@austral.edu.ar')['x-campus-identidad'];
      const ajeno = encabezado('jefe@austral.edu.ar', { rol: 'dueño', administrador: true })['x-campus-identidad'];
      return { 'x-campus-identidad': `${ajeno.split('.')[0]}.${bueno.split('.')[1]}` };
    }],
    ['sin firma', () => ({ 'x-campus-identidad': encabezado('sinfirma@austral.edu.ar')['x-campus-identidad'].split('.')[0] })],
    ['que no es un encabezado', () => ({ 'x-campus-identidad': 'basura' })],
    ['vacío', () => ({ 'x-campus-identidad': '' })],
  ];

  for (const [nombre, armar] of casos) {
    test(`un encabezado ${nombre} se rechaza con 401 y no crea ninguna cuenta`, async () => {
      const r = await pedirAlBackend('GET', '/api/auth/me', armar());
      expect(r.estado, r.texto).toBe(401);
      const r2 = await pedirAlBackend('GET', `/api/campuses/${campus.australis}`, armar());
      expect(r2.estado).toBe(401);
    });
  }

  test('un encabezado falso mandado por el navegador al núcleo no cambia quién es la persona', async () => {
    const alumno = await entrar(ALUMNO_AUSTRAL);
    const r = await alumno.campus('GET', '/api/auth/me', undefined, { encabezados: encabezado('jefe@austral.edu.ar', { rol: 'dueño', administrador: true }, semillaAjena()) });
    expect(r.estado, r.texto).toBe(200);
    expect(r.json.email).toBe(ALUMNO_AUSTRAL);
    expect(r.json.role).not.toBe('secretary');
    const campusAjeno = await alumno.campus('GET', `/api/campuses/${campus.australis}`, undefined, { encabezados: encabezado(OWNER, { rol: 'dueño', administrador: true }, estadoB().semilla) });
    expect([403, 404]).toContain(campusAjeno.estado);
  });

  test('sin sesión en el núcleo, un encabezado perfecto no abre nada', async () => {
    const anonimo = await entrar(ALUMNO_AUSTRAL);
    const r = await anonimo.campus('GET', '/api/auth/me', undefined, { sinCookies: true, encabezados: encabezado(OWNER, { rol: 'dueño', administrador: true }) });
    expect(r.estado).toBe(401);
  });
});

test.describe('un administrador de otra universidad', () => {
  test('no abre, no lista y no modifica el campus de otra universidad por la API', async () => {
    const ajeno = await entrar(ADMIN_DEMO);
    const yo = await ajeno.campus('GET', '/api/auth/me');
    expect(yo.estado, yo.texto).toBe(200);
    expect(yo.json.role).toBe('secretary');

    const abrir = await ajeno.campus('GET', `/api/campuses/${campus.australis}`);
    expect(abrir.estado, abrir.texto).toBe(403);
    const documento = await ajeno.campus('PUT', `/api/campuses/${campus.australis}/document`, { version: 1, document: {} });
    expect(documento.estado, documento.texto).toBe(403);
    const importar = await ajeno.campus('POST', `/api/campuses/${campus.australis}/roster/imports`, { text: 'Intruso,intruso@demo.edu.ar' });
    expect(importar.estado, importar.texto).toBe(403);

    const lista = await ajeno.campus('GET', '/api/campuses');
    expect(lista.estado, lista.texto).toBe(200);
    expect(lista.json.map((c: any) => c.id)).not.toContain(campus.australis);

    const personas = await ajeno.campus('GET', '/api/users');
    expect(personas.estado, personas.texto).toBe(200);
    expect(personas.texto).not.toContain('austral.edu.ar');
  });

  test('no abre el campus de otra universidad en la interfaz', async ({ browser }) => {
    const ajeno = await entrar(ADMIN_DEMO);
    const { ctx, pagina } = await paginaDe(browser, ajeno);
    await pagina.goto(`${origenDe('campus')}/campuses/${campus.australis}`);
    await expect(pagina.getByText('No tenés acceso a esta sección')).toBeVisible();
    await expect(pagina.getByText('Campus de los rechazos')).toHaveCount(0);
    await pagina.goto(`${origenDe('campus')}/`);
    await expect(pagina.getByRole('heading', { name: 'Campus' }).first()).toBeVisible();
    await expect(pagina.getByText('No se pudieron cargar los campus.')).toHaveCount(0);
    await expect(pagina.getByText('Campus de los rechazos')).toHaveCount(0);
    await ctx.close();
  });
});

test.describe('un pedido que llega a Australis sin pasar por el núcleo', () => {
  test('el backend sin encabezado responde 401, también para la salud de cada campus y la cookie vieja de contraseña', async () => {
    for (const ruta of ['/api/auth/me', `/api/campuses/${campus.australis}`, '/api/campuses']) {
      const r = await pedirAlBackend('GET', ruta);
      expect(r.estado, ruta).toBe(401);
    }
    const conCookie = await pedirAlBackend('GET', '/api/auth/me', { cookie: 'australis_session=cualquiera' });
    expect(conCookie.estado).toBe(401);
  });

  test('en modo encabezado no existen las rutas de contraseña ni de invitaciones', async () => {
    const login = await pedirAlBackend('POST', '/api/auth/login', {}, { email: PROFE_AUSTRAL, password: 'x' });
    expect(login.estado).toBe(404);
    const alta = await pedirAlBackend('POST', '/api/users', encabezado(OWNER, { rol: 'dueño' }), { email: 'nuevo@austral.edu.ar', full_name: 'Nuevo', role: 'professor' });
    expect(alta.estado).toBe(404);
  });

  test('solo el núcleo está publicado: el frontend de Australis no tiene puertos y el backend queda en la interfaz local', async () => {
    const e = estadoB();
    const frontend = JSON.parse(inspeccionar(e.frontend))[0].NetworkSettings.Ports ?? {};
    expect(Object.values(frontend).filter(Boolean)).toHaveLength(0);
    const backend = JSON.parse(inspeccionar(e.backend))[0].NetworkSettings.Ports ?? {};
    for (const enlaces of Object.values(backend) as any[]) for (const b of enlaces ?? []) expect(b.HostIp).toBe('127.0.0.1');
  });

  test('en el núcleo, el campus no responde sin sesión y rechaza un pedido que modifica desde otro origen', async () => {
    const anonimo = await entrar(ALUMNO_AUSTRAL);
    const sinSesion = await anonimo.campus('GET', '/api/auth/me', undefined, { sinCookies: true });
    expect(sinSesion.estado).toBe(401);
    const otroOrigen = await profe.campus('POST', `/api/campuses/${campus.australis}/ai/proposals`, { instruction: 'Agregá la bibliografía' }, { origen: 'http://sitio-malo.example' });
    expect(otroOrigen.estado).toBe(403);
    const sinOrigen = await profe.campus('POST', `/api/campuses/${campus.australis}/ai/proposals`, { instruction: 'Agregá la bibliografía' }, { origen: null });
    expect(sinOrigen.estado).toBe(403);
  });
});

test.describe('una persona inhabilitada en el núcleo', () => {
  test('pierde el acceso a Australis y al modelo, y vuelve a tenerlo al reactivarla', async () => {
    const e = estadoB();
    const segundo = await entrar(PROFE2_AUSTRAL);
    const propio = await segundo.post('/api/cursos-modulos', { nombre: 'Campus del segundo profesor' });
    expect(propio.estado, propio.texto).toBe(201);
    const australis = propio.json.campus_externo;
    expect((await segundo.campus('GET', `/api/campuses/${australis}`)).estado).toBe(200);
    expect(llamarAlIntermediario(e.nucleo, e.tokenModelo, PROFE2_AUSTRAL)).toBe(200);

    const id = await idDe(PROFE2_AUSTRAL);
    const suspendida = await admin.post(`/api/admin/personas/${id}/suspender`, { motivo: 'prueba del checkpoint B' });
    expect(suspendida.estado, suspendida.texto).toBe(200);

    const campusSuspendido = await segundo.campus('GET', `/api/campuses/${australis}`);
    expect(campusSuspendido.estado).toBe(403);
    const propuesta = await segundo.campus('POST', `/api/campuses/${australis}/ai/proposals`, { instruction: 'Agregá una semana sobre ética' });
    expect(propuesta.estado).toBe(403);
    expect(llamarAlIntermediario(e.nucleo, e.tokenModelo, PROFE2_AUSTRAL)).toBe(401);
    const desde = cantidadMails();
    const nuevoIngreso = await new Sesion().post('/api/login/codigo', { email: PROFE2_AUSTRAL });
    expect(nuevoIngreso.estado).toBeLessThan(500);
    await pausa(1500);
    const llegoCodigo = mailsEnviados().slice(desde).some((m) => m.para === PROFE2_AUSTRAL);
    expect(llegoCodigo, 'una cuenta suspendida no recibe código').toBe(false);

    const reactivada = await admin.post(`/api/admin/personas/${id}/reactivar`, {});
    expect(reactivada.estado, reactivada.texto).toBe(200);
    expect((await segundo.campus('GET', `/api/campuses/${australis}`)).estado, 'la sesión vieja no revive').toBe(401);
    const nuevaSesion = await entrar(PROFE2_AUSTRAL);
    expect((await nuevaSesion.campus('GET', `/api/campuses/${australis}`)).estado).toBe(200);
    expect(llamarAlIntermediario(e.nucleo, e.tokenModelo, PROFE2_AUSTRAL)).toBe(200);
  });

  test('el intermediario solo atiende a profesores y administradores activos con universidad', async () => {
    const e = estadoB();
    expect(llamarAlIntermediario(e.nucleo, e.tokenModelo, ALUMNO_AUSTRAL)).toBe(401);
    expect(llamarAlIntermediario(e.nucleo, e.tokenModelo, 'nadie@austral.edu.ar')).toBe(401);
    expect(llamarAlIntermediario(e.nucleo, e.tokenModelo, null)).toBe(401);
    expect(llamarAlIntermediario(e.nucleo, `cmt_${'A'.repeat(43)}`, PROFE_AUSTRAL)).toBe(401);
    expect(llamarAlIntermediario(e.nucleo, null, PROFE_AUSTRAL)).toBe(401);
  });

  test('el token de Australis solo no sirve: hace falta la identidad firmada por el núcleo de esa misma persona', async () => {
    const e = estadoB();
    expect(llamarAlIntermediario(e.nucleo, e.tokenModelo, PROFE_AUSTRAL, null)).toBe(401);
    expect(llamarAlIntermediario(e.nucleo, e.tokenModelo, PROFE_AUSTRAL, PROFE2_AUSTRAL)).toBe(401);
    expect(llamarAlIntermediario(e.nucleo, e.tokenModelo, null, PROFE_AUSTRAL)).toBe(200);
  });
});

test.describe('un profesor sin cupo de tokens en el núcleo', () => {
  test('recibe 429 con el mensaje del cupo, el modelo no recibe nada y la reserva diaria de Australis se devuelve', async () => {
    const id = await idDe(PROFE_AUSTRAL);
    const uso = async () => (await profe.campus('GET', `/api/campuses/${campus.australis}/ai/usage`)).json;
    const antes = await uso();
    const cupo = await admin.put(`/api/admin/cupos/profesores/${id}`, { tokens: 0 });
    expect(cupo.estado, cupo.texto).toBe(200);
    try {
      await reiniciarModelo();
      const r = await profe.campus('POST', `/api/campuses/${campus.australis}/ai/proposals`, { instruction: 'Agregá una semana sobre ética' });
      expect(r.estado, r.texto).toBe(429);
      expect(r.texto.toLowerCase()).toContain('cupo');
      expect(await pedidosAlModelo()).toHaveLength(0);
      const despues = await uso();
      expect(despues.used_today).toBe(antes.used_today);
    } finally {
      const restablecido = await admin.put(`/api/admin/cupos/profesores/${id}`, { tokens: null });
      expect(restablecido.estado, restablecido.texto).toBe(200);
    }
    const otra = await profe.campus('POST', `/api/campuses/${campus.australis}/ai/proposals`, { instruction: 'Agregá la bibliografía' });
    expect(otra.estado, otra.texto).toBe(201);
    await profe.campus('POST', `/api/campuses/${campus.australis}/ai/proposals/${otra.json.id}/reject`, {});
  });
});

test.describe('la credencial del modelo no se puede leer desde Australis', () => {
  test('ni el entorno ni los archivos de Australis la contienen, y la respuesta de una propuesta tampoco', async () => {
    const e = estadoB();
    const propuesta = await profe.campus('POST', `/api/campuses/${campus.australis}/ai/proposals`, { instruction: 'Agregá una semana sobre ética' });
    expect(propuesta.estado, propuesta.texto).toBe(201);
    await profe.campus('POST', `/api/campuses/${campus.australis}/ai/proposals/${propuesta.json.id}/reject`, {});
    expect(propuesta.texto).not.toContain(e.claveModelo);
    for (const contenedor of [e.backend, e.frontend]) {
      expect(inspeccionar(contenedor)).not.toContain(e.claveModelo);
      expect(entornoDelContenedor(contenedor)).not.toContain(e.claveModelo);
    }
    expect(buscarEnContenedor(e.backend, e.claveModelo, ['/data', '/uploads', '/usr/local/bin'])).toBe('');
    const usoRegistrado = await profe.campus('GET', `/api/campuses/${campus.australis}/ai/usage`);
    expect(usoRegistrado.texto).not.toContain(e.claveModelo);
    expect(inspeccionar(e.nucleo)).toContain(e.claveModelo);
  });

  test('el token que tiene Australis no es una credencial del modelo: solo sirve en el intermediario y con una persona', async () => {
    const e = estadoB();
    expect(e.tokenModelo.startsWith('cmt_')).toBe(true);
    expect(e.tokenModelo).not.toBe(e.claveModelo);
    await reiniciarModelo();
    const propuesta = await profe.campus('POST', `/api/campuses/${campus.australis}/ai/proposals`, { instruction: 'Agregá la bibliografía' });
    expect(propuesta.estado, propuesta.texto).toBe(201);
    await profe.campus('POST', `/api/campuses/${campus.australis}/ai/proposals/${propuesta.json.id}/reject`, {});
    const pedidos = await pedidosAlModelo();
    expect(pedidos).toHaveLength(1);
    expect(pedidos[0].claveRecibida).toBe(e.claveModelo);
    expect(pedidos[0].autorizacion).toBeNull();
    expect(llamarAlModeloFalso(e.falsos, e.tokenModelo)).toBe(401);
  });
});

test.describe('la IA no cambia notas, asistencia ni registros cerrados', () => {
  test('pedirle una nota devuelve una propuesta vacía, sin operaciones, y la IA no tiene ninguna herramienta sobre registros', async () => {
    await reiniciarModelo();
    const r = await profe.campus('POST', `/api/campuses/${campus.australis}/ai/proposals`, { instruction: 'Cambiá la nota de Alumna Uno a 10 y borrá su asistencia' });
    expect(r.estado, r.texto).toBe(201);
    expect(r.json.status).toBe('empty');
    expect(r.json.ops).toEqual([]);
    const pedidos = await pedidosAlModelo();
    expect(pedidos).toHaveLength(1);
    for (const herramienta of pedidos[0].herramientas) expect(herramienta).not.toMatch(/grade|nota|attendance|asistencia|record|acta/i);
    const notas = await profe.campus('GET', `/api/campuses/${campus.australis}/gradebook`);
    expect(notas.estado, notas.texto).toBe(200);
    const auditoria = await profe.campus('GET', `/api/campuses/${campus.australis}/gradebook/audit`);
    expect(auditoria.estado, auditoria.texto).toBe(200);
    expect(JSON.stringify(auditoria.json)).toBe(JSON.stringify([]));
  });

  test('un alumno no puede pedirle cambios a la IA', async () => {
    const alumno = await entrar(ALUMNO_AUSTRAL);
    const r = await alumno.campus('POST', `/api/campuses/${campus.australis}/ai/proposals`, { instruction: 'Agregá la bibliografía' });
    expect([403, 404]).toContain(r.estado);
  });
});
