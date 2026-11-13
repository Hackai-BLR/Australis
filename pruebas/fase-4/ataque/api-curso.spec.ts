import fs from 'node:fs';
import { crearTestCursos, expect } from '../../fase-2/fixtures.ts';
import { nuevaSemilla } from '../../fase-2/lib/identidad.ts';
import { inspeccionar } from '../../fase-2/lib/docker.ts';
import { TIEMPO_PRUEBA_DOCKER, apiDeCurso, contenedorDe, cursoListo, idAleatorio, inscribirOk, tokenDeCurso } from '../../fase-2/lib/cursos.ts';
import { ALUMNA_REDES, ALUMNO_REDES, DUENO_REDES, PROFE_REDES, SIN_CURSOS } from '../fixtures.ts';
import { idUsuario, sesion, verEntregas, verHistorial } from '../lib/datos.ts';
import { apiCurso, identidad, rutaSubidaCurso } from '../lib/api-curso.ts';

const CLAVE = nuevaSemilla();
const OTRA_CLAVE = nuevaSemilla();
const test = crearTestCursos({ entorno: { IDENTIDAD_CLAVE_PRIVADA: CLAVE.semilla } });
test.describe.configure({ mode: 'serial', timeout: TIEMPO_PRUEBA_DOCKER });

let a = '';
let b = '';
let api = '';
let tokenA = '';
let tokenB = '';
let entregaAlumna = 0;
let archivoAlumna = '';
let archivoB = '';
const usados: string[] = [];

function id(nucleo: any, curso: string, email: string, rol: string, ajustes = {}) {
  const v = identidad(nucleo, CLAVE.privada, curso, email, rol, ajustes);
  usados.push(v);
  return v;
}

test.describe('API de datos para cursos', () => {
  test.beforeAll(async ({ nucleo }) => {
    test.setTimeout(TIEMPO_PRUEBA_DOCKER);
    const dueno = await sesion(nucleo, DUENO_REDES);
    a = idAleatorio('ata');
    b = idAleatorio('atb');
    await cursoListo(dueno, { id: a });
    await cursoListo(dueno, { id: b });
    await inscribirOk(dueno, a, [PROFE_REDES], 'profesor');
    await inscribirOk(dueno, a, [ALUMNO_REDES, ALUMNA_REDES]);
    await inscribirOk(dueno, b, [ALUMNO_REDES]);
    api = apiDeCurso(nucleo, a);
    tokenA = tokenDeCurso(nucleo, a);
    tokenB = tokenDeCurso(nucleo, b);
    expect(tokenA).toMatch(/^cct_/);
    const subida = await apiCurso(api, 'POST', rutaSubidaCurso('privado.txt'), {
      token: tokenA,
      identidad: id(nucleo, a, ALUMNA_REDES, 'alumno'),
      cuerpo: Buffer.from('archivo privado de Sofía'),
    });
    expect(subida.status, subida.texto).toBe(201);
    archivoAlumna = subida.json.id;
    const e = await apiCurso(api, 'POST', '/api/curso/entregas', {
      token: tokenA,
      identidad: id(nucleo, a, ALUMNA_REDES, 'alumno'),
      cuerpo: { actividad: 'tp1', texto: 'entrega privada de Sofía', archivo_id: archivoAlumna },
    });
    expect(e.status, e.texto).toBe(201);
    entregaAlumna = e.json.id;
    const n = await apiCurso(api, 'POST', '/api/curso/notas', {
      token: tokenA,
      identidad: id(nucleo, a, PROFE_REDES, 'profesor'),
      cuerpo: { usuario_id: String(idUsuario(nucleo, ALUMNA_REDES)), actividad: 'tp1', valor: '7' },
    });
    expect(n.status, n.texto).toBe(201);
    const sb = await apiCurso(apiDeCurso(nucleo, b), 'POST', rutaSubidaCurso('de-b.txt'), {
      token: tokenB,
      identidad: id(nucleo, b, ALUMNO_REDES, 'alumno'),
      cuerpo: Buffer.from('archivo del curso B'),
    });
    expect(sb.status, sb.texto).toBe(201);
    archivoB = sb.json.id;
  });

  const RUTAS: Array<[string, string, any?]> = [
    ['GET', '/api/curso/entregas'],
    ['POST', '/api/curso/entregas', { actividad: 'tp1', texto: 'x' }],
    ['GET', '/api/curso/notas'],
    ['GET', '/api/curso/notas/historial'],
    ['POST', '/api/curso/notas', { usuario_id: '1', actividad: 'tp1', valor: '10' }],
    ['GET', '/api/curso/archivos'],
    ['POST', '/api/curso/archivos?nombre=x.txt', Buffer.from('x')],
  ];

  test('sin token del curso, con un token inventado o personal, nada responde', async ({ nucleo }) => {
    const alumno = await sesion(nucleo, ALUMNO_REDES);
    const ident = id(nucleo, a, ALUMNO_REDES, 'alumno');
    for (const token of [null, 'cct_' + 'A'.repeat(43), tokenA.slice(0, -1) + (tokenA.endsWith('A') ? 'B' : 'A'), alumno.sesion!]) {
      for (const [metodo, ruta, cuerpo] of RUTAS) {
        const r = await apiCurso(api, metodo, ruta, { token, identidad: ident, cuerpo });
        expect(r.status, `${metodo} ${ruta}`).toBe(401);
        expect(r.json?.error).toBe('no_autenticado');
      }
    }
  });

  test('sin una identidad válida firmada por la plataforma, el token del curso no alcanza', async ({ nucleo }) => {
    const ahora = Math.floor(Date.now() / 1000);
    const falsas = [
      null,
      'basura',
      identidad(nucleo, OTRA_CLAVE.privada, a, ALUMNO_REDES, 'alumno'),
      id(nucleo, a, ALUMNO_REDES, 'alumno', { emitido: ahora - 300, vence: ahora - 240 }),
      id(nucleo, a, ALUMNO_REDES, 'alumno', { emitido: ahora + 120, vence: ahora + 180 }),
      id(nucleo, a, ALUMNO_REDES, 'alumno', { emitido: ahora, vence: ahora + 3600 }),
      id(nucleo, a, ALUMNO_REDES, 'alumno', { v: 2 }),
      id(nucleo, b, ALUMNO_REDES, 'alumno'),
    ];
    const valida = id(nucleo, a, ALUMNO_REDES, 'alumno');
    const [carga, firma] = valida.split('.');
    const alterada = JSON.parse(Buffer.from(carga, 'base64url').toString('utf8'));
    alterada.usuario = String(idUsuario(nucleo, ALUMNA_REDES));
    falsas.push(`${Buffer.from(JSON.stringify(alterada)).toString('base64url')}.${firma}`);
    for (const ident of falsas) {
      for (const [metodo, ruta, cuerpo] of RUTAS) {
        const r = await apiCurso(api, metodo, ruta, { token: tokenA, identidad: ident, cuerpo });
        expect(r.status, `${metodo} ${ruta} con ${String(ident).slice(0, 30)}`).toBe(401);
        expect(r.json?.error).toBe('identidad_invalida');
        expect(r.texto).not.toContain('Sofía');
      }
    }
  });

  test('una identidad válida de alguien no inscripto no sirve', async ({ nucleo }) => {
    const ident = id(nucleo, a, SIN_CURSOS, 'alumno');
    for (const [metodo, ruta, cuerpo] of RUTAS) {
      const r = await apiCurso(api, metodo, ruta, { token: tokenA, identidad: ident, cuerpo });
      expect(r.status, `${metodo} ${ruta}`).toBe(403);
      expect(r.json?.error).toBe('prohibido');
    }
  });

  test('con la identidad de un alumno el curso no ve datos de otro ni pone notas, aunque la identidad diga otro rol', async ({ nucleo }) => {
    const alumno = id(nucleo, a, ALUMNO_REDES, 'alumno');
    const disfrazado = id(nucleo, a, ALUMNO_REDES, 'profesor');
    const e = await apiCurso(api, 'GET', '/api/curso/entregas', { token: tokenA, identidad: alumno });
    expect(e.status).toBe(200);
    expect(e.texto).not.toContain('Sofía');
    const f = await apiCurso(api, 'GET', `/api/curso/entregas?usuario=${idUsuario(nucleo, ALUMNA_REDES)}`, { token: tokenA, identidad: alumno });
    expect(f.status).toBe(403);
    const n = await apiCurso(api, 'GET', '/api/curso/notas', { token: tokenA, identidad: alumno });
    expect(n.status).toBe(200);
    expect(n.json.notas).toEqual([]);
    for (const ident of [alumno, disfrazado]) {
      const h = await apiCurso(api, 'GET', '/api/curso/notas/historial', { token: tokenA, identidad: ident });
      expect(h.status).toBe(403);
      const p = await apiCurso(api, 'POST', '/api/curso/notas', {
        token: tokenA,
        identidad: ident,
        cuerpo: { usuario_id: String(idUsuario(nucleo, ALUMNO_REDES)), actividad: 'tp1', valor: '10' },
      });
      expect(p.status).toBe(403);
      const d = await apiCurso(api, 'GET', `/api/curso/archivos/${archivoAlumna}`, { token: tokenA, identidad: ident });
      expect(d.status).toBe(404);
      expect(d.texto).not.toContain('privado');
      const l = await apiCurso(api, 'GET', '/api/curso/archivos', { token: tokenA, identidad: ident });
      expect(l.json.archivos.map((x: any) => x.id)).not.toContain(archivoAlumna);
    }
    expect(nucleo.consultar("SELECT COUNT(*) AS n FROM notas WHERE valor = '10'")[0].n).toBe(0);
  });

  test('el curso no puede alterar ni borrar una entrega o una nota registradas', async ({ nucleo }) => {
    const profe = id(nucleo, a, PROFE_REDES, 'profesor');
    const duenoId = id(nucleo, a, DUENO_REDES, 'dueño');
    for (const ident of [profe, duenoId]) {
      for (const metodo of ['PUT', 'PATCH', 'DELETE']) {
        for (const ruta of [`/api/curso/entregas/${entregaAlumna}`, '/api/curso/entregas', '/api/curso/notas/1', '/api/curso/notas', `/api/curso/archivos/${archivoAlumna}`]) {
          const r = await apiCurso(api, metodo, ruta, { token: tokenA, identidad: ident, cuerpo: { texto: 'alterada', valor: '1' } });
          expect(r.status, `${metodo} ${ruta}`).toBe(404);
        }
      }
      const pisar = await apiCurso(api, 'POST', '/api/curso/entregas', {
        token: tokenA,
        identidad: ident,
        cuerpo: { id: entregaAlumna, actividad: 'tp1', texto: 'alterada' },
      });
      if (pisar.status === 201) expect(pisar.json.id).not.toBe(entregaAlumna);
    }
    const dueno = await sesion(nucleo, DUENO_REDES);
    const e = (await verEntregas(dueno, a)).json.entregas.find((x: any) => x.id === entregaAlumna);
    expect(e.texto).toBe('entrega privada de Sofía');
    expect(e.usuario.email).toBe(ALUMNA_REDES);
    const h = await verHistorial(dueno, a);
    expect(h.json.notas.map((x: any) => x.valor)).toEqual(['7']);
  });

  test('el curso no entrega en nombre de otro ni elige la hora ni el origen', async ({ nucleo }) => {
    const antes = Date.now();
    const r = await apiCurso(api, 'POST', '/api/curso/entregas', {
      token: tokenA,
      identidad: id(nucleo, a, ALUMNO_REDES, 'alumno'),
      cuerpo: {
        actividad: 'tp3',
        texto: 'falsificada',
        usuario_id: String(idUsuario(nucleo, ALUMNA_REDES)),
        fecha: '2020-01-01T00:00:00Z',
        via: 'plataforma',
      },
    });
    if (r.status === 201) {
      expect(r.json.usuario.email).toBe(ALUMNO_REDES);
      expect(r.json.via).toBe('curso');
      expect(Date.parse(r.json.fecha)).toBeGreaterThanOrEqual(antes - 2000);
    } else {
      expect(r.status).toBe(400);
    }
    const profeIdent = id(nucleo, a, PROFE_REDES, 'profesor');
    const docente = await apiCurso(api, 'POST', '/api/curso/entregas', {
      token: tokenA,
      identidad: profeIdent,
      cuerpo: { actividad: 'tp3', texto: 'en nombre de Sofía', usuario_id: String(idUsuario(nucleo, ALUMNA_REDES)) },
    });
    if (docente.status === 201) expect(docente.json.usuario.email).toBe(PROFE_REDES);
    const alumna = await sesion(nucleo, ALUMNA_REDES);
    expect((await verEntregas(alumna, a, { actividad: 'tp3' })).json.entregas).toEqual([]);
  });

  test('el token de un curso no llega a los datos de otro curso', async ({ nucleo }) => {
    const identA = id(nucleo, a, ALUMNO_REDES, 'alumno');
    const identB = id(nucleo, b, ALUMNO_REDES, 'alumno');
    const r1 = await apiCurso(api, 'GET', `/api/curso/archivos/${archivoB}`, { token: tokenA, identidad: identA });
    expect(r1.status).toBe(404);
    expect(r1.texto).not.toContain('curso B');
    const r2 = await apiCurso(api, 'GET', '/api/curso/entregas', { token: tokenA, identidad: identB });
    expect(r2.status).toBe(401);
    const r3 = await apiCurso(api, 'GET', `/api/curso/archivos/${archivoAlumna}`, { token: tokenB, identidad: identB });
    expect(r3.status).toBe(404);
    const profeB = id(nucleo, b, DUENO_REDES, 'dueño');
    const r4 = await apiCurso(apiDeCurso(nucleo, b), 'GET', '/api/curso/entregas', { token: tokenB, identidad: profeB });
    expect(r4.status).toBe(200);
    expect(r4.texto).not.toContain('Sofía');
  });

  test('las rutas de datos para cursos no existen en la escucha principal y el token del curso no sirve en la plataforma', async ({ nucleo, cliente }) => {
    const c = cliente();
    const ident = id(nucleo, a, ALUMNO_REDES, 'alumno');
    for (const ruta of ['/api/curso/entregas', '/api/curso/archivos', '/api/curso/notas']) {
      const r = await c.get(ruta, { bearer: tokenA, encabezados: { 'x-campus-identidad': ident } });
      expect(r.status, ruta).toBe(404);
    }
    for (const ruta of [`/api/cursos/${a}/entregas`, `/api/cursos/${a}/notas`, `/api/cursos/${a}/archivos`, `/api/cursos/${a}/archivos/${archivoAlumna}`]) {
      const r = await c.get(ruta, { bearer: tokenA, encabezados: { 'x-campus-identidad': ident } });
      expect(r.status, ruta).toBe(401);
    }
  });

  test('los archivos y la base de la plataforma no están al alcance del contenedor del curso', async ({ nucleo }) => {
    const info = inspeccionar(contenedorDe(nucleo, a));
    expect(info).not.toBeNull();
    const fuentes = (info.Mounts ?? []).map((m: any) => String(m.Source)).concat(info.HostConfig?.Binds ?? []);
    const raiz = nucleo.entorno.RAIZ_ARCHIVOS;
    for (const f of fuentes) {
      expect(f.startsWith(raiz) || raiz.startsWith(f.split(':')[0]), f).toBe(false);
      expect(f).not.toContain(nucleo.dir);
    }
    const env = (info.Config?.Env ?? []).join('\n');
    expect(env).not.toContain('RAIZ_ARCHIVOS');
    expect(env).not.toContain(raiz);
  });

  test('el registro del núcleo no guarda tokens de curso ni identidades', async ({ nucleo }) => {
    const registro = fs.readFileSync(nucleo.archivoRegistro, 'utf8');
    expect(registro).not.toContain(tokenA);
    expect(registro).not.toContain(tokenB);
    for (const u of usados) expect(registro).not.toContain(u.split('.')[1]);
    expect(registro).not.toContain(CLAVE.semilla);
  });
});
