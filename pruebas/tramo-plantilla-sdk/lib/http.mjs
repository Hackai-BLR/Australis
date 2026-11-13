export async function pedir(base, ruta, { identidad, metodo = 'GET', cuerpo, encabezados = {}, tipo } = {}) {
  const h = { ...encabezados };
  if (identidad) h['X-Campus-Identidad'] = identidad;
  let body;
  if (cuerpo !== undefined) {
    body = typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo);
    h['Content-Type'] = tipo || 'application/json';
  }
  const r = await fetch(`${base}${ruta}`, { method: metodo, headers: h, body, redirect: 'manual' });
  const texto = await r.text();
  let json;
  try { json = JSON.parse(texto); } catch { json = undefined; }
  return { estado: r.status, texto, json, encabezados: r.headers };
}

export async function intentar(fn) {
  try {
    const v = await fn();
    return { ok: true, valor: v };
  } catch (error) {
    return { ok: false, error };
  }
}
