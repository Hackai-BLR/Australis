import { Badge, Card, EmptyState } from "../../shared/ui";
import type { Block, CampusDocument, WidgetKind } from "./types";
import "./campus.css";

const WIDGETS: Record<WidgetKind, { title: string; text: string }> = {
  classes: { title: "Clases", text: "Acá va a aparecer la lista de clases del curso." },
  join_class: {
    title: "Unirse a la clase de hoy",
    text: "Acá va a aparecer el botón para entrar a la clase del día.",
  },
  recordings: {
    title: "Grabaciones",
    text: "Acá van a aparecer las grabaciones y sus transcripciones.",
  },
  grades: { title: "Calificaciones", text: "Acá van a aparecer tus calificaciones." },
};

/** A widget names live data. Until its feature exists it renders a neutral placeholder card. */
function WidgetCard({ widget }: { widget: WidgetKind }) {
  const info = WIDGETS[widget] ?? { title: "Contenido del campus", text: "" };
  return (
    <div className="cm-widget" data-widget={widget}>
      <p className="cm-widget__title">
        {info.title} <Badge>Próximamente</Badge>
      </p>
      {info.text && <p>{info.text}</p>}
    </div>
  );
}

function isWebUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/** Block text is plain text: it is rendered as text, never as markdown or HTML. */
function BlockView({ block }: { block: Block }) {
  switch (block.type) {
    case "text":
      return <p className="cm-text">{block.text}</p>;
    case "callout":
      return (
        <p className="cm-callout" role="note">
          {block.text}
        </p>
      );
    case "link":
      return isWebUrl(block.url) ? (
        <a href={block.url} target="_blank" rel="noopener noreferrer">
          {block.label}
        </a>
      ) : (
        <span>{block.label}</span>
      );
    case "checklist":
      return (
        <ul className="cm-checklist">
          {block.items.map((item, i) => (
            <li key={i}>
              <span aria-hidden="true">☐</span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
      );
    case "widget":
      return <WidgetCard widget={block.widget} />;
    default:
      return null;
  }
}

/** Read-only rendering of a campus document. Teachers also see which sections are hidden. */
export function DocumentView({
  document,
  showHidden = false,
}: {
  document: CampusDocument;
  showHidden?: boolean;
}) {
  const sections = document.sections.filter((s) => s.visible || showHidden);
  if (sections.length === 0) {
    return (
      <EmptyState
        title="Este campus todavía no tiene contenido"
        description="Cuando el docente agregue secciones, las vas a ver acá."
      />
    );
  }
  return (
    <div className="cm-stack">
      {sections.map((section) => (
        <Card
          key={section.id}
          title={section.title}
          actions={
            !section.visible ? <Badge tone="warning">Oculta para estudiantes</Badge> : undefined
          }
        >
          <div className="cm-stack">
            {section.blocks.map((block) => (
              <BlockView key={block.id} block={block} />
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}
