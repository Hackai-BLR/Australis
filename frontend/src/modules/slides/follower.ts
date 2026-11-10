// State of a follower of a live presentation. Pure, so the rules are easy to test:
//  - a server state with a lower seq than the one held is dropped (messages can arrive late
//    or out of order, and the poll can return something older than the stream);
//  - a student who browses on their own keeps their page while the professor moves on;
//  - "Volver al vivo" drops the local page, so the view follows the professor again.

export type LiveState = {
  id: number;
  presentation_id: number;
  campus_id: number;
  status: "live" | "ended";
  current_page: number;
  page_count: number;
  seq: number;
};

export type FollowerState = {
  live: LiveState | null;
  /** The page the student browsed to, or null while following the professor. */
  localPage: number | null;
};

export type FollowerAction =
  | { type: "server"; state: LiveState }
  | { type: "browse"; page: number }
  | { type: "backToLive" }
  | { type: "reset" };

export const initialFollower: FollowerState = { live: null, localPage: null };

function clamp(page: number, count: number): number {
  return Math.max(1, Math.min(Math.round(page), Math.max(1, count)));
}

export function followerReducer(state: FollowerState, action: FollowerAction): FollowerState {
  switch (action.type) {
    case "server": {
      const incoming = action.state;
      const held = state.live;
      if (held && held.id === incoming.id && incoming.seq < held.seq) return state;
      // A different session (the professor started another one) starts fresh.
      const sameSession = held !== null && held.id === incoming.id;
      // The professor arriving at the student's page means the student follows again.
      const keep = sameSession && state.localPage !== incoming.current_page;
      return { live: incoming, localPage: keep ? state.localPage : null };
    }
    case "browse": {
      if (!state.live) return state;
      const page = clamp(action.page, state.live.page_count);
      // Browsing onto the professor's page is following again.
      return { ...state, localPage: page === state.live.current_page ? null : page };
    }
    case "backToLive":
      return { ...state, localPage: null };
    case "reset":
      return initialFollower;
  }
}

/** The page to show: the local one while browsing, else the professor's. */
export function viewPage(state: FollowerState): number {
  return state.localPage ?? state.live?.current_page ?? 1;
}

/** True when the student is on a page other than the professor's. */
export function isBehindLive(state: FollowerState): boolean {
  return state.live?.status === "live" && state.localPage !== null
    ? state.localPage !== state.live.current_page
    : false;
}

/** True while the student holds their own page; the view is then not following the professor. */
export function isBrowsing(state: FollowerState): boolean {
  return state.localPage !== null;
}
