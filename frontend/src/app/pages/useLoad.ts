import { useEffect, useState } from "react";
import { ApiError, apiGet } from "../../shared/api";

export type Loaded<T> = { data: T | null; error: string | null };

/** Fetches `path` once. `error` holds a Spanish message when the request fails. */
export function useLoad<T>(path: string, fallback: string): Loaded<T> {
  const [state, setState] = useState<Loaded<T>>({ data: null, error: null });
  useEffect(() => {
    let alive = true;
    apiGet<T>(path)
      .then((data) => alive && setState({ data, error: null }))
      .catch(
        (e: unknown) =>
          alive && setState({ data: null, error: e instanceof ApiError ? e.message : fallback }),
      );
    return () => {
      alive = false;
    };
  }, [path, fallback]);
  return state;
}
