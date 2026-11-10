import { describe, expect, it } from "vitest";
import {
  followerReducer,
  initialFollower,
  isBehindLive,
  viewPage,
  type FollowerState,
  type LiveState,
} from "./follower";

function live(seq: number, page: number, id = 1): LiveState {
  return {
    id,
    presentation_id: 7,
    campus_id: 3,
    status: "live",
    current_page: page,
    page_count: 10,
    seq,
  };
}

function apply(state: FollowerState, ...states: LiveState[]) {
  return states.reduce((s, l) => followerReducer(s, { type: "server", state: l }), state);
}

describe("followerReducer", () => {
  it("follows the professor's page", () => {
    const state = apply(initialFollower, live(1, 2), live(2, 3));
    expect(viewPage(state)).toBe(3);
  });

  it("drops a state with a lower seq", () => {
    const state = apply(initialFollower, live(5, 4), live(3, 1));
    expect(state.live?.seq).toBe(5);
    expect(viewPage(state)).toBe(4);
  });

  it("keeps the local page while browsing", () => {
    let state = apply(initialFollower, live(1, 2));
    state = followerReducer(state, { type: "browse", page: 8 });
    state = apply(state, live(2, 3));
    expect(viewPage(state)).toBe(8);
    expect(isBehindLive(state)).toBe(true);
    expect(state.live?.current_page).toBe(3);
  });

  it("re-follows after back to live", () => {
    let state = apply(initialFollower, live(1, 2));
    state = followerReducer(state, { type: "browse", page: 8 });
    state = apply(state, live(2, 5));
    state = followerReducer(state, { type: "backToLive" });
    expect(viewPage(state)).toBe(5);
    state = apply(state, live(3, 6));
    expect(viewPage(state)).toBe(6);
    expect(isBehindLive(state)).toBe(false);
  });

  it("clamps browsing to the page count", () => {
    let state = apply(initialFollower, live(1, 2));
    state = followerReducer(state, { type: "browse", page: 99 });
    expect(viewPage(state)).toBe(10);
    state = followerReducer(state, { type: "browse", page: -3 });
    expect(viewPage(state)).toBe(1);
  });

  it("starts fresh on a new session even with a lower seq", () => {
    let state = apply(initialFollower, live(9, 4, 1));
    state = followerReducer(state, { type: "browse", page: 7 });
    state = apply(state, live(0, 1, 2));
    expect(state.live?.id).toBe(2);
    expect(viewPage(state)).toBe(1);
  });
});
