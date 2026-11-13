import { useCallback, useEffect, useRef, useState } from 'react';
import { ErrorApi, get, post } from './api';
import { avisar, avisarError } from './comun';
import { textoCupo, type CupoProfesor } from './Cupos';
import { esperar, leerConversacion, pedirAlAgente, type ArchivoCambiado, type Mensaje } from './edicion';

interface MensajeVista {
  clave: string;
  id: number | null;
  rol: 'yo' | 'ag';
  texto: string;
  archivos: ArchivoCambiado[];
  estado: 'en_curso' | 'ok' | 'error';
  herramienta?: string;
}

const MARCA: Record<ArchivoCambiado['cambio'], [string, string]> = {
  agregado: ['a', '+'],
  modificado: ['m', '~'],
  borrado: ['b', '-'],
};

let local = 0;

interface Confirmacion {
  id: number;
  tipo: 'quitar' | 'rol';
  persona: { id: number; nombre: string; email: string };
  rol: 'alumno' | 'profesor' | null;
  estado: 'pendiente' | 'aprobada' | 'rechazada' | 'fallida';
  pedida_por: { id: number; nombre: string };
  creada: string;
  resuelta: string | null;
  error: string | null;
}

function preguntaDe(c: Confirmacion) {
  return c.tipo === 'quitar' ? `¿Quitar a ${c.persona.nombre} del curso?` : `¿Pasar a ${c.persona.nombre} a ${c.rol ?? 'alumno'}?`;
}

function listoDe(c: Confirmacion) {
  return c.tipo === 'quitar' ? `Listo: se quitó a ${c.persona.nombre}` : `Listo: ${c.persona.nombre} pasó a ${c.rol ?? 'alumno'}`;
}

function CajaCupo({ cupo }: { cupo: CupoProfesor | null }) {
  if (!cupo) return <div className="cupo" id="cupo" data-restante="" data-porcentaje=""></div>;
  const t = textoCupo(cupo);
  return (
    <div
      className={`cupo${t.clase ? ' ' + t.clase : ''}`}
      id="cupo"
      role="status"
      data-restante={cupo.restante}
      data-porcentaje={cupo.porcentaje ?? ''}
      title={t.detalle ?? undefined}
    >
      <span className="bar">
        <i style={{ width: `${Math.min(100, t.porcentaje)}%` }}></i>
      </span>
      <span>
        {t.texto}
        {t.detalle ? ` · ${t.detalle}` : ''}
      </span>
    </div>
  );
}

function vista(m: Mensaje): MensajeVista {
  return {
    clave: `m${m.id}`,
    id: m.id,
    rol: m.rol === 'profesor' ? 'yo' : 'ag',
    texto: m.texto,
    archivos: m.rol === 'agente' ? m.archivos ?? [] : [],
    estado: m.estado,
  };
}

function nombreHerramienta(nombre: string, ruta: string | null) {
  const n = nombre.toLowerCase();
  const verbo = n === 'read' ? 'Leyendo' : n === 'edit' || n === 'multiedit' || n === 'write' ? 'Editando' : n === 'bash' ? 'Ejecutando un comando' : 'Trabajando';
  return ruta && verbo !== 'Ejecutando un comando' ? `${verbo} ${ruta}` : verbo;
}

export function PanelAgente({
  id,
  yo,
  abierto,
  alCerrar,
  alTerminar,
  alCambiarInscriptos,
}: {
  id: string;
  yo: number;
  abierto: boolean;
  alCerrar: () => void;
  alTerminar: (respuesta: Mensaje | null) => void;
  alCambiarInscriptos?: () => void;
}) {
  const [mensajes, setMensajes] = useState<MensajeVista[] | null>(null);
  const [pedido, setPedido] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const chat = useRef<HTMLDivElement>(null);
  const vigente = useRef(true);
  const siguiendo = useRef(false);
  const enviandoRef = useRef(false);
  const [cupo, setCupo] = useState<CupoProfesor | null>(null);
  const [confirmaciones, setConfirmaciones] = useState<Confirmacion[]>([]);
  const [resolviendo, setResolviendo] = useState<number | null>(null);
  const base = `/api/cursos/${encodeURIComponent(id)}`;

  const cargarCupo = useCallback(async () => {
    try {
      const c = await get<CupoProfesor>(`${base}/cupo`);
      if (vigente.current) setCupo(c);
    } catch {
      return;
    }
  }, [base]);

  const cargarConfirmaciones = useCallback(async () => {
    try {
      const r = await get<{ confirmaciones: Confirmacion[] }>(`${base}/confirmaciones`);
      if (vigente.current) setConfirmaciones(r.confirmaciones.filter((c) => c.estado === 'pendiente'));
    } catch {
      return;
    }
  }, [base]);

  const alTerminarRef = useRef(alTerminar);
  alTerminarRef.current = (r: Mensaje | null) => {
    void cargarCupo();
    void cargarConfirmaciones();
    alTerminar(r);
  };

  useEffect(() => {
    vigente.current = true;
    return () => {
      vigente.current = false;
    };
  }, []);

  const seguir = useCallback(async () => {
    if (siguiendo.current) return;
    siguiendo.current = true;
    try {
      for (;;) {
        await esperar(3000);
        if (!vigente.current || enviandoRef.current) return;
        try {
          const r = await leerConversacion(id);
          if (!vigente.current || enviandoRef.current) return;
          setMensajes(r.mensajes.map(vista));
          setOcupado(r.en_curso);
          if (!r.en_curso) {
            alTerminarRef.current(null);
            return;
          }
        } catch {
          return;
        }
      }
    } finally {
      siguiendo.current = false;
    }
  }, [id]);

  const cargar = useCallback(async () => {
    if (enviandoRef.current) return;
    try {
      const r = await leerConversacion(id);
      if (!vigente.current || enviandoRef.current) return;
      setMensajes(r.mensajes.map(vista));
      setOcupado(r.en_curso);
      if (r.en_curso) void seguir();
    } catch {
      setMensajes((a) => a ?? []);
    }
  }, [id, seguir]);

  useEffect(() => {
    if (!abierto) return;
    void cargar();
    void cargarCupo();
    void cargarConfirmaciones();
  }, [abierto, cargar, cargarCupo, cargarConfirmaciones]);

  const resolver = async (c: Confirmacion, aprobar: boolean) => {
    if (resolviendo !== null) return;
    setResolviendo(c.id);
    try {
      await post(`${base}/confirmaciones/${c.id}/${aprobar ? 'aprobar' : 'rechazar'}`, {});
      setConfirmaciones((l) => l.filter((x) => x.id !== c.id));
      avisar(aprobar ? listoDe(c) : 'Pedido cancelado');
      if (aprobar) alCambiarInscriptos?.();
    } catch (e) {
      avisarError(e);
      if (e instanceof ErrorApi && e.status !== 0 && e.codigo !== 'cancelado') {
        void cargarConfirmaciones();
        if (aprobar) alCambiarInscriptos?.();
      }
    } finally {
      setResolviendo(null);
    }
  };

  useEffect(() => {
    const c = chat.current?.parentElement;
    if (c) c.scrollTop = c.scrollHeight;
  }, [mensajes, abierto]);

  const enviar = async () => {
    const texto = pedido.trim();
    if (!texto || enviando || ocupado) return;
    const claveYo = `l${++local}`;
    const claveAg = `l${++local}`;
    enviandoRef.current = true;
    setEnviando(true);
    setPedido('');
    setMensajes((a) => [
      ...(a ?? []),
      { clave: claveYo, id: null, rol: 'yo', texto, archivos: [], estado: 'ok' },
      { clave: claveAg, id: null, rol: 'ag', texto: '', archivos: [], estado: 'en_curso' },
    ]);
    const cambiar = (f: (m: MensajeVista) => MensajeVista) => {
      if (!vigente.current) return;
      setMensajes((a) => (a ?? []).map((m) => (m.clave === claveAg ? f(m) : m)));
    };
    let respuesta: Mensaje | null = null;
    try {
      const terminado = await pedirAlAgente(id, texto, {
        inicio: (p, r) => {
          if (!vigente.current) return;
          setMensajes((a) =>
            (a ?? []).map((m) => {
              if (m.clave === claveYo) return { ...vista(p), clave: claveYo };
              if (m.clave === claveAg) return { ...vista(r), clave: claveAg, estado: 'en_curso', texto: r.texto ?? '' };
              return m;
            }),
          );
        },
        texto: (t) => cambiar((m) => ({ ...m, texto: m.texto + t, herramienta: undefined })),
        herramienta: (n, r) => cambiar((m) => ({ ...m, herramienta: nombreHerramienta(n, r) })),
        fin: (r) => {
          respuesta = r;
          cambiar(() => ({ ...vista(r), clave: claveAg }));
        },
      });
      if (!terminado) {
        enviandoRef.current = false;
        try {
          const r = await leerConversacion(id);
          if (vigente.current) {
            setMensajes(r.mensajes.map(vista));
            setOcupado(r.en_curso);
            if (r.en_curso) void seguir();
          }
        } catch {
          cambiar((m) => ({ ...m, estado: 'error', texto: m.texto || 'Se cortó la conexión con el agente.' }));
        }
      }
    } catch (e) {
      const mensaje = e instanceof ErrorApi ? e.mensaje : 'No se pudo completar. Probá de nuevo.';
      cambiar((m) => ({ ...m, estado: 'error', texto: mensaje, herramienta: undefined }));
      if (vigente.current) setPedido((p) => p || texto);
      if (e instanceof ErrorApi && e.codigo === 'agente_ocupado') void seguir();
    } finally {
      enviandoRef.current = false;
      if (vigente.current) setEnviando(false);
      alTerminarRef.current(respuesta);
    }
  };

  const lista = mensajes ?? [];
  const bloqueado = !!cupo && (!cupo.modelo_disponible || cupo.agotado !== null);

  return (
    <aside className={`panel${abierto ? ' abierto' : ''}`} id="p-agente">
      <div className="ph">
        Editar con el agente
        <button data-cerrar aria-label="Cerrar" onClick={alCerrar}>
          &#x2715;
        </button>
      </div>
      <div className="pcuerpo">
        <div className="chat" id="chat" ref={chat}>
          {mensajes !== null && lista.length === 0 && <div className="msg ag">¿Qué querés cambiar del curso?</div>}
          {lista.map((m) => (
            <div
              key={m.clave}
              className={`msg ${m.rol}${m.estado === 'en_curso' && m.rol === 'ag' ? ' en-curso' : ''}${m.estado === 'error' && m.rol === 'ag' ? ' error' : ''}`}
              data-mensaje={m.id ?? undefined}
            >
              {m.texto && <div className="txt">{m.texto}</div>}
              {m.estado === 'en_curso' && m.rol === 'ag' && (
                <div className="trabajando">
                  <span className="puntos">
                    <i></i>
                    <i></i>
                    <i></i>
                  </span>
                  {m.herramienta && <span>{m.herramienta}</span>}
                </div>
              )}
              {m.rol === 'ag' && m.archivos.length > 0 && (
                <div className="cambio">
                  {m.archivos.map((a) => (
                    <div key={`${a.cambio}:${a.ruta}`} className={MARCA[a.cambio]?.[0] ?? 'm'} data-archivo={a.ruta}>
                      <em>{MARCA[a.cambio]?.[1] ?? '~'}</em>
                      <span className="ruta">{a.ruta}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
      {confirmaciones.length > 0 && (
        <div className="confirmaciones" id="confirmaciones">
          {confirmaciones.map((c) => (
            <div className="confirmacion" key={c.id} data-confirmacion={c.id}>
              <div className="ct">
                {preguntaDe(c)}
                <small>
                  {c.pedida_por.id === yo ? 'Lo pidió el agente' : `Lo pidió el agente de ${c.pedida_por.nombre}`} · {c.persona.email}
                </small>
              </div>
              {c.pedida_por.id === yo && (
                <div className="cb">
                  <button className="btn sec chico" data-rechazar={c.id} disabled={resolviendo !== null} onClick={() => void resolver(c, false)}>
                    Cancelar
                  </button>
                  <button
                    className={`btn prim chico${c.tipo === 'quitar' ? ' rojo' : ''}`}
                    data-aprobar={c.id}
                    disabled={resolviendo !== null}
                    onClick={() => void resolver(c, true)}
                  >
                    Confirmar
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <CajaCupo cupo={cupo} />
      <div className="compo">
        <div className="cj">
          <textarea
            id="pedido"
            placeholder="Pedile un cambio al curso"
            value={pedido}
            maxLength={8000}
            onChange={(e) => setPedido(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void enviar();
              }
            }}
          ></textarea>
          <button className="env" id="enviar-pedido" aria-label="Enviar" disabled={enviando || ocupado || (bloqueado && !pedido.trim())} onClick={() => void enviar()}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="#fff" strokeWidth="1.8">
              <path d="M7 12V2M2.5 6.5L7 2l4.5 4.5" />
            </svg>
          </button>
        </div>
      </div>
    </aside>
  );
}
