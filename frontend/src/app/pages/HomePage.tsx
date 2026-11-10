import { Link } from "react-router-dom";
import { useAuth, type User } from "../../shared/auth";
import { Card, EmptyState, PageHeader } from "../../shared/ui";

// Placeholder home per role. The student home (all courses and all grades in one place) and the
// professor home are filled in by later packages.

function firstName(user: User): string {
  return user.full_name.split(" ")[0] || user.full_name;
}

function StudentHome() {
  return (
    <div className="au-stack">
      <Card title="Mis cursos">
        <EmptyState
          title="Todavía no estás inscripto en ningún curso"
          description="Cuando un docente te agregue a un campus, lo vas a ver acá."
        />
      </Card>
      <Card title="Mis calificaciones">
        <EmptyState
          title="Sin calificaciones por ahora"
          description="Todas tus notas, de todos tus cursos, van a aparecer en este lugar."
        />
      </Card>
    </div>
  );
}

function StaffHome({ secretary }: { secretary: boolean }) {
  return (
    <div className="au-stack">
      <Card title="Mis campus" actions={<Link to="/campuses">Ver todos</Link>}>
        <EmptyState
          title="Empezá creando un campus"
          description="Elegí una plantilla, importá a los estudiantes y dale forma al campus con IA."
        />
      </Card>
      {secretary && (
        <Card title="Administración" actions={<Link to="/users">Usuarios</Link>}>
          <p style={{ margin: 0 }}>
            Como Secretaría podés ver y administrar todos los campus y los usuarios.
          </p>
        </Card>
      )}
    </div>
  );
}

export function HomePage() {
  const { user } = useAuth();
  if (!user) return null;
  return (
    <>
      <PageHeader title={`Hola, ${firstName(user)}`} subtitle="Este es tu inicio en Australis." />
      {user.role === "student" ? (
        <StudentHome />
      ) : (
        <StaffHome secretary={user.role === "secretary"} />
      )}
    </>
  );
}
