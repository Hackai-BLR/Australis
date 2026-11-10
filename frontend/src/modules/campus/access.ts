import { useAuth } from "../../shared/auth";
import type { CampusAccess } from "../../shared/routing";
import { useCampusState } from "./store";

/**
 * The current user's access level on a campus, from the membership the API returns (a professor
 * may be only a guest). While the campus is loading it guesses from the account role so the tabs
 * do not flash a "no access" message; it is null once the API refuses or the id is unknown. The
 * backend checks every request anyway.
 */
export function useCampusAccess(campusId: string): CampusAccess | null {
  const { user } = useAuth();
  const state = useCampusState(campusId);
  if (!user || !campusId) return null;
  if (state.data) return state.data.access;
  if (state.error) return null;
  return user.role === "student" ? "view" : "manage";
}
