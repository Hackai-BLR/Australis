import { useEffect, useState } from 'react';
import { cargarPortada } from './api.ts';
import { Entregas } from './Entregas.tsx';
import { etiquetaRol, fechaCorta, listaNombres } from './formato.ts';
import type { Clase, Portada } from './tipos.ts';

type Estado = { tipo: 'cargando' } | { tipo: 'error' } | { tipo: 'listo'; portada: Portada };

export function App() {
  const [estado, setEstado] = useState<Estado>({ tipo: 'cargando' });

  useEffect(() => {
    const control = new AbortController();
    cargarPortada(control.signal)
      .then((portada) => setEstado({ tipo: 'listo', portada }))
      .catch(() => {
        if (!control.signal.aborted) setEstado({ tipo: 'error' });
      });
    return () => control.abort();
  }, []);

  useEffect(() => {
    if (estado.tipo === 'listo') document.title = estado.portada.curso.nombre;
  }, [estado]);

  if (estado.tipo === 'cargando') {
    return <div className="aviso" aria-busy="true">Cargando…</div>;
  }
  if (estado.tipo === 'error') {
    return (
      <div className="aviso">
        <p className="aviso-titulo">No pudimos cargar el curso</p>
        <p>Probá de nuevo en unos minutos.</p>
      </div>
    );
  }
  return <PortadaCurso portada={estado.portada} />;
}

function PortadaCurso({ portada }: { portada: Portada }) {
  const { curso, profesores, clases, yo } = portada;
  const rol = etiquetaRol(yo.rol);
  const docentes = listaNombres(profesores.map((p) => p.nombre));

  return (
    <>
      <header className="hero">
        <div className="hero-interior">
          <div className="hero-arriba">
            <small className="hero-periodo" data-prueba="curso-periodo">{curso.periodo}</small>
            {rol && (
              <span className="rol" data-prueba="rol" title={`Entraste como ${rol.toLowerCase()}`}>
                {rol}
              </span>
            )}
          </div>
          <h1 data-prueba="curso-nombre">{curso.nombre}</h1>
          {docentes && <p className="hero-docentes">{profesores.length > 1 ? 'Docentes: ' : 'Docente: '}{docentes}</p>}
        </div>
      </header>
      <main className="cuerpo">
        <div className="principal">
          <section className="clases" aria-labelledby="titulo-clases">
            <h2 id="titulo-clases">Clases</h2>
            {clases.length === 0 ? (
              <div className="vacio" data-prueba="clases-vacio">
                <span className="vacio-etiqueta">Curso nuevo</span>
                <p>Todavía sin clases</p>
              </div>
            ) : (
              <ol className="lista-clases">
                {clases.map((clase) => (
                  <TarjetaClase key={clase.id} clase={clase} />
                ))}
              </ol>
            )}
          </section>
          <Entregas rol={yo.rol} />
        </div>
        <aside className="lateral">
          <div className="caja">
            <b>Docentes</b>
            <ul className="docentes" data-prueba="curso-profesores">
              {profesores.map((p, i) => (
                <li key={`${p.nombre}-${i}`}>{p.nombre}</li>
              ))}
            </ul>
          </div>
        </aside>
      </main>
    </>
  );
}

function TarjetaClase({ clase }: { clase: Clase }) {
  const fecha = fechaCorta(clase.fecha);
  return (
    <li className="clase" data-prueba="clase">
      <span className="clase-numero">{clase.numero}</span>
      <div className="clase-texto">
        <b>{clase.titulo}</b>
        {fecha && <time dateTime={clase.fecha ?? undefined}>{fecha}</time>}
      </div>
    </li>
  );
}
