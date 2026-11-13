import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect } from '@playwright/test';
import { Cliente } from '../../comun/http.ts';
import { levantarNucleo, type Nucleo } from '../../comun/nucleo.ts';
import { BREVO_CLAVE_PRUEBA } from '../../comun/servicios-falsos.ts';
import { aleatorio, pedirCodigo } from '../../comun/sesion.ts';
import { OWNER, SEMILLA } from '../fixtures.ts';
import { ejecutarSql, fila } from '../lib.ts';

const DEMORA_MS = 450;

interface MailLento {
  url: string;
  fallar: boolean;
  pedidos: number;
  cerrar: () => Promise<void>;
}

async function mailLento(): Promise<MailLento> {
  const estado: MailLento = { url: '', fallar: false, pedidos: 0, cerrar: async () => {} };
  const servidor = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      estado.pedidos++;
      setTimeout(() => {
        res.writeHead(estado.fallar ? 500 : 201, { 'content-type': 'application/json' });
        res.end(JSON.stringify(estado.fallar ? { error: 'falla simulada' } : { messageId: `<lento-${Date.now()}@brevo>` }));
      }, DEMORA_MS);
    });
  });
  await new Promise<void>((r) => servidor.listen(0, '127.0.0.1', () => r()));
  estado.url = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}/v3/smtp/email`;
  estado.cerrar = () => new Promise<void>((r) => servidor.close(() => r()));
  return estado;
}

async function medir(nucleo: Nucleo, email: string) {
  const inicio = Date.now();
  const r = await pedirCodigo(new Cliente(nucleo), email);
  return { r, ms: Date.now() - inicio };
}

function mediana(v: number[]) {
  const o = [...v].sort((a, b) => a - b);
  return o[Math.floor(o.length / 2)];
}

test.describe.configure({ mode: 'serial' });

test.describe('el pedido de código no revela la suspensión por el tiempo ni por la caída del proveedor', () => {
  let nucleo: Nucleo;
  let mail: MailLento;
  let suspendida: string;
  let deshabilitada: string;

  test.beforeAll(async () => {
    mail = await mailLento();
    nucleo = await levantarNucleo({
      semilla: SEMILLA,
      owner: OWNER,
      entorno: { PROVEEDOR_EMAIL: 'brevo', BREVO_API_KEY: BREVO_CLAVE_PRUEBA, BREVO_API_URL: mail.url },
    });
    const ahora = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    suspendida = `${aleatorio('susp')}@austral.edu.ar`;
    ejecutarSql(
      nucleo,
      "INSERT INTO usuarios (email, nombre, universidad_id, creado_en, suspendida_en) VALUES (?, 'Cuenta Suspendida', (SELECT id FROM universidades WHERE nombre = 'Universidad Austral'), ?, ?)",
      suspendida,
      ahora,
      ahora,
    );
    deshabilitada = `${aleatorio('desh')}@demo.edu.ar`;
    ejecutarSql(
      nucleo,
      "INSERT INTO usuarios (email, nombre, universidad_id, creado_en) VALUES (?, 'Cuenta Deshabilitada', (SELECT id FROM universidades WHERE nombre = 'Universidad de Prueba'), ?)",
      deshabilitada,
      ahora,
    );
    ejecutarSql(nucleo, "UPDATE universidades SET deshabilitada_en = ? WHERE nombre = 'Universidad de Prueba'", ahora);
  });

  test.afterAll(async () => {
    await nucleo?.cerrar();
    await mail?.cerrar();
  });

  test('una cuenta suspendida o de una universidad deshabilitada tarda lo mismo que una activa', async () => {
    const activas: number[] = [];
    const inhabilitadas: number[] = [];
    for (let i = 0; i < 4; i++) {
      const a = await medir(nucleo, `${aleatorio('activa')}@austral.edu.ar`);
      expect(a.r.status, a.r.texto).toBe(200);
      activas.push(a.ms);
      for (const email of [suspendida, deshabilitada]) {
        const s = await medir(nucleo, email);
        expect(s.r.status, s.r.texto).toBe(200);
        expect(s.r.json).toEqual(a.r.json);
        inhabilitadas.push(s.ms);
      }
    }
    expect(mediana(activas)).toBeGreaterThanOrEqual(DEMORA_MS - 50);
    expect(Math.min(...inhabilitadas), `activas ${activas.join(',')} inhabilitadas ${inhabilitadas.join(',')}`).toBeGreaterThanOrEqual(
      mediana(activas) * 0.6,
    );
    expect(fila(nucleo, 'SELECT COUNT(*) AS n FROM codigos_login WHERE email IN (?, ?)', suspendida, deshabilitada).n).toBe(0);
  });

  test('con el proveedor de mails caído, la cuenta suspendida recibe el mismo 503 que una activa', async () => {
    mail.fallar = true;
    try {
      const a = await medir(nucleo, `${aleatorio('activa')}@austral.edu.ar`);
      expect(a.r.status, a.r.texto).toBe(503);
      expect(a.r.json.error).toBe('servicio_no_disponible');
      const pedidos = mail.pedidos;
      for (const email of [suspendida, deshabilitada]) {
        const s = await medir(nucleo, email);
        expect(s.r.status, `${email}: ${s.r.texto}`).toBe(503);
        expect(s.r.json).toEqual(a.r.json);
      }
      expect(mail.pedidos).toBe(pedidos);
    } finally {
      mail.fallar = false;
    }
    const a = await medir(nucleo, `${aleatorio('activa')}@austral.edu.ar`);
    expect(a.r.status, a.r.texto).toBe(200);
    const s = await medir(nucleo, suspendida);
    expect(s.r.status, s.r.texto).toBe(200);
    expect(fila(nucleo, 'SELECT COUNT(*) AS n FROM codigos_login WHERE email = ?', suspendida).n).toBe(0);
  });

  test('tras reiniciar el núcleo, la cuenta suspendida sigue tardando lo mismo que una activa', async () => {
    await nucleo.detener();
    await nucleo.iniciar();
    const s = await medir(nucleo, suspendida);
    expect(s.r.status, s.r.texto).toBe(200);
    const a = await medir(nucleo, `${aleatorio('activa')}@austral.edu.ar`);
    expect(a.r.status, a.r.texto).toBe(200);
    expect(s.r.json).toEqual(a.r.json);
    expect(s.ms, `suspendida ${s.ms} activa ${a.ms}`).toBeGreaterThanOrEqual(a.ms * 0.6);
    expect(s.ms).toBeGreaterThanOrEqual((DEMORA_MS - 50) * 0.6);
  });

  test('tras reiniciar el núcleo con el proveedor caído, la cuenta suspendida recibe el mismo 503', async () => {
    mail.fallar = true;
    try {
      const a = await medir(nucleo, `${aleatorio('activa')}@austral.edu.ar`);
      expect(a.r.status, a.r.texto).toBe(503);
      await nucleo.detener();
      await nucleo.iniciar();
      const s = await medir(nucleo, suspendida);
      expect(s.r.status, s.r.texto).toBe(503);
      expect(s.r.json).toEqual(a.r.json);
    } finally {
      mail.fallar = false;
    }
    const a = await medir(nucleo, `${aleatorio('activa')}@austral.edu.ar`);
    expect(a.r.status, a.r.texto).toBe(200);
    expect(fila(nucleo, 'SELECT COUNT(*) AS n FROM codigos_login WHERE email = ?', suspendida).n).toBe(0);
  });
});

test('un núcleo recién instalado espera aunque todavía no haya mandado ningún código', async () => {
  const mail = await mailLento();
  const nucleo = await levantarNucleo({
    semilla: SEMILLA,
    owner: OWNER,
    entorno: { PROVEEDOR_EMAIL: 'brevo', BREVO_API_KEY: BREVO_CLAVE_PRUEBA, BREVO_API_URL: mail.url },
  });
  try {
    const ahora = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const suspendida = `${aleatorio('susp')}@austral.edu.ar`;
    ejecutarSql(
      nucleo,
      "INSERT INTO usuarios (email, nombre, universidad_id, creado_en, suspendida_en) VALUES (?, 'Cuenta Suspendida', (SELECT id FROM universidades WHERE nombre = 'Universidad Austral'), ?, ?)",
      suspendida,
      ahora,
      ahora,
    );
    expect(fila(nucleo, 'SELECT COUNT(*) AS n FROM envios_codigo').n).toBe(0);
    const s = await medir(nucleo, suspendida);
    expect(s.r.status, s.r.texto).toBe(200);
    expect(s.ms).toBeGreaterThanOrEqual((DEMORA_MS - 50) * 0.6);
    expect(mail.pedidos).toBe(0);
  } finally {
    await nucleo.cerrar();
    await mail.cerrar();
  }
});
