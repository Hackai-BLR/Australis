import { fechaCorta } from './comun';
import type { ListaVersiones, Publicacion } from './edicion';

const ETAPAS: Record<string, string> = {
  preparando: 'Preparando',
  dependencias: 'Dependencias',
  pruebas: 'Pruebas',
  tipos: 'Tipos',
  compilacion: 'Compilación',
  imagen: 'Imagen',
  arranque: 'Arranque',
  cambio: 'Cambio',
  listo: 'Listo',
};

export function nombreEtapa(etapa: string) {
  return ETAPAS[etapa] ?? (etapa ? etapa[0].toUpperCase() + etapa.slice(1) : '');
}

export function PanelVersiones({
  abierto,
  lista,
  error,
  publicando,
  volviendo,
  alCerrar,
  alVolver,
  alDescartarError,
}: {
  abierto: boolean;
  lista: ListaVersiones | null;
  error: Publicacion | null;
  publicando: boolean;
  volviendo: number | null;
  alCerrar: () => void;
  alVolver: (n: number) => void;
  alDescartarError: () => void;
}) {
  const versiones = lista?.versiones ?? [];
  const publicada = lista?.publicada ?? null;
  const actual = versiones.find((v) => v.numero === publicada) ?? null;
  const anteriores = versiones.filter((v) => v.numero !== publicada);
  const detalle = (descripcion: string, fecha: string) => [descripcion, fechaCorta(fecha, true)].filter(Boolean).join(' · ');

  return (
    <aside className={`panel${abierto ? ' abierto' : ''}`} id="p-versiones">
      <div className="ph">
        Versiones
        <button data-cerrar aria-label="Cerrar" onClick={alCerrar}>
          &#x2715;
        </button>
      </div>
      <div className="pcuerpo">
        {error && (
          <div className="ver-error" id="ver-error" role="alert">
            <div className="ve-cab">
              <b>{error.tipo === 'volver' ? 'No se pudo volver a la versión' : 'No se pudo publicar'}</b>
              <button aria-label="Descartar" onClick={alDescartarError}>
                &#x2715;
              </button>
            </div>
            <div className="ve-etapa">
              Etapa: <span data-etapa={error.etapa}>{nombreEtapa(error.etapa)}</span>
            </div>
            {error.error && <div className="ve-msg">{error.error}</div>}
            <pre>{error.registro || 'Sin registro'}</pre>
          </div>
        )}
        <div id="ver-lista">
          {lista && lista.cambios_sin_publicar && (
            <div className="ver pru">
              <span className="lin"></span>
              <div>
                <b>Prueba</b>
                <span>Cambios sin publicar</span>
              </div>
            </div>
          )}
          {actual && (
            <div className="ver pub" data-version={actual.numero}>
              <span className="lin"></span>
              <div>
                <b>Publicada · v{actual.numero}</b>
                <span>{detalle(actual.descripcion, actual.fecha)}</span>
              </div>
            </div>
          )}
          {anteriores.map((v) => (
            <div className="ver" key={v.numero} data-version={v.numero}>
              <span className="lin"></span>
              <div>
                <b>v{v.numero}</b>
                <span>{detalle(v.descripcion, v.fecha)}</span>
              </div>
              <button data-volver={v.numero} disabled={publicando} onClick={() => alVolver(v.numero)}>
                {volviendo === v.numero ? 'Volviendo…' : 'Volver a esta'}
              </button>
            </div>
          ))}
          {lista && versiones.length === 0 && <div className="provisorio">Todavía no hay versiones publicadas</div>}
          {!lista && <div className="provisorio">Cargando…</div>}
        </div>
      </div>
    </aside>
  );
}
