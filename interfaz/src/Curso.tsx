import { useCallback, useEffect, useRef, useState } from 'react';
import { ErrorApi, get, post, type CursoDetalle, type CursoPropio, type Usuario } from './api';
import { PanelAgente } from './Agente';
import { BotonPerfil, Marca, avisar, avisarError, useMenu, type Navegacion } from './comun';
import {
  encenderEspacio,
  esperar,
  leerEspacio,
  leerPublicaciones,
  leerVersiones,
  publicar,
  seguirPublicacion,
  volverA,
  type EstadoEspacio,
  type ListaVersiones,
  type Mensaje,
  type Publicacion,
} from './edicion';
import { PanelInscriptos } from './Inscriptos';
import { ModalCrear } from './ModalesCurso';
import { PanelVersiones } from './Versiones';
import { useConfirmar } from './Confirmar';
import { PastillaArchivado, pedidoArchivar, pedidoDesarchivar } from './Inhabilitar';

const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-modals allow-downloads';

type Panel = 'p-agente' | 'p-inscriptos' | 'p-versiones';

export function Curso({
  id,
  usuario,
  nav,
  urlCurso,
  urlContenido,
  urlPrueba,
  urlBase,
  dominioBase,
}: {
  id: string;
  usuario: Usuario;
  nav: Navegacion;
  urlCurso: (id: string) => string;
  urlContenido: (id: string) => string;
  urlPrueba: (id: string) => string;
  urlBase: string;
  dominioBase: string;
}) {
  const menu = useMenu();
  const [cursos, setCursos] = useState<CursoPropio[] | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [modo, setModo] = useState<'publicado' | 'prueba'>('publicado');
  const [crear, setCrear] = useState(false);
  const [estado, setEstado] = useState<CursoDetalle['estado'] | null>(null);
  const [cargado, setCargado] = useState<string | null>(null);
  const [ronda, setRonda] = useState(0);
  const [reintentando, setReintentando] = useState(false);
  const [espacio, setEspacio] = useState<EstadoEspacio | null>(null);
  const [errorEspacio, setErrorEspacio] = useState<string | null>(null);
  const [rondaEspacio, setRondaEspacio] = useState(0);
  const [recarga, setRecarga] = useState(0);
  const [rondaInscriptos, setRondaInscriptos] = useState(0);
  const [versiones, setVersiones] = useState<ListaVersiones | null>(null);
  const [publicando, setPublicando] = useState(false);
  const [volviendo, setVolviendo] = useState<number | null>(null);
  const [errorPublicacion, setErrorPublicacion] = useState<Publicacion | null>(null);
  const vigente = useRef(true);

  useEffect(() => {
    vigente.current = true;
    return () => {
      vigente.current = false;
    };
  }, []);
  const confirmar = useConfirmar();

  const cargarCursos = useCallback(async () => {
    try {
      const r = await get<{ cursos: CursoPropio[] }>('/api/mis-cursos');
      setCursos(r.cursos);
    } catch (e) {
      setCursos((a) => a ?? []);
      avisarError(e);
    }
  }, []);

  useEffect(() => {
    void cargarCursos();
  }, [cargarCursos]);

  const curso = cursos?.find((c) => c.id === id) ?? null;
  const inscripto = !!curso;
  const docente = curso?.rol === 'dueño' || curso?.rol === 'profesor';
  const archivado = !!curso?.archivado;

  const cargarVersiones = useCallback(async () => {
    try {
      const r = await leerVersiones(id);
      if (vigente.current) setVersiones(r);
    } catch {
      if (vigente.current) setVersiones((a) => a ?? { publicada: null, cambios_sin_publicar: false, versiones: [] });
    }
  }, [id]);

  const terminarPublicacion = useCallback(
    async (inicial: Publicacion) => {
      setPublicando(true);
      if (inicial.tipo === 'volver') setVolviendo(inicial.desde_version);
      let p = inicial;
      try {
        p = await seguirPublicacion(id, inicial, () => vigente.current);
      } catch (e) {
        if (vigente.current) avisarError(e);
      }
      if (!vigente.current) return;
      setPublicando(false);
      setVolviendo(null);
      if (p.estado === 'ok') {
        setErrorPublicacion(null);
        avisar(p.tipo === 'volver' ? `Volviste a la v${p.desde_version}. Se publicó como v${p.version}` : `Publicada la v${p.version}`, 4000);
        setModo('publicado');
        if (p.tipo === 'publicar') setPanel(null);
        setRecarga((r) => r + 1);
      } else if (p.estado === 'error') {
        setErrorPublicacion(p);
        avisar(p.tipo === 'volver' ? 'No se pudo volver a la versión' : 'No se pudo publicar', 4000);
        setPanel('p-versiones');
      }
      await cargarVersiones();
    },
    [id, cargarVersiones],
  );

  useEffect(() => {
    if (!docente) return;
    void cargarVersiones();
    let activo = true;
    leerPublicaciones(id)
      .then((r) => {
        const p = r.publicaciones[0];
        if (activo && p && p.estado === 'en_curso') void terminarPublicacion(p);
      })
      .catch(() => undefined);
    return () => {
      activo = false;
    };
  }, [docente, id, cargarVersiones, terminarPublicacion]);

  useEffect(() => {
    if (!docente || archivado || modo !== 'prueba') return;
    let activo = true;
    const seguir = async () => {
      let r: { espacio: EstadoEspacio; error: string | null } | null = null;
      try {
        r = await encenderEspacio(id);
      } catch (e) {
        if (!activo) return;
        setEspacio('error');
        setErrorEspacio(e instanceof ErrorApi ? e.mensaje : null);
        return;
      }
      while (activo) {
        if (r) {
          setEspacio(r.espacio);
          setErrorEspacio(r.error);
          if (r.espacio === 'encendido' || r.espacio === 'error') return;
        }
        await esperar(2500);
        if (!activo) return;
        try {
          r = await leerEspacio(id);
        } catch {
          r = null;
        }
      }
    };
    void seguir();
    return () => {
      activo = false;
    };
  }, [docente, archivado, id, modo, rondaEspacio]);

  useEffect(() => {
    if (!inscripto) return;
    let vigente = true;
    let temporizador: number | undefined;
    const consultar = async () => {
      let e: CursoDetalle['estado'] = 'listo';
      try {
        const r = await get<CursoDetalle>(`/api/cursos/${encodeURIComponent(id)}`);
        e = r.estado ?? 'listo';
      } catch {
        e = 'listo';
      }
      if (!vigente) return;
      setEstado(e);
      if (e === 'preparando') temporizador = window.setTimeout(() => void consultar(), 2500);
    };
    void consultar();
    return () => {
      vigente = false;
      window.clearTimeout(temporizador);
    };
  }, [id, inscripto, ronda]);

  useEffect(() => {
    document.title = curso ? `${curso.nombre} · Campus IA` : 'Campus IA';
  }, [curso]);

  const irAMisCursos = () => {
    window.location.href = urlBase;
  };

  if (cursos === null) return <section className="vista activa" id="v-curso"></section>;

  if (!curso) {
    return (
      <section className="vista pagina activa" id="v-curso">
        <div className="cab">
          <Marca alTocar={irAMisCursos} />
          <span className="esp"></span>
          <BotonPerfil id="m-perfil" usuario={usuario} menu={menu} nav={nav} />
        </div>
        <div className="cuerpo">
          <div className="cont">
            <div className="vacio">
              <b>No tenés acceso a este curso</b>
              <a className="btn prim" href={urlBase}>
                Ir a Mis cursos
              </a>
            </div>
          </div>
        </div>
      </section>
    );
  }

  const profe = docente;
  const cambiarArchivo = (archivar: boolean) => {
    menu.cerrar();
    const hacer = async () => {
      const r = await post<CursoDetalle>(`/api/cursos/${encodeURIComponent(id)}/${archivar ? 'archivar' : 'desarchivar'}`);
      const valor = typeof r?.archivado === 'boolean' ? r.archivado : archivar;
      setCursos((lista) => lista?.map((c) => (c.id === id ? { ...c, archivado: valor } : c)) ?? lista);
      if (valor) {
        setPanel((p) => (p === 'p-agente' ? null : p));
        setModo('publicado');
      } else setCargado(null);
      avisar(valor ? 'Curso archivado' : 'Curso desarchivado');
    };
    confirmar.pedir(archivar ? pedidoArchivar(curso.nombre, hacer) : pedidoDesarchivar(curso.nombre, hacer));
  };
  const alternarPanel = (p: Panel) => {
    const abrir = panel !== p;
    setPanel(abrir ? p : null);
    if (abrir && p === 'p-agente') setModo('prueba');
  };
  const cargar = estado !== null && estado !== 'preparando' && estado !== 'error';
  const enPrueba = profe && !archivado && modo === 'prueba';
  const pruebaLista = espacio === 'encendido';
  const cambios = !!versiones?.cambios_sin_publicar;
  const tocarPublicar = async () => {
    if (publicando) return;
    setPublicando(true);
    try {
      const p = await publicar(id);
      await terminarPublicacion(p);
    } catch (e) {
      setPublicando(false);
      if (e instanceof ErrorApi && e.codigo === 'sin_cambios') void cargarVersiones();
      avisarError(e);
    }
  };
  const tocarVolver = async (n: number) => {
    if (publicando) return;
    setPublicando(true);
    setVolviendo(n);
    try {
      const p = await volverA(id, n);
      await terminarPublicacion(p);
    } catch (e) {
      setPublicando(false);
      setVolviendo(null);
      avisarError(e);
    }
  };
  const alTerminarAgente = (r: Mensaje | null) => {
    if (r && r.archivos?.length) setVersiones((v) => (v ? { ...v, cambios_sin_publicar: true } : v));
    void cargarVersiones();
    if (modo === 'prueba') setRecarga((x) => x + 1);
  };
  const reintentar = async () => {
    setReintentando(true);
    try {
      await post(`/api/cursos/${encodeURIComponent(id)}/reintentar`);
      setEstado('preparando');
      setRonda((r) => r + 1);
    } catch (e) {
      avisarError(e);
    } finally {
      setReintentando(false);
    }
  };
  const src = !cargar ? undefined : enPrueba ? (pruebaLista ? urlPrueba(id) : undefined) : urlContenido(id);
  const clave = `${enPrueba ? 'prueba' : 'publicado'}:${recarga}`;
  const listo = cargado === clave;

  return (
    <section className="vista activa" id="v-curso">
      <div className="barra">
        <Marca alTocar={irAMisCursos} titulo="Mis cursos" conTexto={false} />
        <span className="div"></span>
        <button className="sel" data-menu="m-cursos" aria-expanded={menu.abierto === 'm-cursos'} onClick={() => menu.alternar('m-cursos')}>
          <span className="punto" style={{ background: curso.color }}></span>
          <span className="js-nombre">{curso.nombre}</span>
          <svg className="flecha" viewBox="0 0 10 10">
            <path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </button>
        {archivado && <PastillaArchivado id="curso-archivado" />}
        <span className="esp"></span>
        {profe && (
          <>
            <div className="modo">
              <button className={modo === 'publicado' ? 'on' : ''} data-modo="publicado" onClick={() => setModo('publicado')}>
                Publicado
              </button>
              <button className={modo === 'prueba' ? 'on prueba' : ''} data-modo="prueba" onClick={() => setModo('prueba')}>
                Prueba
              </button>
            </div>
            {!archivado && (
              <button className={`acc${panel === 'p-agente' ? ' on' : ''}`} data-panel="p-agente" onClick={() => alternarPanel('p-agente')}>
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M8 1.5l1.6 3.9 3.9 1.6-3.9 1.6L8 12.5 6.4 8.6 2.5 7l3.9-1.6z" />
                </svg>
                Editar
              </button>
            )}
            <button className={`acc${panel === 'p-inscriptos' ? ' on' : ''}`} data-panel="p-inscriptos" onClick={() => alternarPanel('p-inscriptos')}>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="6" cy="5.5" r="2.5" />
                <path d="M1.5 13.5c.6-2.4 2.3-3.5 4.5-3.5s3.9 1.1 4.5 3.5M11 3.2a2.4 2.4 0 010 4.6M12.5 10.2c1 .5 1.7 1.6 2 3.3" />
              </svg>
              Inscriptos
            </button>
            <button className={`acc${panel === 'p-versiones' ? ' on' : ''}`} data-panel="p-versiones" onClick={() => alternarPanel('p-versiones')}>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="8" cy="8" r="6" />
                <path d="M8 4.5V8l2.5 1.5" />
              </svg>
              Versiones
            </button>
            {!archivado && (
              <button className="publicar" id="publicar" disabled={!(modo === 'prueba' && cambios && !publicando)} onClick={() => void tocarPublicar()}>
                {publicando && volviendo === null ? 'Publicando…' : 'Publicar'}
              </button>
            )}
          </>
        )}
        <BotonPerfil id="m-perfil" usuario={usuario} menu={menu} nav={nav} estilo={{ right: 8 }} />
        <div className={`menu${menu.abierto === 'm-cursos' ? ' abierto' : ''}`} id="m-cursos" style={{ left: 48 }}>
          {menu.abierto === 'm-cursos' && (
            <>
              <div className="tit">Mis cursos</div>
              {cursos.map((c) => (
                <button
                  key={c.id}
                  className="it"
                  data-curso={c.id}
                  onClick={() => {
                    menu.cerrar();
                    if (c.id !== id) window.location.href = urlCurso(c.id);
                  }}
                >
                  <span className="punto" style={{ background: c.color }}></span>
                  {c.nombre}
                  {c.id === id ? <small>&#x2713;</small> : null}
                </button>
              ))}
              {curso.rol === 'dueño' && (
                <>
                  <hr />
                  {archivado ? (
                    <button className="it" data-accion="desarchivar-curso" onClick={() => cambiarArchivo(false)}>
                      Desarchivar curso
                    </button>
                  ) : (
                    <button className="it" data-accion="archivar-curso" onClick={() => cambiarArchivo(true)}>
                      Archivar curso
                    </button>
                  )}
                </>
              )}
              {usuario.profesor && (
                <>
                  <hr />
                  <button
                    className="it"
                    data-accion="crear"
                    onClick={() => {
                      menu.cerrar();
                      setCrear(true);
                    }}
                  >
                    + Crear curso
                  </button>
                </>
              )}
            </>
          )}
        </div>
      </div>
      <div className="zona">
        <div className={`lienzo${enPrueba ? ' prueba' : ''}`} id="lienzo">
          {archivado ? (
            <div className="cargando" id="curso-archivado-aviso" role="status">
              Curso archivado
              {curso.rol === 'dueño' && <small>Desarchivalo desde el menú del curso para volver a usarlo.</small>}
            </div>
          ) : (
            <>
              <iframe
                key={clave}
                id="curso"
                title={curso.nombre}
                sandbox={SANDBOX}
                src={src}
                onLoad={(e) => {
                  if (e.currentTarget.getAttribute('src')) setCargado(clave);
                }}
              ></iframe>
              {estado === 'error' && (
                <div className="cargando" id="curso-error" role="status">
                  No se pudo preparar el curso
                  {profe && (
                    <button className="btn prim" data-accion="reintentar" disabled={reintentando} onClick={() => void reintentar()}>
                      Reintentar
                    </button>
                  )}
                </div>
              )}
              {enPrueba && estado !== 'error' && espacio === 'error' && (
                <div className="cargando" id="espacio-error" role="status">
                  No se pudo preparar la versión de prueba
                  {errorEspacio && <small>{errorEspacio}</small>}
                  <button className="btn prim" data-accion="reintentar-espacio" onClick={() => setRondaEspacio((r) => r + 1)}>
                    Reintentar
                  </button>
                </div>
              )}
              {!listo && estado !== 'error' && !(enPrueba && espacio === 'error') && (
                <div className="cargando" id="curso-cargando" role="status">
                  <span className="giro"></span>
                  {estado === 'preparando' ? 'Preparando el curso' : enPrueba ? 'Preparando la versión de prueba' : 'Cargando el curso'}
                  {(estado === 'preparando' || (enPrueba && !pruebaLista)) && <small>Puede tardar unos minutos la primera vez.</small>}
                </div>
              )}
            </>
          )}
        </div>
        {profe && panel === 'p-inscriptos' && (
          <PanelInscriptos key={rondaInscriptos} curso={curso} usuario={usuario} alCerrar={() => setPanel(null)} alCambiarCurso={() => void cargarCursos()} />
        )}
        {profe && !archivado && <PanelAgente
            id={id}
            yo={usuario.id}
            abierto={panel === 'p-agente'}
            alCerrar={() => setPanel(null)}
            alTerminar={alTerminarAgente}
            alCambiarInscriptos={() => {
              setRondaInscriptos((r) => r + 1);
              void cargarCursos();
            }}
          />}
        {profe && (
          <PanelVersiones
            abierto={panel === 'p-versiones'}
            lista={versiones}
            error={errorPublicacion}
            publicando={publicando}
            volviendo={volviendo}
            alCerrar={() => setPanel(null)}
            alVolver={(n) => void tocarVolver(n)}
            alDescartarError={() => setErrorPublicacion(null)}
          />
        )}
      </div>
      {confirmar.elemento}
      {crear && <ModalCrear dominioBase={dominioBase} urlCurso={urlCurso} alCerrar={() => setCrear(false)} />}
    </section>
  );
}
