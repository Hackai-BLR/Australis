import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { apiGet, apiPost } from "../../shared/api";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  PageHeader,
  Spinner,
  useToast,
} from "../../shared/ui";
import { DocumentView } from "./DocumentView";
import { ShapingPanel } from "./shaping/ShapingPanel";
import { refreshCampus, setCampusData, useCampusState } from "./store";
import type { CampusDetail, CampusSummary, Template } from "./types";
import "./campus.css";
import { apiErrorMessage } from "../../shared/errors";

function message(err: unknown, fallback: string): string {
  return apiErrorMessage(err, fallback);
}

const MEMBER_LABELS = {
  professor: "Docente",
  guest: "Docente invitado",
  student: "Estudiante",
} as const;

/** /campuses: the campuses the user can open. */
export function CampusListPage() {
  const [campuses, setCampuses] = useState<CampusSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiGet<CampusSummary[]>("/campuses")
      .then((list) => !cancelled && setCampuses(list))
      .catch((err) => !cancelled && setError(message(err, "No se pudieron cargar los campus.")));
    return () => {
      cancelled = true;
    };
  }, []);

  const create = (
    <Link to="/campuses/new" className="au-btn au-btn--primary">
      Crear campus
    </Link>
  );

  return (
    <>
      <PageHeader
        title="Campus"
        subtitle="Los campus que administrás o en los que das clase."
        actions={create}
      />
      {error && <p role="alert">{error}</p>}
      {!error && campuses === null && <Spinner />}
      {campuses && campuses.length === 0 && (
        <EmptyState
          title="Todavía no hay campus"
          description="Elegí una plantilla y creá el primero."
          action={create}
        />
      )}
      {campuses && campuses.length > 0 && (
        <ul className="cm-templates">
          {campuses.map((campus) => (
            <li key={campus.id}>
              <Card
                title={<Link to={`/campuses/${campus.id}`}>{campus.name}</Link>}
                actions={
                  campus.member_role ? (
                    <Badge>{MEMBER_LABELS[campus.member_role]}</Badge>
                  ) : undefined
                }
              />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** /campuses/new: pick a template, name the campus, create it. */
export function NewCampusPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiGet<Template[]>("/campus-templates")
      .then((list) => {
        if (cancelled) return;
        setTemplates(list);
        setSelected((current) => current ?? list[0]?.key ?? null);
      })
      .catch(
        (err) => !cancelled && setLoadError(message(err, "No se pudieron cargar las plantillas.")),
      );
    return () => {
      cancelled = true;
    };
  }, []);

  const chosen = templates?.find((t) => t.key === selected) ?? null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setNameError("Escribí un nombre para el campus.");
      return;
    }
    if (!selected) return;
    setNameError(undefined);
    setBusy(true);
    try {
      const created = await apiPost<CampusDetail>("/campuses", {
        name: name.trim(),
        template_key: selected,
      });
      setCampusData(String(created.id), created);
      navigate(`/campuses/${created.id}`);
    } catch (err) {
      toast.show({ tone: "error", message: message(err, "No se pudo crear el campus.") });
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Crear campus"
        subtitle="Elegí una plantilla como punto de partida; después podés darle forma al campus."
      />
      {loadError && <p role="alert">{loadError}</p>}
      {!loadError && templates === null && <Spinner />}
      {templates && (
        <form className="cm-stack" onSubmit={submit} noValidate>
          <ul className="cm-templates" aria-label="Plantillas">
            {templates.map((template) => (
              <li key={template.key}>
                <button
                  type="button"
                  className="cm-template"
                  aria-pressed={template.key === selected}
                  onClick={() => setSelected(template.key)}
                >
                  <span className="cm-template__name">{template.name}</span>
                  <span>{template.description}</span>
                  <ol className="cm-outline">
                    {template.document.sections.slice(0, 5).map((section) => (
                      <li key={section.id}>{section.title}</li>
                    ))}
                  </ol>
                </button>
              </li>
            ))}
          </ul>
          {chosen && (
            <Card title={`Vista previa: ${chosen.name}`}>
              <DocumentView document={chosen.document} />
            </Card>
          )}
          <Card>
            <div className="cm-stack">
              <Input
                label="Nombre del campus"
                value={name}
                onChange={(e) => setName(e.target.value)}
                error={nameError}
                maxLength={200}
                autoComplete="off"
              />
              <div className="au-row">
                <Button type="submit" loading={busy} disabled={!selected}>
                  Crear campus
                </Button>
                <Link to="/campuses">Cancelar</Link>
              </div>
            </div>
          </Card>
        </form>
      )}
    </>
  );
}

/** The campus page: the document, read-only for students; teachers also get the shaping slot. */
export function CampusOverviewTab() {
  const { id = "" } = useParams();
  const { data, error } = useCampusState(id);

  if (!data) {
    return error ? (
      <EmptyState title="No se pudo abrir el campus" description={error.message} />
    ) : (
      <Spinner />
    );
  }
  const canManage = data.access === "manage";
  return (
    <div className="cm-stack">
      {canManage && (
        <ShapingPanel
          campusId={data.id}
          version={data.version}
          document={data.document}
          onChanged={() => void refreshCampus(id)}
        />
      )}
      <DocumentView document={data.document} showHidden={data.access !== "view"} />
    </div>
  );
}
