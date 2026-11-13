import { useEffect, useState } from 'react';
import { borrar, get, post } from './api';
import { Modal, avisar, avisarError, fechaCorta } from './comun';

interface SesionActiva {
  id: number;
  dispositivo: string;
  agente: string | null;
  ip: string | null;
  creada: string;
  ultimo_uso: string;
  vence: string;
}

export function SesionesPersona({ persona, alCerrar }: { persona: { id: number; nombre: string; email: string }; alCerrar: () => void }) {
  const base = `/api/owner/personas/${persona.id}/sesiones`;
  const [lista, setLista] = useState<SesionActiva[] | null>(null);
  const [ocupado, setOcupado] = useState(false);

  useEffect(() => {
    get<{ sesiones: SesionActiva[] }>(base)
      .then((r) => setLista(r.sesiones))
      .catch((e) => {
        setLista([]);
        avisarError(e);
      });
  }, [base]);

  const cerrarUna = async (s: SesionActiva) => {
    if (ocupado) return;
    setOcupado(true);
    try {
      await borrar(`${base}/${s.id}`);
      setLista((l) => l?.filter((x) => x.id !== s.id) ?? l);
      avisar('Sesión cerrada');
    } catch (e) {
      avisarError(e);
    } finally {
      setOcupado(false);
    }
  };

  const cerrarTodas = async () => {
    if (ocupado) return;
    setOcupado(true);
    try {
      const r = await post<{ cerradas: number }>(`${base}/cerrar`, {});
      setLista([]);
      avisar(r.cerradas === 1 ? 'Se cerró 1 sesión' : `Se cerraron ${r.cerradas} sesiones`);
    } catch (e) {
      avisarError(e);
    } finally {
      setOcupado(false);
    }
  };

  return (
    <Modal alCerrar={alCerrar} clase="sesiones" id="sesiones-persona">
      <h3>Sesiones de {persona.nombre}</h3>
      <p className="desc">{persona.email}</p>
      {lista !== null && lista.length === 0 && <p className="vacio">No tiene sesiones activas</p>}
      {lista !== null && lista.length > 0 && (
        <table className="tabla">
          <thead>
            <tr>
              <th>Dispositivo</th>
              <th>IP</th>
              <th>Último uso</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {lista.map((s) => (
              <tr key={s.id} data-sesion={s.id}>
                <td>
                  {s.dispositivo}
                  <small>Entró {fechaCorta(s.creada, true)}</small>
                </td>
                <td className="num">{s.ip ?? '—'}</td>
                <td className="num">{fechaCorta(s.ultimo_uso, true)}</td>
                <td className="der">
                  <button className="btn sec chico peligro" data-cerrarsesion={s.id} disabled={ocupado} onClick={() => void cerrarUna(s)}>
                    Cerrar
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="pie">
        <button className="btn sec" data-cerrarmodal onClick={alCerrar}>
          Listo
        </button>
        <button className="btn prim rojo" data-accion="cerrar-sesiones" disabled={ocupado || !lista || lista.length === 0} onClick={() => void cerrarTodas()}>
          Cerrar todas
        </button>
      </div>
    </Modal>
  );
}
