import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import crypto from 'node:crypto';
import { crearTestCursos, expect, PROFE_AUSTRAL, ADMIN_AUSTRAL, ALUMNO_AUSTRAL, SIN_MARCA_AUSTRAL, SEMILLA, OWNER } from '../fixtures.ts';
import { levantarNucleo } from '../../comun/nucleo.ts';
import { puertoLibre } from '../../comun/servicios-falsos.ts';
import { docker } from '../lib/docker.ts';
import { reautenticar } from '../../comun/sesion.ts';
import { Cliente } from '../../comun/http.ts';
import { inspeccionar, inspeccionarRed } from '../lib/docker.ts';
import {
  TIEMPO_PRUEBA_DOCKER,
  auditoria,
  contenedorDe,
  crearCurso,
  esperarListo,
  idAleatorio,
  sesion,
} from '../lib/cursos.ts';

const test = crearTestCursos();
test.describe.configure({ timeout: TIEMPO_PRUEBA_DOCKER });

function git(dir: string, ...args: string[]) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

test.describe('crear un curso', () => {
  test('un profesor crea un curso y queda listo con repo, imagen y contenedor', async ({ nucleo }) => {
    const profe = await sesion(nucleo, PROFE_AUSTRAL);
    const id = idAleatorio('so');
    const r = await crearCurso(profe, { id, nombre: '  Sistemas Operativos  ', periodo: '1.er cuatrimestre 2027' });
    expect(r.status, r.texto).toBe(201);
    expect(r.json).toMatchObject({ id, nombre: 'Sistemas Operativos', periodo: '1.er cuatrimestre 2027', rol: 'dueño', version_publicada: null });
    expect(['preparando', 'listo']).toContain(r.json.estado);
    expect(r.json.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
    const curso = await esperarListo(profe, id);
    expect(curso).toMatchObject({ id, estado: 'listo', rol: 'dueño' });
    expect(['encendido', 'apagado', 'encendiendo']).toContain(curso.contenedor);

    const mis = await profe.get('/api/mis-cursos');
    const fila = mis.json.cursos.find((c: any) => c.id === id);
    expect(fila).toMatchObject({ id, nombre: 'Sistemas Operativos', rol: 'dueño' });

    const repo = path.join(nucleo.raizCursos, id);
    expect(fs.existsSync(path.join(repo, '.git'))).toBe(true);
    const main = git(repo, 'rev-parse', 'refs/heads/main');
    expect(git(repo, 'rev-parse', 'refs/heads/prueba')).toBe(main);
    expect(git(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(git(repo, 'remote')).toBe('');
    const archivos = git(repo, 'ls-tree', '-r', '--name-only', 'main').split('\n');
    for (const a of ['package.json', 'Containerfile', 'CLAUDE.md', 'pnpm-lock.yaml']) expect(archivos, a).toContain(a);
    expect(archivos.some((a) => /^vendor\/campusia-sdk-[0-9.]+\.tgz$/.test(a))).toBe(true);
    expect(archivos.some((a) => a.startsWith('node_modules/') || a.startsWith('dist/') || a.includes('/node_modules/'))).toBe(false);
    expect(fs.existsSync(path.join(repo, 'datos'))).toBe(true);

    const info = inspeccionar(contenedorDe(nucleo, id));
    expect(info, 'el contenedor del curso existe').toBeTruthy();
    expect(info.Config.Labels['campusia.prefijo']).toBe(nucleo.prefijo);
    expect(info.Config.Labels['campusia.curso']).toBe(id);
    const imagen = inspeccionar(info.Config.Image);
    expect(imagen?.Config?.Labels?.['campusia.curso']).toBe(id);
    expect(info.Config.Image).toContain(`${nucleo.prefijo}-curso-${id}:${main.slice(0, 12)}`);
  });

  test('el contenedor recibe exactamente las variables del contrato', async ({ nucleo }) => {
    const profe = await sesion(nucleo, PROFE_AUSTRAL);
    const id = idAleatorio('var');
    expect((await crearCurso(profe, { id })).status).toBe(201);
    await esperarListo(profe, id);
    const info = inspeccionar(contenedorDe(nucleo, id));
    const env: Record<string, string> = {};
    for (const e of info.Config.Env as string[]) env[e.slice(0, e.indexOf('='))] = e.slice(e.indexOf('=') + 1);
    const publica = nucleo.ejecutar(['clave-publica']);
    expect(publica.status, publica.stderr).toBe(0);
    expect(publica.stdout.trim()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(env.PORT).toBe('3000');
    expect(env.CAMPUSIA_CURSO).toBe(id);
    expect(env.CAMPUSIA_CLAVE_PUBLICA).toBe(publica.stdout.trim());
    expect(env.CAMPUSIA_DATOS).toBe('/datos');
    expect(env.CAMPUSIA_TOKEN_CURSO).toMatch(/^cct_[A-Za-z0-9_-]{43}$/);
    expect(env.CAMPUSIA_API).toMatch(new RegExp(`^http://[0-9.]+:${nucleo.puertoApiCursos}/?$`));
    const deLaPlataforma = Object.keys(env).filter((k) => k.startsWith('CAMPUSIA_')).sort();
    expect(deLaPlataforma).toEqual(['CAMPUSIA_API', 'CAMPUSIA_CLAVE_PUBLICA', 'CAMPUSIA_CURSO', 'CAMPUSIA_DATOS', 'CAMPUSIA_TOKEN_CURSO']);
    for (const prohibida of ['SESSION_SECRET', 'IDENTIDAD_CLAVE_PRIVADA', 'DOCKER_HOST', 'DATABASE_URL', 'BREVO_API_KEY', 'TURNSTILE_SECRET']) {
      expect(env[prohibida], prohibida).toBeUndefined();
    }
  });

  test('el contenedor corre endurecido en la red interna de los cursos', async ({ nucleo }) => {
    const profe = await sesion(nucleo, PROFE_AUSTRAL);
    const id = idAleatorio('dur');
    expect((await crearCurso(profe, { id })).status).toBe(201);
    await esperarListo(profe, id);
    const info = inspeccionar(contenedorDe(nucleo, id));
    const hc = info.HostConfig;
    expect(hc.Privileged).toBe(false);
    expect(hc.ReadonlyRootfs).toBe(true);
    expect((hc.CapDrop ?? []).map((x: string) => x.toUpperCase())).toContain('ALL');
    expect(hc.CapAdd ?? []).toEqual([]);
    expect((hc.SecurityOpt ?? []).some((s: string) => s.startsWith('no-new-privileges'))).toBe(true);
    expect(hc.Memory).toBeGreaterThan(0);
    expect(hc.Memory).toBeLessThanOrEqual(256 * 1024 * 1024);
    expect(hc.NanoCpus).toBeGreaterThan(0);
    expect(hc.NanoCpus).toBeLessThanOrEqual(500_000_000);
    expect(hc.PidsLimit).toBeGreaterThan(0);
    expect(Object.keys(hc.PortBindings ?? {}).filter((k) => (hc.PortBindings[k] ?? []).length > 0)).toEqual([]);
    expect(Object.keys(info.NetworkSettings.Networks)).toEqual([`${nucleo.prefijo}-cursos`]);
    const red = inspeccionarRed(`${nucleo.prefijo}-cursos`);
    expect(red.Internal).toBe(true);
    expect(red.Options?.['com.docker.network.bridge.enable_icc']).toBe('false');
    expect(red.Labels?.['campusia.prefijo']).toBe(nucleo.prefijo);
    const montajes = (info.Mounts ?? []) as any[];
    expect(montajes.map((m) => m.Destination).sort()).toEqual(['/datos']);
    expect(montajes[0].Source).toBe(path.join(nucleo.raizCursos, id, 'datos'));
    expect(montajes[0].RW).toBe(true);
    expect(Object.keys(hc.Tmpfs ?? {})).toContain('/tmp');
    expect(JSON.stringify(info)).not.toContain('docker.sock');
  });

  test('crear cursos queda en la auditoría y en el panel del administrador', async ({ nucleo }) => {
    const profe = await sesion(nucleo, PROFE_AUSTRAL);
    const id = idAleatorio('aud');
    expect((await crearCurso(profe, { id, nombre: 'Auditado' })).status).toBe(201);
    const ev = auditoria(nucleo, 'curso_creado').filter((e) => String(e.detalle).includes(id));
    expect(ev.length).toBe(1);
    const uni = nucleo.consultar("SELECT id FROM universidades WHERE nombre = 'Universidad Austral'")[0];
    expect(ev[0].universidad_id).toBe(uni.id);
    const admin = await sesion(nucleo, ADMIN_AUSTRAL);
    const cursos = await admin.get('/api/admin/cursos');
    const fila = cursos.json.cursos.find((c: any) => c.id === id);
    expect(fila).toMatchObject({ id, nombre: 'Auditado', profesores: 1, alumnos: 0 });
    expect(fila.dueno.email).toBe(PROFE_AUSTRAL);
    const aud = await admin.get('/api/admin/auditoria?limite=1000');
    expect(aud.json.eventos.some((e: any) => e.accion === 'curso_creado' && e.detalle.includes(id))).toBe(true);
  });

  test('el curso nuevo trae un código de inscripción inactivo', async ({ nucleo }) => {
    const profe = await sesion(nucleo, PROFE_AUSTRAL);
    const id = idAleatorio('cod');
    expect((await crearCurso(profe, { id })).status).toBe(201);
    const c = await profe.get(`/api/cursos/${id}/codigo`);
    expect(c.status).toBe(200);
    expect(c.json.activo).toBe(false);
    expect(c.json.codigo).toMatch(/^COD-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
  });

  test('los cursos sembrados quedan sin repo y el alumno los ve con su estado', async ({ nucleo }) => {
    const alumno = await sesion(nucleo, ALUMNO_AUSTRAL);
    const r = await alumno.get('/api/cursos/redes');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id: 'redes', rol: 'alumno', estado: 'sin_repo', contenedor: 'ninguno', version_publicada: 12 });
  });

  test('clave-publica es estable y no expone la privada', async ({ nucleo }) => {
    const a = nucleo.ejecutar(['clave-publica']).stdout.trim();
    const b = nucleo.ejecutar(['clave-publica']).stdout.trim();
    expect(a).toBe(b);
    const fila = nucleo.consultar("SELECT valor FROM configuracion WHERE clave = 'identidad_clave_privada'")[0];
    expect(fila?.valor).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(fila.valor);
  });
});

function puertoAbierto(host: string, puerto: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port: puerto });
    const t = setTimeout(() => {
      s.destroy();
      resolve(false);
    }, 2000);
    s.once('connect', () => {
      clearTimeout(t);
      s.destroy();
      resolve(true);
    });
    s.once('error', () => {
      clearTimeout(t);
      resolve(false);
    });
  });
}

test.describe('sin proveedor de contenedores', () => {
  test('con PROVEEDOR_CONTENEDORES=ninguno crear un curso responde 503 sin crear nada', async () => {
    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'campusia-cursos-ninguno-'));
    const prefijo = `cia${crypto.randomBytes(4).toString('hex')}`;
    const puertoApi = await puertoLibre();
    const n = await levantarNucleo({
      semilla: SEMILLA,
      owner: OWNER,
      entorno: {
        PROVEEDOR_CONTENEDORES: 'ninguno',
        RAIZ_CURSOS: raiz,
        PREFIJO_CONTENEDORES: prefijo,
        PUERTO_API_CURSOS: String(puertoApi),
        DIRECCION_API_CURSOS: '127.0.0.1',
      },
    });
    try {
      const profe = await sesion(n, PROFE_AUSTRAL);
      const id = idAleatorio('ninguno');
      const r = await crearCurso(profe, { id, nombre: 'Sin contenedores' });
      expect(r.status, r.texto).toBe(503);
      expect(r.json.error).toBe('servicio_no_disponible');
      const sinMarca = await sesion(n, SIN_MARCA_AUSTRAL);
      expect((await crearCurso(sinMarca, { id })).status).toBe(403);
      expect((await crearCurso(profe, { id: 'www' })).status).toBe(400);
      expect(n.consultar('SELECT id FROM cursos WHERE id = ?', id)).toEqual([]);
      expect(n.consultar('SELECT * FROM inscripciones WHERE curso_id = ?', id)).toEqual([]);
      expect(n.consultar('SELECT * FROM codigos_curso WHERE curso_id = ?', id)).toEqual([]);
      expect(n.consultar('SELECT * FROM contenedores')).toEqual([]);
      expect(n.consultar("SELECT * FROM auditoria WHERE accion = 'curso_creado'")).toEqual([]);
      expect((await profe.get(`/api/cursos/${id}`)).status).toBe(404);
      expect((await profe.get('/api/mis-cursos')).json.cursos.some((c: any) => c.id === id)).toBe(false);
      expect(fs.readdirSync(raiz)).toEqual([]);
      expect(await puertoAbierto('127.0.0.1', puertoApi)).toBe(false);
      expect(fs.readFileSync(n.archivoRegistro, 'utf8')).not.toContain('API para cursos escuchando');
      expect(docker(['ps', '-aq', '--filter', `label=campusia.prefijo=${prefijo}`]).salida).toBe('');
      expect(docker(['network', 'ls', '-q', '--filter', `name=^${prefijo}-`]).salida).toBe('');
    } finally {
      await n.cerrar();
      fs.rmSync(raiz, { recursive: true, force: true });
    }
  });
});
