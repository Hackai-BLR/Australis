import { useAuth } from "../../shared/auth";
import type { CampusAccess } from "../../shared/routing";

/**
 * The current user's access level on a campus, used to pick which tabs to show; null while
 * unknown or when the user has no access. Placeholder: guesses from the global role. The campus
 * package replaces it with the membership returned by the API (a professor may be only a guest).
 */
export function useCampusAccess(campusId: string): CampusAccess | null {
  const { user } = useAuth();
  if (!user || !campusId) return null;
  if (user.role === "student") return "view";
  return "manage";
}
