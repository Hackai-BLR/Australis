import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ErrorPedido, cargarEntregas, cargarHistorial, cargarNotas, cargarYo, enviarEntrega, guardarNota } from './api.ts';
import { fechaHora, mensajeError } from './formato.ts';
import type { Entrega, Nota, Rol } from './tipos.ts';

type Datos = { usuario: string; entregas: Entrega[]; notas: Nota[] };
type Estado = { tipo: 'cargando' } | { tipo: 'error' } | ({ tipo: 'listo' } & Datos);

function codigoDe(error: unknown): string {
  return error instanceof ErrorPedido ? error.codigo : 'red';
}

export function Entregas({ rol }: { rol: Rol }) {
  const docente = rol === 'dueño' || rol === 'profesor';
  const [estado, setEstado] = useState<Estado>({ tipo: 'cargando' });

  const cargar = useCallback(
    async (senal?: AbortSignal) => {
      const [yo, entregas, notas] = await Promise.all([
        cargarYo(senal),
        cargarEntregas(senal),
        docente ? cargarHistorial(senal) : cargarNotas(senal),
      ]);
      return { usuario: yo.usuario, entregas, notas };
    },
    [docente],
  );

  const recargar = useCallback(async () => {
    try {
      const datos = await cargar();
      setEstado({ tipo: 'listo', ...datos });
    } catch {
      setEstado((previo) => (previo.tipo === 'listo' ? previo : { tipo: 'error' }));
    }
  }, [cargar]);

  useEffect(() => {
    const control = new AbortController();
    cargar(control.signal)
      .then((datos) => setEstado({ tipo: 'listo', ...datos }))
      .catch(() => {
        if (!control.signal.aborted) setEstado({ tipo: 'error' });
      });
    return () => control.abort();
  }, [cargar]);

  return (
    <section className="entregas" data-prueba="entregas" aria-labelledby="titulo-entregas">
      <h2 id="titulo-entregas">Entregas</h2>
      {estado.tipo === 'cargando' && <p className="tenue" aria-busy="true">Cargando…</p>}
      {estado.tipo === 'error' && <p className="tenue">No pudimos cargar las entregas</p>}
      {estado.tipo === 'listo' && (
        <>
          {!docente && <FormularioEntrega alEnviar={recargar} />}
          <ListaEntregas
            entregas={estado.entregas}
            docente={docente}
            usuario={estado.usuario}
            historial={docente ? estado.notas : []}
            alGuardar={recargar}
          />
          {docente ? <Historial notas={estado.notas} /> : <MisNotas notas={estado.notas} />}
        </>
      )}
    </section>
  );
}

function FormularioEntrega({ alEnviar }: { alEnviar: () => Promise<void> }) {
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState('');
  const formulario = useRef<HTMLFormElement>(null);

  async function enviar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    const form = evento.currentTarget;
    const datos = new FormData(form);
    const archivo = datos.get('archivo');
    if (archivo instanceof File && archivo.size === 0 && archivo.name === '') datos.delete('archivo');
    setEnviando(true);
    setError('');
    try {
      await enviarEntrega(datos);
      formulario.current?.reset();
      await alEnviar();
    } catch (e) {
      setError(mensajeError(codigoDe(e)));
    } finally {
      setEnviando(false);
    }
  }

  return (
    <form className="formulario-entrega" ref={formulario} onSubmit={enviar}>
      <label>
        <span>Actividad</span>
        <input name="actividad" type="text" required maxLength={80} placeholder="tp1" autoComplete="off" data-prueba="entrega-actividad" />
      </label>
      <label>
        <span>Texto</span>
        <textarea name="texto" rows={3} maxLength={20000} data-prueba="entrega-texto" />
      </label>
      <label>
        <span>Archivo</span>
        <input name="archivo" type="file" data-prueba="entrega-archivo" />
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      <button type="submit" disabled={enviando} data-prueba="entrega-enviar">
        {enviando ? 'Enviando…' : 'Entregar'}
      </button>
    </form>
  );
}

function ListaEntregas(props: {
  entregas: Entrega[];
  docente: boolean;
  usuario: string;
  historial: Nota[];
  alGuardar: () => Promise<void>;
}) {
  const { entregas, docente, usuario, historial, alGuardar } = props;
  if (entregas.length === 0) return <p className="tenue">Todavía sin entregas</p>;
  const vigentes = new Map<string, string>();
  for (const n of historial) vigentes.set(`${n.usuario.id}/${n.actividad}`, n.valor);
  return (
    <ul className="lista-entregas">
      {entregas.map((e) => (
        <li key={e.id} className="entrega" data-prueba="entrega" data-actividad={e.actividad} data-usuario={e.usuario.id}>
          <div className="entrega-arriba">
            <b>{e.actividad}</b>
            {docente && <span className="entrega-persona">{e.usuario.nombre}</span>}
            <time dateTime={e.fecha}>{fechaHora(e.fecha)}</time>
          </div>
          {e.texto && <p className="entrega-texto">{e.texto}</p>}
          {e.archivo && (
            <a className="entrega-archivo" href={`/api/archivos/${encodeURIComponent(e.archivo.id)}`} download={e.archivo.nombre} data-prueba="entrega-descarga">
              {e.archivo.nombre}
            </a>
          )}
          {docente && e.usuario.id !== usuario && (
            <Calificar usuario={e.usuario.id} actividad={e.actividad} vigente={vigentes.get(`${e.usuario.id}/${e.actividad}`)} alGuardar={alGuardar} />
          )}
        </li>
      ))}
    </ul>
  );
}

function Calificar(props: { usuario: string; actividad: string; vigente: string | undefined; alGuardar: () => Promise<void> }) {
  const [valor, setValor] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState('');

  async function guardar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    if (valor.trim() === '') return;
    setGuardando(true);
    setError('');
    try {
      await guardarNota(props.usuario, props.actividad, valor.trim());
      await props.alGuardar();
    } catch (e) {
      setError(mensajeError(codigoDe(e)));
    } finally {
      setGuardando(false);
    }
  }

  return (
    <form className="calificar" onSubmit={guardar}>
      <input
        type="text"
        value={valor}
        onChange={(e) => setValor(e.target.value)}
        maxLength={20}
        placeholder={props.vigente ?? 'Nota'}
        aria-label="Nota"
        data-prueba="nota-valor"
      />
      <button type="submit" disabled={guardando} data-prueba="nota-guardar">
        Guardar
      </button>
      {error && <p className="error" role="alert">{error}</p>}
    </form>
  );
}

function MisNotas({ notas }: { notas: Nota[] }) {
  return (
    <div className="bloque-notas">
      <h3>Mis notas</h3>
      {notas.length === 0 ? (
        <p className="tenue">Todavía sin notas</p>
      ) : (
        <ul className="lista-notas">
          {notas.map((n) => (
            <li key={n.id} data-prueba="nota" data-actividad={n.actividad}>
              <span>{n.actividad}</span>
              <b>{n.valor}</b>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Historial({ notas }: { notas: Nota[] }) {
  return (
    <div className="bloque-notas">
      <h3>Historial de notas</h3>
      {notas.length === 0 ? (
        <p className="tenue">Todavía sin notas</p>
      ) : (
        <ul className="lista-historial">
          {notas.map((n) => (
            <li key={n.id} data-prueba="nota-historial">
              <span className="historial-persona">{n.usuario.nombre}</span>
              <span>{n.actividad}</span>
              <span>
                {n.anterior ? `${n.anterior} → ` : ''}
                <b>{n.valor}</b>
              </span>
              <span className="tenue">
                {n.autor.nombre} · {fechaHora(n.fecha)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
