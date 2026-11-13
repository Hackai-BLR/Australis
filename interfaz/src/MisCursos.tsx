import { useEffect, useState } from 'react';
import { get, type CursoPropio, type Usuario } from './api';
import { PastillaArchivado } from './Inhabilitar';
import { BotonPerfil, Marca, avisarError, useMenu, type Navegacion } from './comun';
import { ModalCrear, ModalUnirse } from './ModalesCurso';

export function MisCursos({
  usuario,
  nav,
  urlCurso,
  dominioBase,
}: {
  usuario: Usuario;
  nav: Navegacion;
  urlCurso: (id: string) => string;
  dominioBase: string;
}) {
  const menu = useMenu();
  const [cursos, setCursos] = useState<CursoPropio[] | null>(null);
  const [modal, setModal] = useState<'crear' | 'unirse' | null>(null);

  useEffect(() => {
    let vigente = true;
    get<{ cursos: CursoPropio[] }>('/api/mis-cursos')
      .then((r) => vigente && setCursos([...r.cursos.filter((c) => !c.archivado), ...r.cursos.filter((c) => c.archivado)]))
      .catch((e) => {
        if (vigente) {
          setCursos([]);
          avisarError(e);
        }
      });
    return () => {
      vigente = false;
    };
  }, []);

  const unirse = () => setModal('unirse');

  return (
    <section className="vista pagina activa" id="v-cursos">
      <div className="cab">
        <Marca alTocar={() => nav.irA('/')} />
        <span className="esp"></span>
        <BotonPerfil id="m-perfil-c" usuario={usuario} menu={menu} nav={nav} />
      </div>
      <div className="cuerpo">
        <div className="cont">
          <div className="titulo">
            <h2>Mis cursos</h2>
            <div className="acciones">
              <button className="btn sec" data-accion="unirse" onClick={unirse}>
                Unirme con código
              </button>
              {usuario.profesor && (
                <button className="btn prim" data-accion="crear" onClick={() => setModal('crear')}>
                  Crear curso
                </button>
              )}
            </div>
          </div>
          <div id="grilla">
            {cursos === null ? null : cursos.length === 0 ? (
              <div className="vacio">
                <b>Todavía no estás en ningún curso</b>
                Si tu profesor te pasó un código, usalo para entrar.
                <br />
                <button className="btn prim" data-accion="unirse" onClick={unirse}>
                  Unirme con código
                </button>
              </div>
            ) : (
              <div className="grilla">
                {cursos.map((c) => (
                  <button
                    key={c.id}
                    className="tarj"
                    data-curso={c.id}
                    onClick={() => {
                      window.location.href =
                        c.tipo === 'modulos' ? `${urlCurso('campus').replace(/\/$/, '')}/campuses/${c.campus_externo}` : urlCurso(c.id);
                    }}
                  >
                    <div className="franja" style={{ background: c.color }}></div>
                    {(c.rol !== 'alumno' || c.archivado) && (
                      <span className="pills">
                        {c.archivado && <PastillaArchivado />}
                        {c.rol !== 'alumno' && <span className="pill azul">{c.rol === 'dueño' ? 'Dueño' : 'Profesor'}</span>}
                      </span>
                    )}
                    <div className="tc">
                      <b>{c.nombre}</b>
                      <span className="sub">{c.tipo === 'modulos' ? 'Campus con módulos' : c.periodo}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      {modal === 'crear' && <ModalCrear dominioBase={dominioBase} urlCurso={urlCurso} alCerrar={() => setModal(null)} />}
      {modal === 'unirse' && <ModalUnirse urlCurso={urlCurso} alCerrar={() => setModal(null)} />}
    </section>
  );
}
