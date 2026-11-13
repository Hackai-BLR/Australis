import { useCallback, useEffect, useRef, useState } from 'react';
import { get, put } from './api';
import { avisar, avisarError } from './comun';

export interface CupoUniversidad {
  id: number;
  nombre: string;
  cupo: number;
  usado: number;
  porcentaje: number;
  aviso: boolean;
  repartido: number;
  reserva: number;
  deshabilitada: boolean;
}

export interface CupoDeProfesor {
  id: number;
  nombre: string;
  email: string;
  cupo: number | null;
  propio: boolean;
  usado: number;
  porcentaje: number | null;
  aviso: boolean;
}

export interface CuposAdmin {
  mes: string;
  universidad: CupoUniversidad;
  predeterminado: number | null;
  profesores: CupoDeProfesor[];
}

export interface CupoProfesor {
  mes: string;
  cupo: number | null;
  usado: number;
  restante: number;
  porcentaje: number | null;
  universidad: { cupo: number; usado: number; restante: number; porcentaje: number };
  aviso: boolean;
  agotado: null | 'profesor' | 'universidad';
  modelo_disponible: boolean;
}

const FORMATO = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 });

export function miles(n: number) {
  return FORMATO.format(n);
}

export function tokens(n: number) {
  return `${miles(n)} ${n === 1 ? 'token' : 'tokens'}`;
}

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function nombreMes(mes: string) {
  const [a, m] = mes.split('-').map(Number);
  return m >= 1 && m <= 12 ? `${MESES[m - 1]} ${a}` : mes;
}

function Barra({ porcentaje, aviso }: { porcentaje: number; aviso: boolean }) {
  return (
    <span className="bar">
      <i style={{ width: `${Math.min(100, Math.max(0, porcentaje))}%`, background: aviso ? 'var(--ambar)' : undefined }}></i>
    </span>
  );
}

function Porcentaje({ porcentaje, aviso }: { porcentaje: number | null; aviso: boolean }) {
  if (porcentaje === null) return <span className="num">—</span>;
  return (
    <div className="barrita">
      <Barra porcentaje={porcentaje} aviso={aviso} />
      {aviso ? <span className="pill ambar">{porcentaje} %</span> : <span className="num">{porcentaje} %</span>}
    </div>
  );
}

function leer(texto: string): number | null | undefined {
  const t = texto.trim().replace(/[.\s]/g, '');
  if (!t) return null;
  if (!/^\d+$/.test(t)) return undefined;
  const n = Number(t);
  return Number.isSafeInteger(n) && n <= 1_000_000_000_000 ? n : undefined;
}

function CampoTokens({
  valor,
  vacio,
  guardar,
  placeholder,
  ancho,
  atributos,
  etiqueta,
}: {
  valor: number | null;
  vacio: boolean;
  guardar: (v: number | null) => Promise<void>;
  placeholder?: string;
  ancho?: boolean;
  atributos: Record<string, string>;
  etiqueta: string;
}) {
  const guardado = valor === null ? '' : String(valor);
  const [texto, setTexto] = useState(guardado);
  const enCurso = useRef<string | null>(null);

  useEffect(() => {
    if (enCurso.current === null) setTexto(guardado);
  }, [guardado]);

  const confirmar = async () => {
    const v = leer(texto);
    const normal = v === null || v === undefined ? texto.trim() : String(v);
    if (normal === guardado || normal === enCurso.current) {
      setTexto(guardado);
      return;
    }
    if (v === undefined || (v === null && !vacio)) {
      avisar('Revisá el valor: tiene que ser una cantidad entera de tokens.');
      setTexto(guardado);
      return;
    }
    enCurso.current = normal;
    setTexto(normal);
    try {
      await guardar(v);
      avisar('Cupo guardado');
    } catch (e) {
      avisarError(e);
      setTexto(guardado);
    } finally {
      enCurso.current = null;
    }
  };

  return (
    <input
      className={`campo-tokens${ancho ? ' ancho' : ''}`}
      inputMode="numeric"
      aria-label={etiqueta}
      placeholder={placeholder}
      value={texto}
      onChange={(e) => setTexto(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') void confirmar();
        else if (e.key === 'Escape') setTexto(guardado);
      }}
      onBlur={() => void confirmar()}
      {...atributos}
    />
  );
}

export function CuposDelOwner() {
  const [lista, setLista] = useState<CupoUniversidad[] | null>(null);
  const [mes, setMes] = useState('');

  useEffect(() => {
    get<{ mes: string; universidades: CupoUniversidad[] }>('/api/owner/cupos')
      .then((r) => {
        setMes(r.mes);
        setLista(r.universidades);
      })
      .catch(avisarError);
  }, []);

  return (
    <>
      <div className="titulo">
        <h2>Cupos</h2>
        {mes && <span className="pill">{nombreMes(mes)}</span>}
      </div>
      <div className="caja">
        <table className="tabla">
          <thead>
            <tr>
              <th>Universidad</th>
              <th>Asignado por mes</th>
              <th>Consumido</th>
              <th>Uso</th>
            </tr>
          </thead>
          <tbody>
            {(lista ?? []).map((u) => (
              <tr key={u.id} data-cupo-universidad={u.id} data-usado={u.usado}>
                <td>
                  {u.nombre}
                  {u.deshabilitada && (
                    <>
                      {' '}
                      <span className="pill">Deshabilitada</span>
                    </>
                  )}
                </td>
                <td>
                  <CampoTokens
                    valor={u.cupo}
                    vacio={false}
                    etiqueta={`Cupo de ${u.nombre}`}
                    atributos={{ 'data-cupo': String(u.id) }}
                    guardar={async (v) => {
                      const nueva = await put<CupoUniversidad>(`/api/owner/universidades/${u.id}/cupo`, { tokens: v });
                      setLista((l) => l?.map((x) => (x.id === nueva.id ? nueva : x)) ?? l);
                    }}
                  />
                </td>
                <td className="num">{tokens(u.usado)}</td>
                <td>
                  <Porcentaje porcentaje={u.porcentaje} aviso={u.aviso} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function CuposDeAdministracion({ conUni }: { conUni: (ruta: string) => string }) {
  const [datos, setDatos] = useState<CuposAdmin | null>(null);

  const cargar = useCallback(async () => {
    try {
      setDatos(await get<CuposAdmin>(conUni('/api/admin/cupos')));
    } catch (e) {
      avisarError(e);
    }
  }, [conUni]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  if (!datos) {
    return (
      <div className="titulo">
        <h2>Cupos</h2>
      </div>
    );
  }

  const u = datos.universidad;
  const guardarPredeterminado = async (v: number | null) => {
    setDatos(await put<CuposAdmin>(conUni('/api/admin/cupos/predeterminado'), { tokens: v }));
  };
  const guardarProfesor = (id: number) => async (v: number | null) => {
    setDatos(await put<CuposAdmin>(conUni(`/api/admin/cupos/profesores/${id}`), { tokens: v }));
  };

  return (
    <>
      <div className="titulo">
        <h2>Cupos</h2>
        <span className="pill">{nombreMes(datos.mes)}</span>
      </div>
      {u.aviso && (
        <div className="cupo-aviso" id="cupo-aviso" role="status">
          La universidad llegó al 80 % de su cupo de este mes ({u.porcentaje} % usado).
        </div>
      )}
      <div className="metricas dos">
        <div className="met" id="cupo-total" data-cupo={u.cupo} data-usado={u.usado}>
          <small>Cupo de la universidad</small>
          <b>{tokens(u.cupo)}</b>
          <span className="met-sub">
            Usado: {tokens(u.usado)} · {u.porcentaje} %
          </span>
        </div>
        <div className="met" id="cupo-reserva" data-reserva={u.reserva} data-repartido={u.repartido}>
          <small>Reserva sin repartir</small>
          <b>{tokens(u.reserva)}</b>
          <span className="met-sub">Repartido: {tokens(u.repartido)}</span>
        </div>
      </div>
      <div className="bloque">
        <h3>Cupo predeterminado por profesor</h3>
        <p className="desc">Por mes. Vacío: sin tope propio, solo los limita el cupo de la universidad.</p>
        <div className="cupo-fila">
          <CampoTokens
            valor={datos.predeterminado}
            vacio
            ancho
            placeholder="Sin tope"
            etiqueta="Cupo predeterminado por profesor"
            atributos={{ id: 'cupo-predeterminado' }}
            guardar={guardarPredeterminado}
          />
          <span className="num">tokens por mes</span>
        </div>
      </div>
      <div className="caja">
        <table className="tabla">
          <thead>
            <tr>
              <th>Profesor</th>
              <th>Cupo por mes</th>
              <th>Usado</th>
              <th>Uso</th>
            </tr>
          </thead>
          <tbody>
            {datos.profesores.length === 0 && (
              <tr>
                <td colSpan={4} className="num">
                  No hay profesores.
                </td>
              </tr>
            )}
            {datos.profesores.map((p) => (
              <tr key={p.id} data-cupo-profesor={p.id} data-usado={p.usado}>
                <td>
                  {p.nombre}
                  <small style={{ display: 'block', color: 'var(--gris)', fontSize: 12 }}>{p.email}</small>
                </td>
                <td>
                  <CampoTokens
                    valor={p.propio ? p.cupo : null}
                    vacio
                    placeholder={datos.predeterminado === null ? 'Sin tope' : miles(datos.predeterminado)}
                    etiqueta={`Cupo de ${p.nombre}`}
                    atributos={{ 'data-cupo-prof': String(p.id) }}
                    guardar={guardarProfesor(p.id)}
                  />
                </td>
                <td className="num">{tokens(p.usado)}</td>
                <td>
                  <Porcentaje porcentaje={p.porcentaje} aviso={p.aviso} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function textoCupo(c: CupoProfesor): { texto: string; detalle: string | null; clase: string; bloqueado: boolean; porcentaje: number } {
  const restante = `Te quedan ${tokens(c.restante)} este mes`;
  const pu = c.universidad.porcentaje;
  const pp = c.porcentaje;
  const mayor = Math.max(pp ?? 0, pu);
  if (!c.modelo_disponible) return { texto: 'No hay uso disponible por el momento', detalle: null, clase: 'agotado', bloqueado: true, porcentaje: mayor };
  if (c.agotado === 'profesor') return { texto: 'Se agotó tu cupo mensual de uso del agente.', detalle: null, clase: 'agotado', bloqueado: true, porcentaje: 100 };
  if (c.agotado === 'universidad')
    return { texto: 'Se agotó el cupo mensual de uso del agente de la universidad.', detalle: null, clase: 'agotado', bloqueado: true, porcentaje: 100 };
  if (c.aviso) {
    const propio = pp !== null && pp >= 80;
    return {
      texto: propio ? `Usaste el ${pp} % de tu cupo` : `La universidad usó el ${pu} % de su cupo`,
      detalle: restante,
      clase: 'aviso',
      bloqueado: false,
      porcentaje: propio ? pp! : pu,
    };
  }
  return { texto: restante, detalle: null, clase: '', bloqueado: false, porcentaje: mayor };
}
