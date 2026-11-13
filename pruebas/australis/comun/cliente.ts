import { request, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { urlPila } from './pila.ts';

export type Respuesta = { estado: number; json: any; texto: string };

export class Cliente {
  private constructor(
    private readonly contexto: APIRequestContext,
    readonly base: string,
  ) {}

  static async nuevo(): Promise<Cliente> {
    const base = urlPila();
    return new Cliente(await request.newContext({ baseURL: base }), base);
  }

  static async conSesion(correo: string, clave: string): Promise<Cliente> {
    const cliente = await Cliente.nuevo();
    const r = await cliente.post('/api/auth/login', { email: correo, password: clave });
    if (r.estado !== 200) throw new Error(`No se pudo iniciar sesión como ${correo}: ${r.estado} ${r.texto}`);
    return cliente;
  }

  private async envolver(promesa: Promise<{ status(): number; text(): Promise<string> }>): Promise<Respuesta> {
    const r = await promesa;
    const texto = await r.text();
    let json: any = null;
    try {
      json = JSON.parse(texto);
    } catch {}
    return { estado: r.status(), json, texto };
  }

  get(ruta: string) {
    return this.envolver(this.contexto.get(ruta));
  }

  post(ruta: string, cuerpo: unknown = {}) {
    return this.envolver(this.contexto.post(ruta, { data: cuerpo }));
  }

  put(ruta: string, cuerpo: unknown = {}) {
    return this.envolver(this.contexto.put(ruta, { data: cuerpo }));
  }

  patch(ruta: string, cuerpo: unknown = {}) {
    return this.envolver(this.contexto.patch(ruta, { data: cuerpo }));
  }

  delete(ruta: string) {
    return this.envolver(this.contexto.delete(ruta));
  }

  subir(ruta: string, campos: Record<string, string | { name: string; mimeType: string; buffer: Buffer }>) {
    return this.envolver(this.contexto.post(ruta, { multipart: campos }));
  }

  async cookies() {
    return (await this.contexto.storageState()).cookies;
  }

  async abrirEnNavegador(navegador: Browser): Promise<{ contexto: BrowserContext; pagina: Page }> {
    const contexto = await navegador.newContext({ baseURL: this.base, storageState: await this.contexto.storageState() });
    return { contexto, pagina: await contexto.newPage() };
  }

  async cerrar() {
    await this.contexto.dispose();
  }
}

export function pdf(paginas: number): Buffer {
  const partes: string[] = ['%PDF-1.4\n'];
  const desplazamientos: number[] = [];
  let largo = partes[0].length;
  const objeto = (cuerpo: string) => {
    desplazamientos.push(largo);
    const texto = `${desplazamientos.length} 0 obj\n${cuerpo}\nendobj\n`;
    partes.push(texto);
    largo += texto.length;
  };
  objeto('<< /Type /Catalog /Pages 2 0 R >>');
  const hijos = Array.from({ length: paginas }, (_, i) => `${3 + i} 0 R`).join(' ');
  objeto(`<< /Type /Pages /Kids [${hijos}] /Count ${paginas} >>`);
  for (let i = 0; i < paginas; i++) objeto('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] >>');
  const total = desplazamientos.length + 1;
  let xref = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (const d of desplazamientos) xref += `${String(d).padStart(10, '0')} 00000 n \n`;
  partes.push(xref, `trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${largo}\n%%EOF\n`);
  return Buffer.from(partes.join(''), 'latin1');
}

export function ahoraUtc(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

export function tokenDeInvitacion(url: string): string {
  return url.split('/').pop() as string;
}
