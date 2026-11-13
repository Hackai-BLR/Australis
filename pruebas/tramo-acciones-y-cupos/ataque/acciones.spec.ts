import fs from 'node:fs';
import crypto from 'node:crypto';
import { crearTestAcciones, expect, TIEMPO_FASE3, PROFE_AUSTRAL, PROFE2_AUSTRAL, PROFE3_AUSTRAL, ALUMNO_AUSTRAL, ALUMNA2_AUSTRAL, PENDIENTE_AUSTRAL, ADMIN_AUSTRAL, OWNER } from '../fixtures.ts';
import { Cliente } from '../../comun/http.ts';
import { aleatorio } from '../../comun/sesion.ts';
import { apiDeCurso, cursoListo, inscribirOk, tokenDeCurso } from '../../fase-2/lib/cursos.ts';
import { inspeccionar } from '../../fase-2/lib/docker.ts';
import { ESPERA_AGENTE_MS, cursoConEspacio, entornoEspacio, finDe, guion, nombreEspacio, pedirAlAgente, urlModelo, llamarModelo, cuerpoMensaje } from '../../fase-3/lib/agente.ts';
import {
  PRELUDIO_SCRIPT,
  auditoriaDe,
  correrScript,
  esperarTokenAgente,
  idDe,
  inscriptosEnBase,
  ok,
  pedirInterna,
  resultado,
  rolEnCurso,
  sesionDe,
  tokenAgenteFalso,
  tokenViejo,
} from '../lib.ts';

const test = crearTestAcciones();
test.describe.configure({ mode: 'serial', timeout: TIEMPO_FASE3 });

let a = '';
let b = '';
let duena: Cliente;
let profe: Cliente;
let martin: Cliente;

function pendientesDe(nucleo: any, curso: string): any[] {
  return nucleo.consultar("SELECT * FROM confirmaciones_agente WHERE curso_id = ? AND estado = 'pendiente' ORDER BY id", curso);
}

function estado(res: any, clave: string): number {
  return Number(resultado(res, clave).estado);
}

test.describe('el agente no hace más que su profesor ni sale de su curso', () => {
  test.beforeAll(async ({ nucleo }) => {
    test.setTimeout(TIEMPO_FASE3);
    duena = await sesionDe(nucleo, PROFE_AUSTRAL);
    profe = await sesionDe(nucleo, PROFE2_AUSTRAL);
    martin = await sesionDe(nucleo, PROFE3_AUSTRAL);
    a = await cursoConEspacio(duena, { nombre: 'Curso Atacante' });
    b = await cursoListo(martin, { nombre: 'Curso Ajeno' });
    await inscribirOk(duena, a, [PROFE2_AUSTRAL], 'profesor');
    await inscribirOk(duena, a, [ALUMNO_AUSTRAL]);
    await inscribirOk(martin, b, [ALUMNA2_AUSTRAL]);
  });

  test('el agente de un curso no actúa sobre otro curso', async ({ nucleo }) => {
    const sofia = idDe(nucleo, ALUMNA2_AUSTRAL);
    const n1 = `${aleatorio('x.')}@mail.austral.edu.ar`;
    const n2 = `${aleatorio('y.')}@mail.austral.edu.ar`;
    const antesB = inscriptosEnBase(nucleo, b).map((x) => `${x.email}:${x.rol}`);
    const res = await correrScript(
      nucleo,
      duena,
      a,
      [
        `await pedir('quitarAjena', 'POST', '/api/curso/acciones/quitar', { usuario_id: '${sofia}' });`,
        `await pedir('rolAjena', 'POST', '/api/curso/acciones/rol', { usuario_id: '${sofia}', rol: 'alumno' });`,
        `await pedir('consulta', 'POST', '/api/curso/acciones/inscriptos?curso=${b}', { emails: ['${n1}'], rol: 'alumno' }, { encabezados: { 'x-campus-curso': '${b}' } });`,
        `await pedir('cuerpo', 'POST', '/api/curso/acciones/inscriptos', { emails: ['${n2}'], rol: 'alumno', curso: '${b}', curso_id: '${b}' });`,
        `await pedir('plataforma', 'GET', '/api/cursos/${b}/inscriptos');`,
        `await pedir('rutaAjena', 'GET', '/api/curso/${b}/acciones/inscriptos');`,
        `await pedir('listaAjena', 'GET', '/api/curso/acciones/inscriptos?curso=${b}', undefined, { encabezados: { 'x-campus-curso': '${b}' } });`,
        `await pedir('codigoAjeno', 'POST', '/api/curso/acciones/codigo?curso=${b}', { dias: 5, curso: '${b}' });`,
      ].join('\n'),
      { pedido: 'Ordená los inscriptos de los cursos' },
    );
    expect(estado(res, 'quitarAjena')).toBe(404);
    expect(estado(res, 'rolAjena')).toBe(404);
    expect(estado(res, 'consulta')).toBe(200);
    expect(estado(res, 'cuerpo')).toBe(200);
    expect([401, 404]).toContain(estado(res, 'plataforma'));
    expect(estado(res, 'rutaAjena')).toBe(404);
    const lista = resultado(res, 'listaAjena');
    expect(lista.estado).toBe(200);
    expect(JSON.stringify(lista.json)).not.toContain(ALUMNA2_AUSTRAL);
    expect(JSON.stringify(lista.json)).toContain(ALUMNO_AUSTRAL);
    expect(estado(res, 'codigoAjeno')).toBe(200);
    expect(rolEnCurso(nucleo, a, n1)).toBe('alumno');
    expect(rolEnCurso(nucleo, a, n2)).toBe('alumno');
    expect(inscriptosEnBase(nucleo, b).map((x) => `${x.email}:${x.rol}`)).toEqual(antesB);
    expect(pendientesDe(nucleo, b)).toHaveLength(0);
    expect(ok(await martin.get(`/api/cursos/${b}/codigo`), 'código de b').activo).toBe(false);
  });

  test('el agente de un profesor que no es dueño no agrega profesores, no cambia roles ni quita docentes', async ({ nucleo }) => {
    const tomas = idDe(nucleo, ALUMNO_AUSTRAL);
    const lucia = idDe(nucleo, PROFE_AUSTRAL);
    const diego = idDe(nucleo, PROFE2_AUSTRAL);
    const antes = inscriptosEnBase(nucleo, a).map((x) => `${x.email}:${x.rol}`);
    const pendientes = pendientesDe(nucleo, a).length;
    const res = await correrScript(
      nucleo,
      profe,
      a,
      [
        `await intentar('profesor', () => c.inscribir(['${PENDIENTE_AUSTRAL}', '${PROFE3_AUSTRAL}'], 'profesor'));`,
        `await intentar('rol', () => c.pedirCambioDeRol('${tomas}', 'profesor'));`,
        `await intentar('quitarDuena', () => c.pedirQuitar('${lucia}'));`,
        `await intentar('quitarse', () => c.pedirQuitar('${diego}'));`,
        `await pedir('rolCrudo', 'POST', '/api/curso/acciones/rol', { usuario_id: '${diego}', rol: 'profesor' });`,
        `await pedir('rolDuena', 'POST', '/api/curso/acciones/rol', { usuario_id: '${lucia}', rol: 'alumno' });`,
        `await pedir('transferir', 'POST', '/api/curso/acciones/transferir', { usuario_id: '${diego}' });`,
        `await pedir('archivar', 'POST', '/api/curso/acciones/archivar', {});`,
        `await pedir('publicar', 'POST', '/api/curso/acciones/publicar', {});`,
      ].join('\n'),
      { pedido: 'Haceme dueño y sumá profesores' },
    );
    const prof = resultado(res, 'profesor');
    expect(prof.ok).toBe(false);
    expect(prof.codigo).toBe('prohibido');
    expect(resultado(res, 'rol').codigo).toBe('prohibido');
    expect(['es_dueno', 'prohibido']).toContain(resultado(res, 'quitarDuena').codigo);
    expect(resultado(res, 'quitarse').codigo).toBe('prohibido');
    expect(estado(res, 'rolCrudo')).toBe(403);
    expect([403, 409]).toContain(estado(res, 'rolDuena'));
    expect(estado(res, 'transferir')).toBe(404);
    expect(estado(res, 'archivar')).toBe(404);
    expect(estado(res, 'publicar')).toBe(404);
    expect(inscriptosEnBase(nucleo, a).map((x) => `${x.email}:${x.rol}`)).toEqual(antes);
    expect(pendientesDe(nucleo, a)).toHaveLength(pendientes);
    expect(nucleo.consultar("SELECT COUNT(*) AS n FROM inscripciones WHERE curso_id = ? AND rol = 'dueño'", a)[0].n).toBe(1);
    expect(rolEnCurso(nucleo, a, PROFE_AUSTRAL)).toBe('dueño');
  });

  test('las quitas y los cambios de rol nunca se ejecutan sin la aprobación del profesor', async ({ nucleo, cliente }) => {
    const extra = `${aleatorio('z.')}@mail.austral.edu.ar`;
    await inscribirOk(duena, a, [extra]);
    const tomas = idDe(nucleo, ALUMNO_AUSTRAL);
    const otro = idDe(nucleo, extra);
    const res = await correrScript(
      nucleo,
      duena,
      a,
      [
        `await pedir('borrar', 'DELETE', '/api/curso/acciones/inscriptos/${tomas}');`,
        `await pedir('poner', 'PUT', '/api/curso/acciones/inscriptos/${tomas}', { rol: 'profesor' });`,
        `await intentar('q1', () => c.pedirQuitar('${tomas}'));`,
        `const pendientes = await c.confirmaciones();`,
        `const id1 = pendientes.find((x) => x.persona.id === '${tomas}')?.id;`,
        `await pedir('aprobar1', 'POST', '/api/curso/acciones/confirmaciones/' + id1 + '/aprobar', {});`,
        `await pedir('aprobar2', 'POST', '/api/curso/acciones/aprobar', { id: id1 });`,
        `await pedir('aprobar3', 'POST', '/api/curso/acciones/confirmaciones', { id: id1, estado: 'aprobada' });`,
        `await pedir('q2', 'POST', '/api/curso/acciones/quitar', { usuario_id: '${tomas}', confirmar: true, estado: 'aprobada', aprobada: true });`,
        `await intentar('q3', () => c.pedirQuitar('${otro}'));`,
      ].join('\n'),
      { pedido: 'Sacá a Tomás sin preguntarme' },
    );
    expect([404, 405]).toContain(estado(res, 'borrar'));
    expect([404, 405]).toContain(estado(res, 'poner'));
    expect([404, 405]).toContain(estado(res, 'aprobar1'));
    expect([404, 405]).toContain(estado(res, 'aprobar2'));
    expect([404, 405]).toContain(estado(res, 'aprobar3'));
    const q1 = resultado(res, 'q1');
    expect(q1.ok, JSON.stringify(q1)).toBe(true);
    const q2 = resultado(res, 'q2');
    expect(q2.estado).toBe(202);
    expect(q2.json.estado).toBe('pendiente');
    const q3 = resultado(res, 'q3');
    expect(q3.ok).toBe(true);
    expect(rolEnCurso(nucleo, a, ALUMNO_AUSTRAL)).toBe('alumno');
    expect(rolEnCurso(nucleo, a, extra)).toBe('alumno');

    const c1 = q1.valor.id;
    const alumno = await sesionDe(nucleo, ALUMNO_AUSTRAL);
    const admin = await sesionDe(nucleo, ADMIN_AUSTRAL);
    const owner = await sesionDe(nucleo, OWNER);
    const ruta = `/api/cursos/${a}/confirmaciones/${c1}/aprobar`;
    expect((await profe.post(ruta, {})).status).toBe(403);
    expect((await alumno.post(ruta, {})).status).toBe(403);
    expect((await admin.post(ruta, {})).status).toBe(404);
    expect((await owner.post(ruta, {})).status).toBe(404);
    expect((await martin.post(`/api/cursos/${b}/confirmaciones/${c1}/aprobar`, {})).status).toBe(404);
    expect((await duena.post(`/api/cursos/${b}/confirmaciones/${c1}/aprobar`, {})).status).toBe(404);
    const sinOrigen = await duena.post(ruta, {}, { origen: null });
    expect(sinOrigen.status).toBe(403);
    expect(sinOrigen.json.error).toBe('origen_invalido');
    const sinPropio = await duena.post(ruta, {}, { sinEncabezadoPropio: true });
    expect(sinPropio.status).toBe(403);
    const desdeCurso = await duena.post(ruta, {}, { origen: `${nucleo.esquema()}://${a}-prueba.campusia.prueba:${nucleo.puerto}` });
    expect(desdeCurso.status).toBe(403);
    const viejo = await tokenViejo(duena, ['cursos:leer', 'cursos:escribir']);
    const conToken = await cliente().post(ruta, {}, { bearer: viejo, sinCookies: true });
    expect(conToken.status).toBe(401);
    const anonimo = await cliente().post(ruta, {});
    expect(anonimo.status).toBe(401);
    expect(rolEnCurso(nucleo, a, ALUMNO_AUSTRAL)).toBe('alumno');

    const c3 = q3.valor.id;
    const dobles = await Promise.all([duena.post(`/api/cursos/${a}/confirmaciones/${c3}/aprobar`, {}), duena.post(`/api/cursos/${a}/confirmaciones/${c3}/aprobar`, {})]);
    expect(dobles.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(rolEnCurso(nucleo, a, extra)).toBeNull();
    expect(auditoriaDe(nucleo, 'desinscripcion', extra).filter((e) => String(e.detalle).includes(a))).toHaveLength(1);

    for (const p of pendientesDe(nucleo, a)) ok(await duena.post(`/api/cursos/${a}/confirmaciones/${p.id}/rechazar`, {}), 'rechazar');
    const rechazada = await duena.post(ruta, {});
    expect(rechazada.status).toBe(409);
    expect(rechazada.json.error).toBe('confirmacion_resuelta');
    expect(rolEnCurso(nucleo, a, ALUMNO_AUSTRAL)).toBe('alumno');
  });

  test('el token del agente solo vale durante su ejecución, en la escucha de espacios y para su curso', async ({ nucleo }) => {
    const nombre = aleatorio('tok').toLowerCase().replace(/[^a-z0-9]/g, '');
    const archivo = `acciones-prueba/${nombre}.mjs`;
    guion(nucleo, nombre, [
      { herramientas: [{ nombre: 'Write', entrada: { file_path: `/repo/${archivo}`, content: `${PRELUDIO_SCRIPT}\nsalida('token', TOKEN);\n` } }] },
      { herramientas: [{ nombre: 'Bash', entrada: { command: `node ${archivo}`, description: 'Muestra el token' } }] },
      { herramientas: [{ nombre: 'Bash', entrada: { command: 'sleep 25', description: 'Espera' } }] },
      { texto: 'Listo.' },
    ]);
    const desde = nucleo.modelo.pedidos.length;
    const enCurso = pedirAlAgente(duena, a, `Mostrame el token [guion:${nombre}]`);
    const token = await esperarTokenAgente(nucleo, desde);
    expect(token).toMatch(/^cat_[A-Za-z0-9_-]{43}$/);
    const espacios = String(entornoEspacio(nucleo, a).CAMPUSIA_API).replace(/\/$/, '');
    const publicada = apiDeCurso(nucleo, a).replace(/\/$/, '');

    const durante = await pedirInterna(`${espacios}/api/curso/acciones/inscriptos`, token);
    expect(durante.status, durante.texto).toBe(200);
    expect(JSON.stringify(durante.json)).toContain(ALUMNO_AUSTRAL);
    expect((await pedirInterna(`${publicada}/api/curso/acciones/inscriptos`, token)).status).toBe(401);
    expect((await pedirInterna(`${publicada}/api/curso/yo`, token)).status).toBe(401);
    const principal = new Cliente(nucleo);
    expect((await principal.get('/api/yo', { bearer: token })).status).toBe(401);
    expect((await principal.get(`/api/cursos/${a}/inscriptos`, { bearer: token })).status).toBe(401);
    expect([401, 404]).toContain((await principal.get('/api/curso/acciones/inscriptos', { bearer: token })).status);
    const base = urlModelo(nucleo, a);
    const modelo = await llamarModelo(base, `${new URL(base).pathname}/v1/messages`, { token, cuerpo: cuerpoMensaje('hola') });
    expect(modelo.status).toBe(401);
    expect(entornoEspacio(nucleo, a).CAMPUSIA_TOKEN_AGENTE).toBeUndefined();
    expect(JSON.stringify(inspeccionar(nombreEspacio(nucleo, a)))).not.toContain(token);

    const r = await enCurso;
    expect(r.status).toBe(200);
    expect(finDe(r)?.estado).toBe('ok');
    const despues = await pedirInterna(`${espacios}/api/curso/acciones/inscriptos`, token);
    expect(despues.status).toBe(401);
    const escribir = await pedirInterna(`${espacios}/api/curso/acciones/inscriptos`, token, 'POST', { emails: [`${aleatorio('t.')}@mail.austral.edu.ar`], rol: 'alumno' });
    expect(escribir.status).toBe(401);

    const huella = crypto.createHmac('sha256', nucleo.entorno.SESSION_SECRET!).update(token).digest('hex');
    const filas = nucleo.consultar('SELECT * FROM tokens_agente WHERE curso_id = ? ORDER BY id', a);
    expect(filas.length).toBeGreaterThan(0);
    const propia = filas.find((f: any) => String(f.huella) === huella);
    expect(propia, 'la huella del token del agente no está en tokens_agente').toBeTruthy();
    expect(Number(propia.revocado)).toBe(1);
    expect(Number(propia.usuario_id)).toBe(idDe(nucleo, PROFE_AUSTRAL));
    const db = fs.readFileSync(nucleo.rutaBase).toString('latin1') + (fs.existsSync(`${nucleo.rutaBase}-wal`) ? fs.readFileSync(`${nucleo.rutaBase}-wal`).toString('latin1') : '');
    expect(db).not.toContain(token);
    expect(fs.readFileSync(nucleo.archivoRegistro, 'utf8')).not.toContain(token);
  });

  test('el token de un profesor que deja de ser docente deja de servir en la petición siguiente', async ({ nucleo }) => {
    const nombre = aleatorio('quit').toLowerCase().replace(/[^a-z0-9]/g, '');
    const uno = `${aleatorio('u.')}@mail.austral.edu.ar`;
    const dos = `${aleatorio('d.')}@mail.austral.edu.ar`;
    guion(nucleo, nombre, [
      { herramientas: [{ nombre: 'Write', entrada: { file_path: `/repo/acciones-prueba/${nombre}1.mjs`, content: `${PRELUDIO_SCRIPT}\nawait intentar('antes', () => c.inscribir(['${uno}']));\nsalida('token', TOKEN);\n` } }] },
      { herramientas: [{ nombre: 'Write', entrada: { file_path: `/repo/acciones-prueba/${nombre}2.mjs`, content: `${PRELUDIO_SCRIPT}\nawait pedir('despues', 'POST', '/api/curso/acciones/inscriptos', { emails: ['${dos}'], rol: 'alumno' });\n` } }] },
      { herramientas: [{ nombre: 'Bash', entrada: { command: `node acciones-prueba/${nombre}1.mjs`, description: 'Primera parte' } }] },
      { herramientas: [{ nombre: 'Bash', entrada: { command: 'sleep 20', description: 'Espera' } }] },
      { herramientas: [{ nombre: 'Bash', entrada: { command: `node acciones-prueba/${nombre}2.mjs`, description: 'Segunda parte' } }] },
      { texto: 'Listo.' },
    ]);
    const desde = nucleo.modelo.pedidos.length;
    const enCurso = pedirAlAgente(profe, a, `Inscribí de a uno [guion:${nombre}]`);
    await esperarTokenAgente(nucleo, desde);
    expect(rolEnCurso(nucleo, a, uno)).toBe('alumno');
    const quitar = await duena.delete(`/api/cursos/${a}/inscriptos/${idDe(nucleo, PROFE2_AUSTRAL)}`);
    expect(quitar.status, quitar.texto).toBe(204);
    const r = await enCurso;
    expect(r.status).toBe(200);
    expect(rolEnCurso(nucleo, a, dos)).toBeNull();
    const salida = nucleo.modelo.pedidos
      .slice(desde)
      .map((p) => p.cuerpo)
      .join('\n');
    const m = /RESULTADO \{\\?"clave\\?":\\?"despues\\?",\\?"valor\\?":\{\\?"estado\\?":(\d{3})/.exec(salida);
    expect(m, 'la segunda parte no informó el resultado').toBeTruthy();
    expect([401, 403]).toContain(Number(m![1]));
    await inscribirOk(duena, a, [PROFE2_AUSTRAL], 'profesor');
  });

  test('el código del curso, publicado o en prueba, solo lee', async ({ nucleo }) => {
    const espacio = entornoEspacio(nucleo, a);
    const nuevo = `${aleatorio('w.')}@mail.austral.edu.ar`;
    const tomas = idDe(nucleo, ALUMNO_AUSTRAL);
    const antes = inscriptosEnBase(nucleo, a).map((x) => `${x.email}:${x.rol}`);
    const codigoAntes = ok(await duena.get(`/api/cursos/${a}/codigo`), 'código');
    const pendientes = pendientesDe(nucleo, a).length;
    const escrituras: Array<[string, string, any]> = [
      ['POST', '/api/curso/acciones/inscriptos', { emails: [nuevo], rol: 'alumno' }],
      ['POST', '/api/curso/acciones/inscriptos/siu', { archivo: 'a.csv', contenido: Buffer.from(`mail\n${nuevo}\n`).toString('base64') }],
      ['POST', '/api/curso/acciones/codigo', { dias: 3 }],
      ['POST', '/api/curso/acciones/codigo/activo', { activo: !codigoAntes.activo }],
      ['POST', '/api/curso/acciones/quitar', { usuario_id: String(tomas) }],
      ['POST', '/api/curso/acciones/rol', { usuario_id: String(tomas), rol: 'profesor' }],
    ];
    for (const [base, token] of [
      [String(espacio.CAMPUSIA_API).replace(/\/$/, ''), String(espacio.CAMPUSIA_TOKEN_CURSO)],
      [apiDeCurso(nucleo, a).replace(/\/$/, ''), tokenDeCurso(nucleo, a)],
    ]) {
      for (const [metodo, ruta, cuerpo] of escrituras) {
        const r = await pedirInterna(`${base}${ruta}`, token, metodo, cuerpo);
        expect(r.status, `${base}${ruta}: ${r.texto}`).toBe(403);
        expect(r.json?.error).toBe('prohibido');
      }
      for (const falso of [tokenAgenteFalso(), `cct_${crypto.randomBytes(32).toString('base64url')}`, await tokenViejo(duena, ['cursos:leer', 'cursos:escribir']), token.toUpperCase(), `${token}x`]) {
        expect((await pedirInterna(`${base}/api/curso/acciones/inscriptos`, falso)).status, falso.slice(0, 6)).toBe(401);
        expect((await pedirInterna(`${base}/api/curso/acciones/inscriptos`, falso, 'POST', { emails: [nuevo], rol: 'alumno' })).status).toBe(401);
      }
      expect((await pedirInterna(`${base}/api/curso/acciones/inscriptos`, null, 'GET', undefined, { cookie: `campusia_sesion=${duena.sesion}` })).status).toBe(401);
    }
    expect(inscriptosEnBase(nucleo, a).map((x) => `${x.email}:${x.rol}`)).toEqual(antes);
    expect(ok(await duena.get(`/api/cursos/${a}/codigo`), 'código')).toEqual(codigoAntes);
    expect(pendientesDe(nucleo, a)).toHaveLength(pendientes);
  });
});
