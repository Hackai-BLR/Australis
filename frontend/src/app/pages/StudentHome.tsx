import { Link } from "react-router-dom";
import { TodayClass } from "../../modules/classes";
import { Badge, Card, EmptyState, Spinner } from "../../shared/ui";
import { NextStep } from "./NextStep";
import { useLoad } from "./useLoad";
import "./home.css";

export type CampusItem = { id: number; name: string };
type MyCourse = {
  campus_id: number;
  campus_name: string;
  final: number | null;
  scale?: { pass: number };
};
type MyGrades = { scale: { pass: number }; courses: MyCourse[] };

function score(value: number): string {
  return String(Math.round(value * 100) / 100).replace(".", ",");
}

export function CampusCards({ items }: { items: CampusItem[] }) {
  return (
    <ul className="home-grid">
      {items.map((c) => (
        <li key={c.id}>
          <Card title={c.name}>
            <Link to={`/campuses/${c.id}`} className="au-btn au-btn--secondary">
              Entrar al campus
            </Link>
          </Card>
        </li>
      ))}
    </ul>
  );
}

function Courses() {
  const { data, error } = useLoad<CampusItem[]>("/campuses", "No se pudieron cargar tus cursos.");
  return (
    <Card title="Mis cursos">
      {error ? (
        <p role="alert">{error}</p>
      ) : data === null ? (
        <Spinner />
      ) : data.length === 0 ? (
        <EmptyState
          title="Todavía no estás inscripto en ningún curso"
          description="Cuando un docente te agregue a un campus, lo vas a ver acá."
        />
      ) : (
        <CampusCards items={data} />
      )}
    </Card>
  );
}

function GradesSummary() {
  const { data, error } = useLoad<MyGrades>("/grades/mine", "No se pudieron cargar tus notas.");
  return (
    <Card title="Mis notas" actions={<Link to="/grades">Ver todas mis notas</Link>}>
      {error ? (
        <p role="alert">{error}</p>
      ) : data === null ? (
        <Spinner />
      ) : data.courses.length === 0 ? (
        <EmptyState
          title="Sin calificaciones por ahora"
          description="Todas tus notas, de todos tus cursos, van a aparecer en este lugar."
        />
      ) : (
        <ul className="au-stack" style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {data.courses.map((c) => (
            <li key={c.campus_id} className="au-row home-course__final">
              <span>{c.campus_name}</span>
              {c.final === null ? (
                <Badge>Sin nota final</Badge>
              ) : (
                <Badge tone={c.final >= (c.scale ?? data.scale).pass ? "success" : "danger"}>
                  Final: {score(c.final)}
                </Badge>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function StudentHome() {
  return (
    <div className="au-stack">
      <NextStep />
      <TodayClass />
      <GradesSummary />
      <Courses />
    </div>
  );
}
