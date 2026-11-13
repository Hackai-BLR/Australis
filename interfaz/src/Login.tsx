import { useRef, useState } from 'react';
import { ErrorApi, api, type Config, type Usuario } from './api';
import { Digitos, avisar, type ManejoDigitos } from './comun';
import { esperarToken, hayWidget, mostrarWidget, tomarToken } from './turnstile';

async function conVerificacion<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch {
    throw new ErrorApi(503, 'servicio_no_disponible', 'No pudimos cargar la verificación. Probá de nuevo.');
  }
}

function nuevaSolicitud() {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

const FORMATO_MAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function mensajeDe(e: unknown) {
  if (e instanceof ErrorApi) {
    if (e.status === 429) return 'Pediste demasiados códigos. Probá en unos minutos.';
    if (e.codigo === 'email_invalido') return 'Revisá el mail.';
    if (e.codigo === 'turnstile_invalido') return 'No pudimos verificar que no seas un robot. Probá de nuevo.';
    return e.mensaje;
  }
  return 'No se pudo completar. Probá de nuevo.';
}

export function Login({ config, alEntrar }: { config: Config | null; alEntrar: (u: Usuario) => void }) {
  const [paso, setPaso] = useState<'mail' | 'codigo'>('mail');
  const [mail, setMail] = useState('');
  const [mailEnviado, setMailEnviado] = useState('');
  const [errMail, setErrMail] = useState('');
  const [errCodigo, setErrCodigo] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const enCurso = useRef(false);
  const digitos = useRef<ManejoDigitos>(null);
  const solicitud = useRef(nuevaSolicitud());

  const conTurnstile = async <T,>(ruta: string, cuerpo: Record<string, unknown>, reintentarSolo: boolean): Promise<T> => {
    const clave = config?.turnstile_site_key ?? '';
    let token = tomarToken();
    if (!token && hayWidget()) token = await conVerificacion(() => esperarToken(clave));
    try {
      return await api<T>('POST', ruta, token ? { ...cuerpo, turnstile: token } : cuerpo, { avisarSesion: false });
    } catch (e) {
      if (e instanceof ErrorApi && (e.codigo === 'turnstile_requerido' || e.codigo === 'turnstile_invalido')) {
        const sitio = (e.datos?.site_key as string | undefined) || clave;
        if (!reintentarSolo) {
          await conVerificacion(() => mostrarWidget(sitio));
          throw new ErrorApi(403, 'turnstile_pendiente', 'Confirmá la verificación y volvé a tocar «Enviar código».');
        }
        const nuevo = await conVerificacion(() => esperarToken(sitio));
        return await api<T>('POST', ruta, { ...cuerpo, turnstile: nuevo }, { avisarSesion: false });
      }
      throw e;
    }
  };

  const ejecutar = async (f: () => Promise<void>) => {
    if (enCurso.current) return;
    enCurso.current = true;
    setOcupado(true);
    try {
      await f();
    } finally {
      enCurso.current = false;
      setOcupado(false);
    }
  };

  const enviar = () =>
    ejecutar(async () => {
      const m = mail.trim().toLowerCase();
      if (!FORMATO_MAIL.test(m)) {
        setErrMail('Revisá el mail.');
        return;
      }
      setErrMail('');
      try {
        await conTurnstile('/api/login/codigo', { email: m, solicitud: solicitud.current }, false);
        setMailEnviado(m);
        setErrCodigo('');
        setPaso('codigo');
        window.setTimeout(() => digitos.current?.limpiar(), 0);
      } catch (e) {
        setErrMail(mensajeDe(e));
      }
    });

  const reenviar = () =>
    ejecutar(async () => {
      setErrCodigo('');
      try {
        await conTurnstile('/api/login/codigo', { email: mailEnviado, solicitud: solicitud.current }, true);
        digitos.current?.limpiar();
        avisar('Te mandamos otro código');
      } catch (e) {
        setErrCodigo(mensajeDe(e));
      }
    });

  const verificar = (codigo: string) =>
    ejecutar(async () => {
      if (!/^\d{6}$/.test(codigo)) {
        setErrCodigo('Faltan dígitos.');
        return;
      }
      setErrCodigo('');
      try {
        const r = await conTurnstile<{ usuario: Usuario }>('/api/login/verificar', { email: mailEnviado, codigo, solicitud: solicitud.current }, true);
        alEntrar(r.usuario);
      } catch (e) {
        setErrCodigo(e instanceof ErrorApi && e.codigo === 'codigo_invalido' ? 'El código no es válido o venció.' : mensajeDe(e));
        digitos.current?.limpiar();
      }
    });

  const leerDigitos = () =>
    Array.from(document.querySelectorAll<HTMLInputElement>('#digitos input'))
      .map((i) => i.value)
      .join('');

  return (
    <section className="vista activa" id="v-login">
      <div className="login">
        <div className="marca">
          <i>C</i>Campus IA
        </div>
        {paso === 'mail' ? (
          <div id="paso-mail">
            <h1>Entrar</h1>
            <p>Con tu mail de la universidad.</p>
            <input
              className="campo"
              id="mail"
              type="email"
              placeholder="nombre@austral.edu.ar"
              autoComplete="email"
              autoFocus
              value={mail}
              onChange={(e) => setMail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void enviar();
                }
              }}
            />
            <div className="err" id="err-mail">
              {errMail}
            </div>
            <button className="btn prim" id="enviar" onClick={() => void enviar()} aria-busy={ocupado}>
              Enviar código
            </button>
          </div>
        ) : (
          <div id="paso-codigo">
            <h1>Revisá tu mail</h1>
            <p>
              Mandamos un código de 6 dígitos a <b id="mail-enviado">{mailEnviado}</b>.
            </p>
            <Digitos id="digitos" ref={digitos} alCompletar={(c) => void verificar(c)} autoFoco />
            <div className="err" id="err-codigo">
              {errCodigo}
            </div>
            <button className="btn prim" id="verificar" onClick={() => void verificar(leerDigitos())} aria-busy={ocupado}>
              Entrar
            </button>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 16 }}>
              <button
                className="enlace"
                id="otro-mail"
                onClick={() => {
                  setErrCodigo('');
                  setPaso('mail');
                }}
              >
                Usar otro mail
              </button>
              <button className="enlace" id="reenviar" onClick={() => void reenviar()}>
                Reenviar código
              </button>
            </div>
          </div>
        )}
        <div id="turnstile"></div>
      </div>
    </section>
  );
}
