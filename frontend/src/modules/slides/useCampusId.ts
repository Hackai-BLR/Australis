import { useParams } from "react-router-dom";

/** The campus id of the current /campuses/:id route. */
export function useCampusId(): string {
  return useParams().id ?? "";
}
