const raiz = new URL('../../../sdk/', import.meta.url);

export async function cargarSdk() {
  return import(new URL('dist/index.js', raiz).href);
}

export async function cargarSdkHono() {
  return import(new URL('dist/hono.js', raiz).href);
}

export const urlSdk = raiz;
