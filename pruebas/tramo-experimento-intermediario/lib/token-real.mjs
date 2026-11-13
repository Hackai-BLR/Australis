import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const RUTA_TOKEN_REAL = process.env.CAMPUSIA_TOKEN_ARCHIVO || path.join(os.homedir(), '.config', 'campusia', 'claude-oauth-token')

export function rutaTokenReal() {
  if (!fs.existsSync(RUTA_TOKEN_REAL)) throw new Error(`No existe el archivo del token de desarrollo (${RUTA_TOKEN_REAL}); definí CAMPUSIA_TOKEN_ARCHIVO`)
  return RUTA_TOKEN_REAL
}

export function valorTokenReal() {
  const valor = fs.readFileSync(rutaTokenReal(), 'utf8').trim()
  if (valor.length < 20) throw new Error('El archivo del token de desarrollo está vacío o es demasiado corto')
  return valor
}
