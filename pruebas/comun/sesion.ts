import { expect } from '@playwright/test';
import type { Cliente, Respuesta } from './http.ts';
import type { Mail, Nucleo } from './nucleo.ts';

export function codigoDe(mail: Mail): string {
  const m = mail.texto.match(/(?<!\d)(\d{6})(?!\d)/);
  if (!m) throw new Error(`El mail a ${mail.para} no tiene un código de 6 dígitos`);
  return m[1];
}

export function mailsPara(nucleo: Nucleo, email: string, desde = 0): Mail[] {
  return nucleo.mails().slice(desde).filter((m) => m.para.toLowerCase() === email.toLowerCase());
}

export async function esperarMail(nucleo: Nucleo, email: string, desde: number, filtro: (m: Mail) => boolean = () => true): Promise<Mail> {
  const limite = Date.now() + 8000;
  while (Date.now() < limite) {
    const m = mailsPara(nucleo, email, desde).filter(filtro);
    if (m.length) return m[m.length - 1];
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`No llegó ningún mail a ${email}`);
}

export async function esperarCodigo(nucleo: Nucleo, email: string, desde: number): Promise<string> {
  const mail = await esperarMail(nucleo, email, desde, (m) => /(?<!\d)\d{6}(?!\d)/.test(m.texto));
  return codigoDe(mail);
}

export async function pedirCodigo(c: Cliente, email: string, extra: Record<string, any> = {}): Promise<Respuesta> {
  return c.post('/api/login/codigo', { email, ...extra });
}

export async function verificar(c: Cliente, email: string, codigo: string, extra: Record<string, any> = {}): Promise<Respuesta> {
  return c.post('/api/login/verificar', { email, codigo, ...extra });
}

export async function obtenerCodigo(c: Cliente, email: string): Promise<string> {
  const desde = c.nucleo.cantidadMails();
  const r = await pedirCodigo(c, email);
  expect(r.status, `pedir código para ${email}: ${r.texto}`).toBe(200);
  return esperarCodigo(c.nucleo, email, desde);
}

export async function entrar(c: Cliente, email: string): Promise<any> {
  const codigo = await obtenerCodigo(c, email);
  const r = await verificar(c, email, codigo);
  expect(r.status, `verificar código para ${email}: ${r.texto}`).toBe(200);
  expect(c.sesion, 'el login tiene que dejar la cookie de sesión').toBeTruthy();
  c.email = email;
  return r.json.usuario;
}

export async function reautenticar(c: Cliente): Promise<void> {
  if (!c.email) throw new Error('El cliente no tiene mail');
  if (c.nucleo.modoReautenticacion === 'sesion') {
    const yo = await c.get('/api/yo');
    expect(yo.status, `consultar la sesión: ${yo.texto}`).toBe(200);
    expect(yo.json.sesion?.reautenticada_hasta, 'en modo sesion la sesión ya está reautenticada').toBeTruthy();
    return;
  }
  const desde = c.nucleo.cantidadMails();
  const r = await c.post('/api/reautenticacion/codigo');
  expect(r.status, `pedir código de reautenticación: ${r.texto}`).toBe(200);
  const codigo = await esperarCodigo(c.nucleo, c.email, desde);
  const v = await c.post('/api/reautenticacion/verificar', { codigo });
  expect(v.status, `verificar reautenticación: ${v.texto}`).toBe(200);
}

export function aleatorio(prefijo = 'p') {
  return `${prefijo}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export function esperar(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
