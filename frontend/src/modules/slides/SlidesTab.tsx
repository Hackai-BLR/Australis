import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError } from "../../shared/api";
import { useAuth } from "../../shared/auth";
import { Badge, Button, Card, EmptyState, Input, Spinner, useToast } from "../../shared/ui";
import {
  campusLive,
  endLive,
  gotoPage,
  listPresentations,
  presentationFileUrl,
  startLive,
  uploadPresentation,
  type Presentation,
} from "./api";
import { isBehindLive, viewPage, type LiveState } from "./follower";
import { PdfViewer } from "./PdfViewer";
import { POLL_MS, useLiveFollow } from "./useLiveFollow";
import { useCampusId } from "./useCampusId";
import "./slides.css";

/** Professors and the secretary present; students follow. The backend checks every call. */
export function SlidesTab() {
  const { user } = useAuth();
  const campusId = useCampusId();
  if (!user || !campusId) return null;
  return user.role === "student" ? (
    <FollowerView campusId={campusId} />
  ) : (
    <PresenterView campusId={campusId} />
  );
}

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : "Ocurrió un error inesperado.";
}

// --- presenter ---------------------------------------------------------------------------------

function PresenterView({ campusId }: { campusId: string }) {
  const [live, setLive] = useState<LiveState | null | undefined>(undefined);
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;
    campusLive(campusId)
      .then((l) => !cancelled && setLive(l))
      .catch((err) => {
        if (cancelled) return;
        setLive(null);
        toast.show({ message: errorMessage(err), tone: "error" });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campusId]);

  if (live === undefined) return <Spinner />;
  if (live && live.status === "live") {
    return <PresenterConsole initial={live} onEnded={() => setLive(null)} />;
  }
  return <PresentationList campusId={campusId} onStarted={setLive} />;
}

function PresentationList({
  campusId,
  onStarted,
}: {
  campusId: string;
  onStarted: (live: LiveState) => void;
}) {
  const toast = useToast();
  const [items, setItems] = useState<Presentation[] | null>(null);
  const [title, setTitle] = useState("");
  const [uploading, setUploading] = useState(false);
  const [startingId, setStartingId] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    listPresentations(campusId)
      .then(setItems)
      .catch((err) => toast.show({ message: errorMessage(err), tone: "error" }));
  }, [campusId, toast]);

  useEffect(load, [load]);

  async function onUpload(e: FormEvent) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) {
      toast.show({ message: "Elegí un archivo PDF.", tone: "error" });
      return;
    }
    setUploading(true);
    try {
      await uploadPresentation(campusId, file, title.trim());
      setTitle("");
      if (fileRef.current) fileRef.current.value = "";
      toast.show({ message: "Presentación subida.", tone: "success" });
      load();
    } catch (err) {
      toast.show({ message: errorMessage(err), tone: "error" });
    } finally {
      setUploading(false);
    }
  }

  async function onStart(p: Presentation) {
    setStartingId(p.id);
    try {
      onStarted(await startLive(p.id));
    } catch (err) {
      toast.show({ message: errorMessage(err), tone: "error" });
      setStartingId(null);
    }
  }

  return (
    <div className="au-stack">
      <Card title="Subir presentación">
        <form className="au-stack" onSubmit={onUpload}>
          <Input
            id="slides-title"
            label="Título (opcional)"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <Input
            id="slides-file"
            label="Archivo PDF"
            hint="Exportá tu PowerPoint a PDF (Archivo, Exportar). La conversión directa de .pptx todavía no está disponible."
            type="file"
            accept="application/pdf,.pdf"
            ref={fileRef}
          />
          <div>
            <Button type="submit" loading={uploading}>
              Subir
            </Button>
          </div>
        </form>
      </Card>
      <Card title="Presentaciones del curso">
        {items === null ? (
          <Spinner />
        ) : items.length === 0 ? (
          <EmptyState title="Todavía no hay presentaciones" />
        ) : (
          <ul className="slides-list">
            {items.map((p) => (
              <li key={p.id} className="slides-list__item">
                <div>
                  <strong>{p.title}</strong>
                  <div className="slides-muted">
                    {p.source_filename} · {p.page_count} páginas
                  </div>
                </div>
                <Button
                  size="sm"
                  loading={startingId === p.id}
                  disabled={startingId !== null}
                  onClick={() => void onStart(p)}
                >
                  Proyectar
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function PresenterConsole({ initial, onEnded }: { initial: LiveState; onEnded: () => void }) {
  const toast = useToast();
  const { state, dispatch } = useLiveFollow(initial.id, initial);
  const live = state.live ?? initial;
  const liveRef = useRef(live);
  liveRef.current = live;
  const [busy, setBusy] = useState(false);

  const go = useCallback(
    async (page: number) => {
      const current = liveRef.current;
      const target = Math.max(1, Math.min(page, current.page_count));
      if (target === current.current_page || current.status !== "live") return;
      try {
        dispatch({ type: "server", state: await gotoPage(current.id, target) });
      } catch (err) {
        toast.show({ message: errorMessage(err), tone: "error" });
      }
    },
    [dispatch, toast],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      const page = liveRef.current.current_page;
      if (["ArrowRight", "PageDown", " "].includes(e.key)) {
        e.preventDefault();
        void go(page + 1);
      } else if (["ArrowLeft", "PageUp"].includes(e.key)) {
        e.preventDefault();
        void go(page - 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);

  async function onEnd() {
    setBusy(true);
    try {
      await endLive(live.id);
      onEnded();
    } catch (err) {
      toast.show({ message: errorMessage(err), tone: "error" });
      setBusy(false);
    }
  }

  if (live.status === "ended") {
    return (
      <EmptyState
        title="La presentación terminó"
        action={<Button onClick={onEnded}>Volver a las presentaciones</Button>}
      />
    );
  }

  return (
    <Card
      title="Proyectando"
      actions={
        <>
          <Badge tone="success">En vivo</Badge>
          <Button variant="danger" size="sm" loading={busy} onClick={() => void onEnd()}>
            Terminar
          </Button>
        </>
      }
    >
      <PdfViewer url={presentationFileUrl(live.presentation_id)} page={live.current_page} />
      <div className="slides-controls">
        <Button
          variant="secondary"
          disabled={live.current_page <= 1}
          onClick={() => void go(live.current_page - 1)}
        >
          Anterior
        </Button>
        <span aria-live="polite">
          Página {live.current_page} de {live.page_count}
        </span>
        <Button
          variant="secondary"
          disabled={live.current_page >= live.page_count}
          onClick={() => void go(live.current_page + 1)}
        >
          Siguiente
        </Button>
      </div>
      <p className="slides-muted">Podés usar las flechas del teclado para avanzar y retroceder.</p>
    </Card>
  );
}

// --- follower ----------------------------------------------------------------------------------

function FollowerView({ campusId }: { campusId: string }) {
  const [liveId, setLiveId] = useState<number | null>(null);
  const [checked, setChecked] = useState(false);
  const { state, dispatch } = useLiveFollow(liveId);
  const live = state.live;
  const ended = live?.status === "ended";

  // Without a live session (or after it ended), look for a new one.
  useEffect(() => {
    if (liveId !== null && !ended) return;
    let cancelled = false;
    const check = () =>
      campusLive(campusId)
        .then((l) => {
          if (cancelled) return;
          setChecked(true);
          if (l) setLiveId(l.id);
        })
        .catch(() => !cancelled && setChecked(true));
    void check();
    const timer = setInterval(check, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [campusId, liveId, ended]);

  if (!checked && liveId === null) return <Spinner />;
  if (!live || live.status !== "live") {
    return (
      <EmptyState
        title={ended ? "La presentación terminó" : "No hay una presentación en vivo"}
        description="Cuando el docente proyecte una presentación, vas a verla acá."
      />
    );
  }

  const page = viewPage(state);
  const behind = isBehindLive(state);
  const browse = (p: number) => dispatch({ type: "browse", page: p });
  return (
    <Card
      title="Presentación en vivo"
      actions={
        behind ? (
          <Button onClick={() => dispatch({ type: "backToLive" })}>Volver al vivo</Button>
        ) : (
          <Badge tone="success">Siguiendo al docente</Badge>
        )
      }
    >
      <PdfViewer url={presentationFileUrl(live.presentation_id)} page={page} />
      <div className="slides-controls">
        <Button variant="secondary" disabled={page <= 1} onClick={() => browse(page - 1)}>
          Anterior
        </Button>
        <span aria-live="polite">
          Página {page} de {live.page_count}
        </span>
        <Button
          variant="secondary"
          disabled={page >= live.page_count}
          onClick={() => browse(page + 1)}
        >
          Siguiente
        </Button>
      </div>
      {behind && (
        <p className="slides-muted">
          Estás explorando por tu cuenta. El docente está en la página {live.current_page}.
        </p>
      )}
    </Card>
  );
}
