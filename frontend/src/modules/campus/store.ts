// A small shared cache of the campus being viewed. The layout, the header and the tabs all need
// the same campus, so they read it from here instead of each fetching it.
import { useEffect, useSyncExternalStore } from "react";
import { ApiError, apiGet } from "../../shared/api";
import type { CampusDetail } from "./types";

export type CampusState = {
  data: CampusDetail | null;
  error: ApiError | null;
  loading: boolean;
};

type Entry = { state: CampusState; listeners: Set<() => void>; inflight: Promise<void> | null };

const entries = new Map<string, Entry>();

function entryFor(id: string): Entry {
  let entry = entries.get(id);
  if (!entry) {
    entry = {
      state: { data: null, error: null, loading: false },
      listeners: new Set(),
      inflight: null,
    };
    entries.set(id, entry);
  }
  return entry;
}

function update(id: string, patch: Partial<CampusState>) {
  const entry = entryFor(id);
  entry.state = { ...entry.state, ...patch };
  entry.listeners.forEach((listener) => listener());
}

/** Loads the campus again (requests made at the same time share one fetch). */
export function refreshCampus(id: string): Promise<void> {
  const entry = entryFor(id);
  if (entry.inflight) return entry.inflight;
  update(id, { loading: true });
  const run = apiGet<CampusDetail>(`/campuses/${encodeURIComponent(id)}`)
    .then((data) => update(id, { data, error: null, loading: false }))
    .catch((err: unknown) => {
      const error = err instanceof ApiError ? err : new ApiError(0, "No se pudo cargar el campus.");
      // A refusal means the user has no access: forget what we had.
      const forget = error.status === 403 || error.status === 404;
      update(id, { error, loading: false, ...(forget ? { data: null } : {}) });
    })
    .finally(() => {
      entry.inflight = null;
    });
  entry.inflight = run;
  return run;
}

/** Stores a campus the API just returned (after a save or a restore). */
export function setCampusData(id: string, data: CampusDetail) {
  update(id, { data, error: null });
}

/** For tests. */
export function resetCampusStore() {
  entries.clear();
}

/** The campus with the given id; it is fetched when a component first uses it. */
export function useCampusState(id: string): CampusState {
  const entry = entryFor(id);
  const state = useSyncExternalStore(
    (listener) => {
      entry.listeners.add(listener);
      return () => entry.listeners.delete(listener);
    },
    () => entry.state,
  );
  useEffect(() => {
    if (id) void refreshCampus(id);
  }, [id]);
  return state;
}
