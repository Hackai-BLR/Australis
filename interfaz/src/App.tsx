import { useCallback, useEffect, useMemo, useState } from 'react';
import { ErrorApi, alNoAutenticado, api, get, type Config, type Usuario } from './api';
import { Admin } from './Admin';
import { Aviso, type Navegacion } from './comun';
import { Curso } from './Curso';
import { Login } from './Login';
import { MisCursos } from './MisCursos';
import { Owner } from './Owner';
import { Reautenticacion } from './Reautenticacion';

function rutaPara(ruta: string, u: Usuario): string {
  if (ruta === '/administracion' || ruta.startsWith('/administracion/')) return u.administrador || u.owner ? '/administracion' : '/';
  if (ruta === '/owner' || ruta.startsWith('/owner/')) return u.owner ? '/owner' : '/';
  return u.owner ? '/owner' : '/';
}

function subdominioDe(hostname: string, base: string): string | null {
  const h = hostname.toLowerCase();
  const b = base.toLowerCase();
  if (!b || h === b || !h.endsWith('.' + b)) return null;
  const sub = h.slice(0, -(b.length + 1));
  return /^[a-z0-9-]+$/.test(sub) ? sub : null;
}

export function App() {
  const [config, setConfig] = useState<Config | null>(null);
  const [usuario, setUsuario] = useState<Usuario | null | undefined>(undefined);
  const [ruta, setRuta] = useState(window.location.pathname);

  useEffect(() => {
    alNoAutenticado(() => setUsuario(null));
    const alVolver = () => setRuta(window.location.pathname);
    window.addEventListener('popstate', alVolver);
    let vigente = true;
    get<Config>('/api/config')
      .then((c) => vigente && setConfig(c))
      .catch(() => vigente && setConfig({ dominio_base: window.location.hostname, turnstile_site_key: '' }));
    api<{ usuario: Usuario }>('GET', '/api/yo', undefined, { avisarSesion: false })
      .then((r) => vigente && setUsuario(r.usuario))
      .catch((e) => {
        if (!vigente) return;
        if (e instanceof ErrorApi && e.status === 401) setUsuario(null);
        else setUsuario(null);
      });
    return () => {
      vigente = false;
      window.removeEventListener('popstate', alVolver);
    };
  }, []);

  const base = config?.dominio_base ?? '';
  const sub = config ? subdominioDe(window.location.hostname, base) : null;
  const puerto = window.location.port ? `:${window.location.port}` : '';
  const urlDe = useCallback((s: string | null, camino = '/') => `${window.location.protocol}//${s ? s + '.' : ''}${base}${puerto}${camino}`, [base, puerto]);

  const efectiva = usuario && !sub ? rutaPara(ruta, usuario) : ruta;

  useEffect(() => {
    if (usuario && !sub && efectiva !== window.location.pathname) {
      window.history.replaceState(null, '', efectiva + window.location.search);
      setRuta(efectiva);
    }
  }, [usuario, sub, efectiva]);

  const nav: Navegacion = useMemo(
    () => ({
      irA: (camino: string) => {
        if (sub) {
          window.location.href = urlDe(null, camino);
          return;
        }
        if (camino !== window.location.pathname + window.location.search) window.history.pushState(null, '', camino);
        setRuta(camino.split('?')[0]);
      },
      salir: () => {
        api('POST', '/api/logout', {}, { avisarSesion: false, reautenticar: false })
          .catch(() => undefined)
          .finally(() => {
            if (!sub && window.location.pathname !== '/') window.history.replaceState(null, '', '/');
            setRuta(window.location.pathname);
            setUsuario(null);
          });
      },
    }),
    [sub, urlDe],
  );

  useEffect(() => {
    if (!sub) document.title = 'Campus IA';
  }, [sub, efectiva]);

  let vista: React.ReactNode = null;
  if (config && usuario === null) {
    vista = <Login config={config} alEntrar={(u) => setUsuario(u)} />;
  } else if (config && usuario) {
    if (sub) {
      vista = (
        <Curso
          key={sub}
          id={sub}
          usuario={usuario}
          nav={nav}
          urlCurso={(id) => urlDe(id)}
          urlContenido={(id) => urlDe(`${id}-curso`)}
          urlPrueba={(id) => urlDe(`${id}-prueba`)}
          urlBase={urlDe(null)}
          dominioBase={base}
        />
      );
    } else if (efectiva === '/administracion') {
      vista = <Admin usuario={usuario} nav={nav} dominioBase={base} />;
    } else if (efectiva === '/owner') {
      vista = <Owner usuario={usuario} nav={nav} />;
    } else {
      vista = <MisCursos usuario={usuario} nav={nav} urlCurso={(id) => urlDe(id)} dominioBase={base} />;
    }
  }

  return (
    <>
      {vista}
      {usuario && config?.reautenticacion === 'codigo' && <Reautenticacion usuario={usuario} />}
      <Aviso />
    </>
  );
}
