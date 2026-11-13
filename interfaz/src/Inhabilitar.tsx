import { useEffect, useState } from 'react';
import { ErrorApi, esCancelado, get, post } from './api';
import { Modal, avisar } from './comun';
import type { PedidoConfirmacion } from './Confirmar';

export type EstadoCuenta = 'activa' | 'suspendida' | 'pendiente';
export type FiltroEstado = 'todas' | 'activas' | 'suspendidas' | 'pendientes';

export interface PersonaEstado {
  id: number;
  nombre: string;
  email: string;
  administrador: boolean;
  owner?: boolean;
  pendiente: boolean;
  estado?: EstadoCuenta;
  baja?: boolean;
}

type Pedir = (p: PedidoConfirmacion) => void;

export function estadoDe(p: PersonaEstado): EstadoCuenta {
  return p.estado ?? (p.pendiente ? 'pendiente' : 'activa');
}

const FILTROS: [FiltroEstado, string][] = [
  ['todas', 'Todas'],
  ['activas', 'Activas'],
  ['suspendidas', 'Suspendidas'],
  ['pendientes', 'Pendientes'],
];

const ESTADO_DE_FILTRO: Record<FiltroEstado, EstadoCuenta | null> = {
  todas: null,
  activas: 'activa',
  suspendidas: 'suspendida',
  pendientes: 'pendiente',
};

export function pasaFiltroEstado(p: PersonaEstado, f: FiltroEstado) {
  const e = ESTADO_DE_FILTRO[f];
  return e === null || estadoDe(p) === e;
}

export function ChipsEstado({ valor, alCambiar }: { valor: FiltroEstado; alCambiar: (f: FiltroEstado) => void }) {
  return (
    <>
      <span className="div-chips"></span>
      {FILTROS.map(([f, t]) => (
        <button key={f} className={`chip${valor === f ? ' on' : ''}`} data-estado={f} onClick={() => alCambiar(f)}>
          {t}
        </button>
      ))}
    </>
  );
}

export function CeldaEstado({ p }: { p: PersonaEstado }) {
  const e = estadoDe(p);
  return (
    <td className="estado">
      {e === 'activa' ? <span className="pill verde">Activa</span> : e === 'suspendida' ? <span className="pill">Suspendida</span> : <span className="pill ambar">Pendiente</span>}
      {p.baja && (
        <>
          {' '}
          <span className="pill">Baja</span>
        </>
      )}
    </td>
  );
}

export function CeldaAccionesPersona<P extends PersonaEstado>({
  p,
  yo,
  esOwner,
  conUni,
  pedir,
  alCambiar,
}: {
  p: P;
  yo: number;
  esOwner?: boolean;
  conUni?: (ruta: string) => string;
  pedir: Pedir;
  alCambiar: (nueva: P) => void | Promise<void>;
}) {
  const protegida = p.id === yo || (!esOwner && (p.administrador || !!p.owner));
  if (protegida) return <td className="der"></td>;
  const suspendida = estadoDe(p) === 'suspendida';
  const ruta = (accion: string) => (esOwner ? `/api/owner/personas/${p.id}/${accion}` : (conUni ?? ((r: string) => r))(`/api/admin/personas/${p.id}/${accion}`));
  const suspender = () =>
    pedir({
      titulo: `¿Suspender a ${p.nombre}?`,
      texto: 'No va a poder entrar ni usar sus cursos. Se cierran sus sesiones. Sus datos se conservan.',
      verbo: 'Suspender',
      peligro: true,
      hacer: async () => {
        await alCambiar(await post<P>(ruta('suspender')));
        avisar(`${p.nombre} quedó suspendida`);
      },
    });
  const reactivar = () =>
    pedir({
      titulo: `¿Reactivar a ${p.nombre}?`,
      texto: 'Va a poder volver a entrar con un código nuevo.',
      verbo: 'Reactivar',
      hacer: async () => {
        await alCambiar(await post<P>(ruta('reactivar')));
        avisar(`${p.nombre} quedó activa`);
      },
    });
  const baja = () =>
    pedir({
      titulo: `¿Dar de baja a ${p.nombre}?`,
      texto: 'Se suspende la cuenta y se la quita de todos sus cursos. Sus entregas, notas y archivos se conservan.',
      verbo: 'Dar de baja',
      peligro: true,
      hacer: async () => {
        await alCambiar(await post<P>(ruta('baja'), { confirmar: true }));
        avisar(`${p.nombre} quedó dada de baja`);
      },
    });
  return (
    <td className="der acciones-fila">
      {suspendida ? (
        <button className="btn sec chico" data-reactivar={p.id} onClick={reactivar}>
          Reactivar
        </button>
      ) : (
        <button className="btn sec chico" data-suspender={p.id} onClick={suspender}>
          Suspender
        </button>
      )}
      {!p.baja && (
        <button className="btn sec chico peligro" data-baja={p.id} onClick={baja}>
          Dar de baja
        </button>
      )}
    </td>
  );
}

export function PastillaArchivado({ id }: { id?: string }) {
  return (
    <span className="pill" id={id}>
      Archivado
    </span>
  );
}

export function CeldaAccionCursoAdmin<C extends { id: string; nombre: string; archivado?: boolean }>({
  c,
  conUni,
  pedir,
  alCambiar,
  alTransferir,
}: {
  c: C;
  conUni?: (ruta: string) => string;
  pedir: Pedir;
  alCambiar: (nuevo: C) => void | Promise<void>;
  alTransferir?: (c: C) => void;
}) {
  const ruta = (accion: string) => (conUni ?? ((r: string) => r))(`/api/admin/cursos/${encodeURIComponent(c.id)}/${accion}`);
  return (
    <td className="der acciones-fila">
      {alTransferir && (
        <button className="btn sec chico" data-transferir={c.id} onClick={() => alTransferir(c)}>
          Transferir
        </button>
      )}
      {c.archivado ? (
        <button
          className="btn sec chico"
          data-desarchivar={c.id}
          onClick={() =>
            pedir(pedidoDesarchivar(c.nombre, async () => {
              await alCambiar(await post<C>(ruta('desarchivar')));
              avisar(`${c.nombre} desarchivado`);
            }))
          }
        >
          Desarchivar
        </button>
      ) : (
        <button
          className="btn sec chico"
          data-archivar={c.id}
          onClick={() =>
            pedir(pedidoArchivar(c.nombre, async () => {
              await alCambiar(await post<C>(ruta('archivar')));
              avisar(`${c.nombre} archivado`);
            }))
          }
        >
          Archivar
        </button>
      )}
    </td>
  );
}

export function pedidoArchivar(nombre: string, hacer: () => Promise<void>): PedidoConfirmacion {
  return {
    titulo: `¿Archivar ${nombre}?`,
    texto: 'Los alumnos dejan de verlo y el curso se apaga. No se borra nada y se puede desarchivar.',
    verbo: 'Archivar',
    peligro: true,
    hacer,
  };
}

export function pedidoDesarchivar(nombre: string, hacer: () => Promise<void>): PedidoConfirmacion {
  return {
    titulo: `¿Desarchivar ${nombre}?`,
    texto: 'El curso vuelve a estar disponible para sus inscriptos.',
    verbo: 'Desarchivar',
    hacer,
  };
}

export function BotonesUniversidad<U extends { id: number; nombre: string; deshabilitada?: boolean }>({
  u,
  pedir,
  alCambiar,
}: {
  u: U;
  pedir: Pedir;
  alCambiar: (nueva: U) => void | Promise<void>;
}) {
  const ruta = (accion: string) => `/api/owner/universidades/${u.id}/${accion}`;
  return u.deshabilitada ? (
    <button
      className="btn sec chico"
      data-rehabilitar={u.id}
      onClick={() =>
        pedir({
          titulo: `¿Rehabilitar ${u.nombre}?`,
          texto: 'Sus cuentas pueden volver a entrar con un código nuevo y sus cursos vuelven a funcionar.',
          verbo: 'Rehabilitar',
          hacer: async () => {
            await alCambiar(await post<U>(ruta('rehabilitar')));
            avisar(`${u.nombre} rehabilitada`);
          },
        })
      }
    >
      Rehabilitar
    </button>
  ) : (
    <button
      className="btn sec chico peligro"
      data-deshabilitar={u.id}
      onClick={() =>
        pedir({
          titulo: `¿Deshabilitar ${u.nombre}?`,
          texto: 'Ninguna de sus cuentas va a poder entrar y sus cursos dejan de funcionar. No se borra nada.',
          verbo: 'Deshabilitar',
          peligro: true,
          hacer: async () => {
            await alCambiar(await post<U>(ruta('deshabilitar')));
            avisar(`${u.nombre} deshabilitada`);
          },
        })
      }
    >
      Deshabilitar
    </button>
  );
}

interface Candidato {
  id: number;
  nombre: string;
  email: string;
}

export function ModalTransferir<C extends { id: string; nombre: string; dueno: { id: number } | null }>({
  c,
  conUni,
  alCerrar,
  alTransferir,
}: {
  c: C;
  conUni: (ruta: string) => string;
  alCerrar: () => void;
  alTransferir: () => Promise<void>;
}) {
  const [candidatos, setCandidatos] = useState<Candidato[] | null>(null);
  const [elegido, setElegido] = useState('');
  const [error, setError] = useState('');
  const [ocupado, setOcupado] = useState(false);

  useEffect(() => {
    get<{ personas: Candidato[] }>(conUni('/api/admin/personas?filtro=profesores&estado=activas'))
      .then((r) => {
        const lista = r.personas.filter((p) => p.id !== c.dueno?.id);
        setCandidatos(lista);
        if (lista.length) setElegido(String(lista[0].id));
      })
      .catch((e) => setError(e instanceof ErrorApi ? e.mensaje : 'No se pudo cargar la lista.'));
  }, [c.id]);

  const confirmar = async () => {
    if (ocupado || !elegido) return;
    setOcupado(true);
    setError('');
    try {
      const r = await post<{ dueno: { nombre: string } }>(conUni(`/api/admin/cursos/${encodeURIComponent(c.id)}/transferir`), { usuario_id: Number(elegido) });
      await alTransferir();
      alCerrar();
      avisar(`${c.nombre} ahora es de ${r.dueno.nombre}`);
    } catch (e) {
      if (!esCancelado(e)) setError(e instanceof ErrorApi ? e.mensaje : 'No se pudo transferir.');
    } finally {
      setOcupado(false);
    }
  };

  return (
    <Modal id="modal" alCerrar={alCerrar}>
      <h3>¿Transferir {c.nombre}?</h3>
      <p className="desc">El nuevo dueño puede editarlo y publicarlo. El dueño anterior queda como profesor.</p>
      <label className="etq" htmlFor="transferir-a">
        Nuevo dueño
      </label>
      <select className="campo" id="transferir-a" value={elegido} onChange={(e) => setElegido(e.target.value)}>
        {(candidatos ?? []).map((p) => (
          <option key={p.id} value={p.id}>
            {p.nombre} · {p.email}
          </option>
        ))}
      </select>
      <div className="err">{candidatos && !candidatos.length ? 'No hay profesores activos para elegir.' : error}</div>
      <div className="pie">
        <button className="btn sec" data-cerrarmodal onClick={alCerrar}>
          Cancelar
        </button>
        <button className="btn prim" data-confirmar onClick={() => void confirmar()} disabled={ocupado || !elegido}>
          Transferir
        </button>
      </div>
    </Modal>
  );
}

export function pedidoQuitarRol(nombre: string, rol: string, donde: string, hacer: () => Promise<void>): PedidoConfirmacion {
  return {
    titulo: `¿Quitar a ${nombre} como ${rol}?`,
    texto: `Deja de ser ${rol}${donde}. Se cierran sus sesiones. La cuenta sigue activa.`,
    verbo: 'Quitar',
    peligro: true,
    hacer,
  };
}
