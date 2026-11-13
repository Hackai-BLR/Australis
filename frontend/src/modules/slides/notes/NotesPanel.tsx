import { useEffect, useRef, useState } from "react";
import { ApiError } from "../../../shared/api";
import { Button, useToast } from "../../../shared/ui";
import { exportNotes, listNotes, saveNote } from "./api";

type Props = { presentationId: number; page: number };

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : "Ocurrió un error inesperado.";
}

/** Private notes for the page being shown. Saved when the field loses focus or the page changes. */
export function NotesPanel(props: Props) {
  return <NotesEditor key={props.presentationId} {...props} />;
}

function NotesEditor({ presentationId, page }: Props) {
  const toast = useToast();
  const [saved, setSaved] = useState<Record<number, string>>({});
  const [draft, setDraft] = useState("");
  const [loaded, setLoaded] = useState(false);
  const savedRef = useRef(saved);
  savedRef.current = saved;
  const draftRef = useRef({ page, text: "" });

  useEffect(() => {
    let cancelled = false;
    listNotes(presentationId)
      .then((notes) => {
        if (cancelled) return;
        setSaved(Object.fromEntries(notes.map((n) => [n.page, n.body])));
        setLoaded(true);
      })
      .catch((err) => !cancelled && toast.show({ message: message(err), tone: "error" }));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presentationId]);

  useEffect(() => {
    const text = savedRef.current[page] ?? "";
    draftRef.current = { page, text };
    setDraft(text);
  }, [page, loaded]);

  async function persist(forPage: number, text: string) {
    if ((savedRef.current[forPage] ?? "") === text) return;
    try {
      await saveNote(presentationId, forPage, text);
      setSaved((prev) => ({ ...prev, [forPage]: text }));
    } catch (err) {
      toast.show({ message: message(err), tone: "error" });
    }
  }

  // Leaving a page (or unmounting) saves what was typed on it.
  useEffect(() => {
    return () => {
      const { page: p, text } = draftRef.current;
      void persist(p, text);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  return (
    <div className="au-stack slides-notes">
      <label className="au-field__label" htmlFor="slides-note">
        Mis notas de la página {page}
      </label>
      <textarea
        id="slides-note"
        className="slides-notes__field"
        rows={5}
        maxLength={10000}
        value={draft}
        disabled={!loaded}
        onChange={(e) => {
          draftRef.current = { page, text: e.target.value };
          setDraft(e.target.value);
        }}
        onBlur={() => void persist(page, draft)}
      />
      <p className="slides-muted">Solo vos ves estas notas.</p>
      <div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            void persist(page, draft).then(() =>
              exportNotes(presentationId).catch((err) =>
                toast.show({ message: message(err), tone: "error" }),
              ),
            );
          }}
        >
          Exportar mis notas (.txt)
        </Button>
      </div>
    </div>
  );
}
