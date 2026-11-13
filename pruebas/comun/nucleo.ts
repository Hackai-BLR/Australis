import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BINARIO, DOMINIO, INTERFAZ_DIST } from './entorno.ts';
import {
  BREVO_CLAVE_PRUEBA,
  TURNSTILE_SECRET,
  TURNSTILE_SITE_KEY,
  brevoFalso,
  puertoLibre,
  turnstileFalso,
  type ServicioFalso,
} from './servicios-falsos.ts';

export const MODO_CODIGO = { REAUTENTICACION_MODO: 'codigo' };

export interface OpcionesNucleo {
  semilla?: string | null;
  owner?: string | null;
  produccion?: boolean;
  brevo?: boolean;
  turnstileCaido?: boolean;
  limitesReales?: boolean;
  entorno?: Record<string, string>;
}

export interface Mail {
  para: string;
  asunto: string;
  texto: string;
  html?: string;
  fecha?: string;
}

export interface ResultadoComando {
  status: number | null;
  stdout: string;
  stderr: string;
}

export class Nucleo {
  proceso: ChildProcess | null = null;
  constructor(
    public dir: string,
    public puerto: number,
    public entorno: Record<string, string>,
    public turnstile: ServicioFalso,
    public brevo: ServicioFalso | null,
    public produccion: boolean,
  ) {}

  get rutaBase() {
    return path.join(this.dir, 'campusia.db');
  }

  get modoReautenticacion(): 'sesion' | 'codigo' {
    return this.entorno.REAUTENTICACION_MODO === 'codigo' ? 'codigo' : 'sesion';
  }

  get archivoEmail() {
    return path.join(this.dir, 'mails.jsonl');
  }

  get archivoRegistro() {
    return path.join(this.dir, 'nucleo.log');
  }

  host(sub?: string) {
    return sub ? `${sub}.${DOMINIO}:${this.puerto}` : `${DOMINIO}:${this.puerto}`;
  }

  esquema() {
    return this.produccion ? 'https' : 'http';
  }

  origen(sub?: string) {
    return `${this.esquema()}://${this.host(sub)}`;
  }

  url(sub?: string, ruta = '/') {
    return `http://${this.host(sub)}${ruta}`;
  }

  mails(): Mail[] {
    if (!fs.existsSync(this.archivoEmail)) return [];
    return fs
      .readFileSync(this.archivoEmail, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as Mail);
  }

  cantidadMails() {
    return this.mails().length;
  }

  ejecutar(args: string[], entornoExtra: Record<string, string> = {}): ResultadoComando {
    const r = spawnSync(BINARIO, args, {
      env: { ...process.env, ...this.entorno, ...entornoExtra },
      encoding: 'utf8',
      timeout: 30_000,
    });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }

  base(): DatabaseSync {
    return new DatabaseSync(this.rutaBase);
  }

  consultar(sql: string, ...params: any[]): any[] {
    const db = this.base();
    try {
      return db.prepare(sql).all(...params);
    } finally {
      db.close();
    }
  }

  async iniciar() {
    const salida = fs.openSync(this.archivoRegistro, 'a');
    this.proceso = spawn(BINARIO, [], {
      env: { ...process.env, ...this.entorno },
      stdio: ['ignore', salida, salida],
    });
    const limite = Date.now() + 30_000;
    while (Date.now() < limite) {
      if (this.proceso.exitCode !== null) break;
      const ok = await new Promise<boolean>((resolve) => {
        const req = http.request(
          { host: '127.0.0.1', port: this.puerto, path: '/salud', method: 'GET', headers: { host: this.host() }, timeout: 1000 },
          (res) => {
            res.resume();
            resolve(res.statusCode === 200);
          },
        );
        req.on('error', () => resolve(false));
        req.on('timeout', () => {
          req.destroy();
          resolve(false);
        });
        req.end();
      });
      if (ok) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    const registro = fs.existsSync(this.archivoRegistro) ? fs.readFileSync(this.archivoRegistro, 'utf8') : '';
    await this.detener();
    throw new Error(`El núcleo no respondió en /salud.\n${registro.slice(-4000)}`);
  }

  async detener() {
    if (this.proceso && this.proceso.exitCode === null) {
      const p = this.proceso;
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          p.kill('SIGKILL');
          resolve();
        }, 5000);
        p.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
        p.kill('SIGTERM');
      });
    }
    this.proceso = null;
  }

  async cerrar() {
    await this.detener();
    await this.turnstile.cerrar();
    if (this.brevo) await this.brevo.cerrar();
  }
}

export function entornoBase(dir: string, puerto: number, turnstileUrl: string): Record<string, string> {
  return {
    PUERTO: String(puerto),
    DIRECCION: '127.0.0.1',
    ENTORNO: 'desarrollo',
    DATABASE_URL: `sqlite://${path.join(dir, 'campusia.db')}`,
    DOMINIO_BASE: DOMINIO,
    PROVEEDOR_EMAIL: 'archivo',
    ARCHIVO_EMAIL: path.join(dir, 'mails.jsonl'),
    EMAIL_FROM: `no-responder@${DOMINIO}`,
    EMAIL_FROM_NAME: 'Campus IA',
    TURNSTILE_SITE_KEY,
    TURNSTILE_SECRET,
    TURNSTILE_VERIFY_URL: turnstileUrl,
    SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
    INTERFAZ_DIR: INTERFAZ_DIST,
    ENCABEZADO_IP_CLIENTE: 'CF-Connecting-IP',
    PROVEEDOR_CONTENEDORES: 'ninguno',
    RAIZ_ARCHIVOS: path.join(dir, 'archivos'),
    DIR_RESPALDOS: path.join(dir, 'respaldos'),
  };
}

export async function levantarNucleo(op: OpcionesNucleo = {}): Promise<Nucleo> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campusia-prueba-'));
  const puerto = await puertoLibre();
  const turnstile = await turnstileFalso();
  const brevo = op.brevo ? await brevoFalso() : null;
  let turnstileUrl = turnstile.url;
  if (op.turnstileCaido) turnstileUrl = `http://127.0.0.1:${await puertoLibre()}/turnstile/v0/siteverify`;
  const entorno = entornoBase(dir, puerto, turnstileUrl);
  if (!op.limitesReales) entorno.LIMITE_CODIGOS_EMAIL = '1000';
  if (op.produccion) entorno.ENTORNO = 'produccion';
  if (brevo) {
    entorno.PROVEEDOR_EMAIL = 'brevo';
    entorno.BREVO_API_KEY = BREVO_CLAVE_PRUEBA;
    entorno.BREVO_API_URL = brevo.url;
    delete entorno.ARCHIVO_EMAIL;
  }
  Object.assign(entorno, op.entorno ?? {});
  const nucleo = new Nucleo(dir, puerto, entorno, turnstile, brevo, !!op.produccion);
  const migrar = nucleo.ejecutar(['migrar']);
  if (migrar.status !== 0) throw new Error(`campusia-nucleo migrar falló: ${migrar.stderr}${migrar.stdout}`);
  if (op.semilla) {
    const r = nucleo.ejecutar(['sembrar', op.semilla]);
    if (r.status !== 0) throw new Error(`campusia-nucleo sembrar falló: ${r.stderr}${r.stdout}`);
  }
  if (op.owner) {
    const r = nucleo.ejecutar(['crear-owner', op.owner]);
    if (r.status !== 0) throw new Error(`campusia-nucleo crear-owner falló: ${r.stderr}${r.stdout}`);
  }
  await nucleo.iniciar();
  return nucleo;
}
