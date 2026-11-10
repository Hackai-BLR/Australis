import { EmptyState, PageHeader } from "../../shared/ui";

// Placeholder: the auth package replaces it with user management (secretary only).
export function UsersPage() {
  return (
    <>
      <PageHeader title="Usuarios" subtitle="Docentes, estudiantes y personal de Secretaría." />
      <EmptyState
        title="Gestión de usuarios"
        description="Acá vas a invitar usuarios y suspender cuentas."
      />
    </>
  );
}
