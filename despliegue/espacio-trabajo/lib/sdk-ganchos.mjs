const FIJO = 'file:///usr/local/lib/campusia/sdk/dist/index.js';

export async function resolve(especificador, contexto, siguiente) {
  if (especificador === '@campusia/sdk') {
    return { url: FIJO, format: 'module', shortCircuit: true };
  }
  return siguiente(especificador, contexto);
}
