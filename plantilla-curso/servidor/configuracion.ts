export interface Configuracion {
  puerto: number;
  curso: string;
  clavePublica: string;
  datos: string;
}

export function clavePublicaValida(clave: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(clave) && Buffer.from(clave, 'base64url').length === 32;
}

export function leerConfiguracion(env: Record<string, string | undefined> = process.env): Configuracion {
  const puerto = Number(env.PORT ?? '3000');
  if (!Number.isInteger(puerto) || puerto < 1 || puerto > 65535) throw new Error('PORT no es un puerto válido');
  const curso = env.CAMPUSIA_CURSO ?? '';
  if (!curso) throw new Error('Falta CAMPUSIA_CURSO');
  const clavePublica = env.CAMPUSIA_CLAVE_PUBLICA ?? '';
  if (!clavePublicaValida(clavePublica)) throw new Error('CAMPUSIA_CLAVE_PUBLICA no es una clave Ed25519 válida');
  return { puerto, curso, clavePublica, datos: env.CAMPUSIA_DATOS || '/datos' };
}
