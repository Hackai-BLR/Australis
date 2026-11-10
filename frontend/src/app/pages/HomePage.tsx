import { useAuth, type User } from "../../shared/auth";
import { PageHeader } from "../../shared/ui";
import { StaffHome } from "./StaffHome";
import { StudentHome } from "./StudentHome";

function firstName(user: User): string {
  return user.full_name.split(" ")[0] || user.full_name;
}

/** The home page by role: student, professor or secretary. */
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
