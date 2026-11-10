import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { openEventStream } from "../../shared/api";
import { liveState } from "./api";
import { followerReducer, initialFollower, type FollowerState, type LiveState } from "./follower";

export const POLL_MS = 15_000;
export const POLL_FAST_MS = 3_000;

/**
 * Follows a live session: the stream pushes every change, a safety poll of /state covers a
 * stream that is down or a missed message (faster while the stream is down), and the state
 * is refetched when the tab becomes visible again. The reducer drops anything older.
 */
export function useLiveFollow(
  liveId: number | null,
  initial?: LiveState | null,
): {
  state: FollowerState;
  dispatch: React.Dispatch<Parameters<typeof followerReducer>[1]>;
  connected: boolean;
  resync: () => void;
} {
  const [state, dispatch] = useReducer(followerReducer, initialFollower, (s) =>
    initial ? followerReducer(s, { type: "server", state: initial }) : s,
  );
  const [connected, setConnected] = useState(false);
  const idRef = useRef(liveId);
  idRef.current = liveId;

  const resync = useCallback(() => {
    const id = idRef.current;
    if (id === null) return;
    liveState(id)
      .then((s) => {
        if (idRef.current === id) dispatch({ type: "server", state: s });
      })
      .catch(() => {
        // The next poll tries again.
      });
  }, []);

  useEffect(() => {
    if (liveId === null) return;
    setConnected(false);
    const stream = openEventStream(`/live/${liveId}/stream`, {
      onOpen: () => setConnected(true),
      onError: () => setConnected(false),
      onMessage: (data) => {
        if (data && typeof data === "object") {
          dispatch({ type: "server", state: data as LiveState });
        }
      },
    });
    resync();
    return () => stream.close();
  }, [liveId, resync]);

  useEffect(() => {
    if (liveId === null) return;
    const timer = setInterval(resync, connected ? POLL_MS : POLL_FAST_MS);
    return () => clearInterval(timer);
  }, [liveId, connected, resync]);

  useEffect(() => {
    if (liveId === null) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") resync();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [liveId, resync]);

  return { state, dispatch, connected, resync };
}
