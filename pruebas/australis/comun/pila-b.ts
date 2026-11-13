import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DOMINIO, SEMILLA, OWNER } from './datos-b.ts';
import { RAIZ_REPO } from './pila.ts';

export const ESTADO_B = path.join(os.tmpdir(), 'australis-pruebas-pila-b.json');
export const ETIQUETA = 'australis.pruebas=checkpoint-b';
export const CLAVE_MODELO_FALSA = 'sk-ant-clave-falsa-de-prueba';
export const TURNSTILE_SECRET = '1x0000000000000000000000000000000AA';

export type EstadoPilaB = {
  id: string;
  puerto: number;
  puertoBackend: number;
  puertoControl: number;
  nucleo: string;
  backend: string;
  frontend: string;
  falsos: string;
  contenedores: string[];
  redes: string[];
  volumenes: string[];
  prefijo: string;
  tokenModelo: string;
  clavePublica: string;
  semilla: string;
};

function docker(args: string[], opciones: { silencioso?: boolean; entrada?: string } = {}): string {
  return execFileSync('docker', args, {
    cwd: RAIZ_REPO,
    encoding: 'utf8',
    input: opciones.entrada,
    stdio: [opciones.entrada === undefined ? 'ignore' : 'pipe', 'pipe', opciones.silencioso ? 'pipe' : 'inherit'],
  }).trim();
}

export function registroDe(contenedor: string, lineas = 60): string {
  try {
    return execFileSync('docker', ['logs', '--tail', String(lineas), contenedor], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e: any) {
    return String(e?.stderr ?? e);
  }
}

function puertoLibre(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });
}

function responde(opciones: http.RequestOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request({ ...opciones, timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

async function esperar(nombre: string, contenedor: string, comprobar: () => Promise<boolean>, segundos = 120) {
  const limite = Date.now() + segundos * 1000;
  while (Date.now() < limite) {
    if (await comprobar()) return;
    const corriendo = docker(['inspect', '-f', '{{.State.Running}}', contenedor], { silencioso: true });
    if (corriendo !== 'true') throw new Error(`${nombre} se detuvo.\n${registroDe(contenedor)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${nombre} no respondió a tiempo.\n${registroDe(contenedor)}`);
}

function claveDeIdentidad() {
  const semilla = crypto.randomBytes(32);
  const privada = crypto.createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), semilla]),
    format: 'der',
    type: 'pkcs8',
  });
  const spki = crypto.createPublicKey(privada).export({ format: 'der', type: 'spki' }) as Buffer;
  return { semilla: semilla.toString('base64url'), publica: spki.subarray(spki.length - 32).toString('base64url') };
}

export function construirImagenes() {
  if (process.env.AUSTRALIS_SIN_COMPILAR === '1') return;
  docker(['build', '-t', 'australis-b-nucleo', '-f', 'pruebas/australis/imagenes/nucleo.Dockerfile', '.']);
  docker(['build', '-t', 'australis-b-falsos', '-f', 'pruebas/australis/imagenes/falsos.Dockerfile', 'pruebas/australis/imagenes']);
  docker(['build', '-t', 'australis-b-backend', './backend']);
  docker(['build', '-t', 'australis-b-frontend', './frontend']);
}

export async function levantarPilaB(): Promise<EstadoPilaB> {
  const id = crypto.randomBytes(4).toString('hex');
  const prefijo = `ab${id}`;
  const red = `${prefijo}-red`;
  const redCursos = `${prefijo}-cursos`;
  const redEspacios = `${prefijo}-espacios`;
  const volDatos = `${prefijo}-datos`;
  const volCursos = `${prefijo}-volcursos`;
  const nucleo = `${prefijo}-nucleo`;
  const backend = `${prefijo}-backend`;
  const frontend = `${prefijo}-frontend`;
  const falsos = `${prefijo}-falsos`;
  const { semilla, publica } = claveDeIdentidad();
  const tokenModelo = `cmt_${crypto.randomBytes(32).toString('base64url')}`;
  const puerto = await puertoLibre();

  construirImagenes();

  const estado: EstadoPilaB = {
    id,
    puerto,
    puertoBackend: 0,
    puertoControl: 0,
    nucleo,
    backend,
    frontend,
    falsos,
    contenedores: [nucleo, backend, frontend, falsos],
    redes: [red, redCursos, redEspacios],
    volumenes: [volDatos, volCursos],
    prefijo,
    tokenModelo,
    clavePublica: publica,
    semilla,
  };
  fs.writeFileSync(ESTADO_B, JSON.stringify(estado));

  try {
    docker(['network', 'create', '--label', ETIQUETA, red], { silencioso: true });
    docker(['network', 'create', '--internal', '--label', ETIQUETA, redCursos], { silencioso: true });
    docker(['network', 'create', '--internal', '--label', ETIQUETA, redEspacios], { silencioso: true });
    docker(['volume', 'create', '--label', ETIQUETA, volDatos], { silencioso: true });
    docker(['volume', 'create', '--label', ETIQUETA, volCursos], { silencioso: true });
    const raizDocker = docker(['info', '--format', '{{.DockerRootDir}}'], { silencioso: true });
    const raizCursos = `${raizDocker}/volumes/${volCursos}/_data`;

    docker([
      'run', '-d', '--name', falsos, '--network', red, '--network-alias', 'falsos', '--label', ETIQUETA,
      '-p', '127.0.0.1::9000',
      '-e', `CLAVE_MODELO=${CLAVE_MODELO_FALSA}`,
      '-e', `TURNSTILE_SECRET=${TURNSTILE_SECRET}`,
      'australis-b-falsos',
    ]);
    estado.puertoControl = Number(docker(['port', falsos, '9000/tcp']).split('\n')[0].split(':').pop());

    const entornoNucleo: Record<string, string> = {
      PUERTO: String(puerto),
      DIRECCION: '0.0.0.0',
      ENTORNO: 'desarrollo',
      DATABASE_URL: 'sqlite:///datos/campusia.db',
      DOMINIO_BASE: DOMINIO,
      PROVEEDOR_EMAIL: 'archivo',
      ARCHIVO_EMAIL: '/datos/mails.jsonl',
      EMAIL_FROM: `no-responder@${DOMINIO}`,
      EMAIL_FROM_NAME: 'Campus IA',
      TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
      TURNSTILE_SECRET,
      TURNSTILE_VERIFY_URL: 'http://falsos:8090/turnstile/v0/siteverify',
      SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
      ENCABEZADO_IP_CLIENTE: 'CF-Connecting-IP',
      PROXIES_CONFIABLES: '0.0.0.0/0',
      LIMITE_CODIGOS_EMAIL: '1000',
      LIMITE_CODIGOS_IP: '100000',
      RAIZ_ARCHIVOS: '/datos/archivos',
      DIR_RESPALDOS: '/datos/respaldos',
      IDENTIDAD_CLAVE_PRIVADA: semilla,
      AUSTRALIS_URL: 'http://frontend',
      AUSTRALIS_TOKEN_MODELO: tokenModelo,
      PROVEEDOR_MODELO: 'api',
      ANTHROPIC_API_KEY: CLAVE_MODELO_FALSA,
      MODELO_DESTINO: 'http://falsos:8091',
      PROVEEDOR_CONTENEDORES: 'docker',
      CONTENEDORES_CLI: 'docker',
      CONTENEDORES_SIN_ROOT: 'no',
      PREFIJO_CONTENEDORES: prefijo,
      RED_CURSOS: redCursos,
      RAIZ_CURSOS: raizCursos,
      PUERTO_API_CURSOS: '8081',
      DIRECCION_API_CURSOS: '0.0.0.0',
      URL_API_CURSOS: 'http://nucleo-cursos:8081',
      RED_ESPACIOS: redEspacios,
      RAIZ_ESPACIOS: '/datos/espacios',
      PUERTO_ESPACIOS: '8082',
      DIRECCION_ESPACIOS: '0.0.0.0',
      URL_ESPACIOS: 'http://nucleo:8082',
      ARRANQUE_CURSO_SEG: '120',
    };
    const variables = Object.entries(entornoNucleo).flatMap(([k, v]) => ['-e', `${k}=${v}`]);

    const unaVez = (args: string[], entrada?: string) =>
      docker(
        ['run', '--rm', '-i', '--network', red, '--label', ETIQUETA, '-v', `${volDatos}:/datos`, ...variables, 'australis-b-nucleo', ...args],
        { entrada: entrada ?? '' },
      );
    unaVez(['migrar']);
    unaVez(['sembrar', '/dev/stdin'], JSON.stringify(SEMILLA));
    unaVez(['crear-owner', OWNER]);

    docker([
      'create', '--name', nucleo, '--network', red, '--network-alias', 'nucleo', '--label', ETIQUETA,
      '-p', `127.0.0.1:${puerto}:${puerto}`,
      '-v', `${volDatos}:/datos`,
      '-v', `${volCursos}:${raizCursos}`,
      '-v', '/var/run/docker.sock:/var/run/docker.sock',
      ...variables,
      'australis-b-nucleo',
    ], { silencioso: true });
    docker(['network', 'connect', '--alias', 'nucleo-cursos', redCursos, nucleo], { silencioso: true });
    docker(['network', 'connect', '--alias', 'nucleo', redEspacios, nucleo], { silencioso: true });

    docker([
      'run', '-d', '--name', backend, '--network', red, '--network-alias', 'backend', '--label', ETIQUETA,
      '-p', '127.0.0.1::8080',
      '-e', 'AUTH_MODE=header',
      '-e', `IDENTITY_PUBLIC_KEY=${publica}`,
      '-e', 'AI_PROVIDER=proxy',
      '-e', 'AI_PROXY_URL=http://nucleo:8082',
      '-e', `AI_API_KEY=${tokenModelo}`,
      '-e', 'ZOOM_PROVIDER=placeholder',
      '-e', 'COOKIE_SECURE=false',
      'australis-b-backend',
    ]);
    estado.puertoBackend = Number(docker(['port', backend, '8080/tcp']).split('\n')[0].split(':').pop());
    docker([
      'run', '-d', '--name', frontend, '--network', red, '--network-alias', 'frontend', '--label', ETIQUETA,
      'australis-b-frontend',
    ]);
    docker(['start', nucleo], { silencioso: true });
    fs.writeFileSync(ESTADO_B, JSON.stringify(estado));

    await esperar('El modelo falso', falsos, () => responde({ host: '127.0.0.1', port: estado.puertoControl, path: '/salud' }), 30);
    await esperar('El backend de Australis', backend, () => responde({ host: '127.0.0.1', port: estado.puertoBackend, path: '/api/health' }), 60);
    await esperar('El núcleo', nucleo, () => responde({ host: '127.0.0.1', port: puerto, path: '/salud', headers: { host: `${DOMINIO}:${puerto}` } }), 90);
  } catch (e) {
    bajarPilaB(estado, true);
    throw e;
  }
  return estado;
}

export function bajarPilaB(estado?: EstadoPilaB, conservarRegistro = false) {
  const actual = estado ?? (fs.existsSync(ESTADO_B) ? (JSON.parse(fs.readFileSync(ESTADO_B, 'utf8')) as EstadoPilaB) : null);
  if (!actual) return;
  const cursos = docker(['ps', '-aq', '--filter', `label=campusia.prefijo=${actual.prefijo}`], { silencioso: true }).split('\n').filter(Boolean);
  for (const c of [...actual.contenedores, ...cursos]) {
    try {
      docker(['rm', '-f', '-v', c], { silencioso: true });
    } catch {}
  }
  const imagenes = docker(['images', '-q', '--filter', `label=campusia.prefijo=${actual.prefijo}`], { silencioso: true }).split('\n').filter(Boolean);
  for (const i of imagenes) {
    try {
      docker(['rmi', '-f', i], { silencioso: true });
    } catch {}
  }
  for (const r of actual.redes) {
    try {
      docker(['network', 'rm', r], { silencioso: true });
    } catch {}
  }
  for (const v of actual.volumenes) {
    try {
      docker(['volume', 'rm', '-f', v], { silencioso: true });
    } catch {}
  }
  if (!conservarRegistro) fs.rmSync(ESTADO_B, { force: true });
}

export function bajarTodasLasPilasB() {
  const contenedores = docker(['ps', '-aq', '--filter', `label=${ETIQUETA}`], { silencioso: true }).split('\n').filter(Boolean);
  for (const c of contenedores) {
    try {
      docker(['rm', '-f', '-v', c], { silencioso: true });
    } catch {}
  }
  const redes = docker(['network', 'ls', '-q', '--filter', `label=${ETIQUETA}`], { silencioso: true }).split('\n').filter(Boolean);
  for (const r of redes) {
    try {
      docker(['network', 'rm', r], { silencioso: true });
    } catch {}
  }
  const volumenes = docker(['volume', 'ls', '-q', '--filter', `label=${ETIQUETA}`], { silencioso: true }).split('\n').filter(Boolean);
  for (const v of volumenes) {
    try {
      docker(['volume', 'rm', '-f', v], { silencioso: true });
    } catch {}
  }
  fs.rmSync(ESTADO_B, { force: true });
}

export function estadoB(): EstadoPilaB {
  return JSON.parse(fs.readFileSync(ESTADO_B, 'utf8')) as EstadoPilaB;
}
