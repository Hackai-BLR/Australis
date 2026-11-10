import { Link } from "react-router-dom";
import { EmptyState } from "../../shared/ui";

export function NotFoundPage() {
  return (
    <EmptyState
      title="No encontramos esta página"
      description="Puede que el enlace esté mal escrito o que la página ya no exista."
      action={<Link to="/">Volver al inicio</Link>}
    />
  );
}
