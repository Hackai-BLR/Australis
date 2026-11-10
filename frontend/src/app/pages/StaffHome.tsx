import { Link } from "react-router-dom";
import { TodayClass } from "../../modules/classes";
import { Card, EmptyState, Spinner } from "../../shared/ui";
import { CampusCards, type CampusItem } from "./StudentHome";
import { useLoad } from "./useLoad";
import "./home.css";

export function StaffHome({ secretary }: { secretary: boolean }) {
  const { data, error } = useLoad<CampusItem[]>("/campuses", "No se pudieron cargar los campus.");
  const create = (
    <Link to="/campuses/new" className="au-btn au-btn--primary">
      Crear campus
    </Link>
  );
  return (
    <div className="au-stack">
      <TodayClass />
      <Card
        title={secretary ? "Todos los campus" : "Mis campus"}
        actions={
          <>
            {create}
            <Link to="/campuses">Ver todos</Link>
          </>
        }
      >
        {error ? (
          <p role="alert">{error}</p>
        ) : data === null ? (
          <Spinner />
        ) : data.length === 0 ? (
          <EmptyState
            title="Empezá creando un campus"
            description="Elegí una plantilla, importá a los estudiantes y dale forma al campus con IA."
          />
        ) : (
          <CampusCards items={data} />
        )}
      </Card>
      {secretary && (
        <Card title="Administración" actions={<Link to="/admin/users">Administrar usuarios</Link>}>
          <p style={{ margin: 0 }}>
            Como Secretaría podés ver y administrar todos los campus y los usuarios.
          </p>
        </Card>
      )}
    </div>
  );
}
