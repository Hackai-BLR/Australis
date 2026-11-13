import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react';
import { ErrorApi, esCancelado, type Usuario } from './api';

const COLORES_AVATAR = ['#2E5BBA', '#7A4FB0', '#1F7A4D', '#A4492A', '#9C2F6A', '#2E6A8E', '#A87400', '#5B7A1E'];

export function iniciales(nombre: string) {
  return nombre
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}

export function colorAvatar(clave: string) {
  return COLORES_AVATAR[[...clave].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORES_AVATAR.length];
}

export function Avatar({ nombre, clave, owner }: { nombre: string; clave: string; owner?: boolean }) {
  return (
    <span className="av" style={{ background: owner ? '#16181F' : colorAvatar(clave) }}>
      {owner ? 'CI' : iniciales(nombre)}
    </span>
  );
}

export function AvatarDe({ usuario }: { usuario: Usuario }) {
  return <Avatar nombre={usuario.nombre} clave={usuario.email} owner={usuario.owner} />;
}

let mostrarAviso: (texto: string, ms?: number) => void = () => {};

export function avisar(texto: string, ms?: number) {
  mostrarAviso(texto, ms);
}

export function avisarError(e: unknown) {
  if (esCancelado(e)) return;
  if (e instanceof ErrorApi) avisar(e.mensaje);
  else avisar('No se pudo completar. Probá de nuevo.');
}

export function Aviso() {
  const [texto, setTexto] = useState('');
  const [visible, setVisible] = useState(false);
  const temporizador = useRef<number | undefined>(undefined);
  useEffect(() => {
    mostrarAviso = (t, ms) => {
      setTexto(t);
      setVisible(true);
      window.clearTimeout(temporizador.current);
      temporizador.current = window.setTimeout(() => setVisible(false), ms ?? 2200);
    };
    return () => {
      mostrarAviso = () => {};
    };
  }, []);
  return (
    <div className={`aviso${visible ? ' ver' : ''}`} id="aviso" role="status">
      {texto}
    </div>
  );
}

export function useMenu() {
  const [abierto, setAbierto] = useState<string | null>(null);
  useEffect(() => {
    const cerrar = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.closest('.menu') || t.closest('[data-menu]'))) return;
      setAbierto(null);
    };
    const tecla = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAbierto(null);
    };
    document.addEventListener('click', cerrar);
    document.addEventListener('keydown', tecla);
    return () => {
      document.removeEventListener('click', cerrar);
      document.removeEventListener('keydown', tecla);
    };
  }, []);
  return {
    abierto,
    alternar: (id: string) => setAbierto((a) => (a === id ? null : id)),
    cerrar: () => setAbierto(null),
  };
}

export interface Navegacion {
  irA: (ruta: string) => void;
  salir: () => void;
}

export function BotonPerfil({
  id,
  usuario,
  menu,
  nav,
  estilo,
}: {
  id: string;
  usuario: Usuario;
  menu: ReturnType<typeof useMenu>;
  nav: Navegacion;
  estilo?: React.CSSProperties;
}) {
  const abierto = menu.abierto === id;
  const ir = (ruta: string) => {
    menu.cerrar();
    nav.irA(ruta);
  };
  const uni = usuario.universidad?.nombre.replace(/^Universidad (de )?/, '');
  return (
    <>
      <button className="ico" data-menu={id} aria-label="Perfil" aria-expanded={abierto} onClick={() => menu.alternar(id)}>
        <AvatarDe usuario={usuario} />
      </button>
      <div className={`menu js-perfil${abierto ? ' abierto' : ''}`} id={id} style={estilo ?? { right: 16, top: 50 }}>
        {abierto && (
          <>
            <div className="tit">
              <b>{usuario.nombre}</b>
              {usuario.email}
            </div>
            <hr />
            {!usuario.owner && (
              <button className="it" onClick={() => ir('/')}>
                Mis cursos
              </button>
            )}
            {(usuario.administrador || usuario.owner) && (
              <button className="it" data-accion="administracion" onClick={() => ir('/administracion')}>
                Administración{uni ? <small>{uni}</small> : null}
              </button>
            )}
            {usuario.owner && (
              <button className="it" onClick={() => ir('/owner')}>
                Owner
              </button>
            )}
            <hr />
            <button
              className="it"
              onClick={() => {
                menu.cerrar();
                nav.salir();
              }}
            >
              Cerrar sesión
            </button>
          </>
        )}
      </div>
    </>
  );
}

export function Marca({ alTocar, titulo, conTexto = true }: { alTocar: () => void; titulo?: string; conTexto?: boolean }) {
  return (
    <button className="marca" title={titulo} onClick={alTocar}>
      <i>C</i>
      {conTexto ? 'Campus IA' : null}
    </button>
  );
}

export function Modal({ children, alCerrar, clase, id }: { children: ReactNode; alCerrar: () => void; clase?: string; id?: string }) {
  const cerrarRef = useRef(alCerrar);
  cerrarRef.current = alCerrar;
  const caja = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const t = window.setTimeout(() => {
      const i = caja.current?.querySelector('input');
      i?.focus();
    }, 30);
    const tecla = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cerrarRef.current();
    };
    document.addEventListener('keydown', tecla);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener('keydown', tecla);
    };
  }, []);
  return (
    <div
      className={`velo abierto${clase ? ' ' + clase : ''}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) cerrarRef.current();
      }}
    >
      <div className="modal" id={id} ref={caja} role="dialog" aria-modal="true">
        {children}
      </div>
    </div>
  );
}

export interface ManejoDigitos {
  limpiar: () => void;
  enfocar: () => void;
}

export const Digitos = forwardRef<ManejoDigitos, { id: string; alCompletar: (codigo: string) => void; autoFoco?: boolean }>(
  function Digitos({ id, alCompletar, autoFoco }, ref) {
    const casillas = useRef<(HTMLInputElement | null)[]>([]);
    const completar = useRef(alCompletar);
    completar.current = alCompletar;

    const revisar = () => {
      const codigo = casillas.current.map((c) => c?.value ?? '').join('');
      if (/^\d{6}$/.test(codigo)) completar.current(codigo);
    };

    useImperativeHandle(ref, () => ({
      limpiar() {
        casillas.current.forEach((c) => {
          if (c) c.value = '';
        });
        casillas.current[0]?.focus();
      },
      enfocar() {
        casillas.current[0]?.focus();
      },
    }));

    useEffect(() => {
      if (autoFoco) casillas.current[0]?.focus();
    }, [autoFoco]);

    return (
      <div className="digitos" id={id}>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <input
            key={i}
            ref={(el) => {
              casillas.current[i] = el;
            }}
            inputMode="numeric"
            autoComplete={i === 0 ? 'one-time-code' : 'off'}
            aria-label={`Dígito ${i + 1}`}
            onInput={(e) => {
              const el = e.currentTarget;
              el.value = el.value.replace(/\D/g, '').slice(-1);
              if (el.value && casillas.current[i + 1]) casillas.current[i + 1]!.focus();
              revisar();
            }}
            onKeyDown={(e) => {
              const el = e.currentTarget;
              if (e.key === 'Backspace' && !el.value && casillas.current[i - 1]) {
                e.preventDefault();
                const previa = casillas.current[i - 1]!;
                previa.value = '';
                previa.focus();
              } else if (e.key === 'ArrowLeft' && casillas.current[i - 1]) {
                casillas.current[i - 1]!.focus();
              } else if (e.key === 'ArrowRight' && casillas.current[i + 1]) {
                casillas.current[i + 1]!.focus();
              }
            }}
            onFocus={(e) => e.currentTarget.select()}
            onPaste={(e) => {
              const texto = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 6);
              if (!texto.length) return;
              e.preventDefault();
              casillas.current.forEach((c, j) => {
                if (c) c.value = texto[j] ?? '';
              });
              casillas.current[Math.min(texto.length, 6) - 1]?.focus();
              if (texto.length === 6) revisar();
              else casillas.current[texto.length]?.focus();
            }}
          />
        ))}
      </div>
    );
  },
);

export function fechaCorta(iso: string | null | undefined, conHora = false) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const hoy = new Date();
  const ayer = new Date(hoy);
  ayer.setDate(hoy.getDate() - 1);
  const mismoDia = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const hora = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const meses = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  if (mismoDia(d, hoy)) return `hoy ${hora}`;
  const dia = mismoDia(d, ayer) ? 'ayer' : `${d.getDate()} ${meses[d.getMonth()]}${d.getFullYear() !== hoy.getFullYear() ? ' ' + d.getFullYear() : ''}`;
  return conHora ? `${dia} ${hora}` : dia;
}

export function usd(n: number) {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}
