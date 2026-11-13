import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { DIR_EXPERIMENTO } from '../lib/comun.mjs'

describe('aceptación: el resultado del experimento está documentado', () => {
  const ruta = path.join(DIR_EXPERIMENTO, 'RESULTADO.md')

  it('existe RESULTADO.md con las secciones del contrato', () => {
    assert.ok(fs.existsSync(ruta), `falta ${ruta}`)
    const texto = fs.readFileSync(ruta, 'utf8')
    for (const seccion of ['## Qué funcionó', '## Encabezados y rutas', '## Uso registrado', '## Variantes probadas', '## Recomendación para la fase 3']) {
      assert.ok(texto.includes(seccion), `falta la sección "${seccion}"`)
    }
    assert.match(texto, /oauth-2025-04-20|anthropic-beta/)
    assert.match(texto, /\/v1\/messages/)
  })
})
