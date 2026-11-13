export type TodayItem = {
  id: number;
  campus_name: string;
  title: string;
  starts_at: string;
  duration_min: number;
  simulated: boolean;
  join_url: string;
  ended_at: string | null;
};
export type CampusItem = { id: number; name: string };
export type ClassRow = {
  id: number;
  campus_name: string;
  title: string;
  recording_status: string;
  ended_at: string | null;
};
export type MyGrades = {
  courses: { campus_name: string; items: { item_id: number; score: number | null }[] }[];
};

export type Step =
  | { kind: "class"; item: TodayItem }
  | { kind: "recording"; item: ClassRow }
  | { kind: "grade"; count: number; ids: number[]; campus: string }
  | { kind: "none" };

const READY = ["available", "transcript_ready"];

/** The backend treats a class as over once its start plus duration has passed. */
function isOver(c: TodayItem, now: Date): boolean {
  const start = new Date(c.starts_at.replace(" ", "T") + "Z").getTime();
  return start + c.duration_min * 60_000 <= now.getTime();
}

/** Picks the single most urgent step: class today, then a new recording, then a new grade. */
export function pickStep(
  today: TodayItem[],
  classes: ClassRow[],
  grades: MyGrades | null,
  seenRecordings: number[],
  seenGrades: number[],
  now: Date = new Date(),
): Step {
  const live = today
    .filter((c) => c.ended_at === null && !isOver(c, now))
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  if (live.length > 0) return { kind: "class", item: live[0] };
  const fresh = classes
    .filter((c) => READY.includes(c.recording_status) && !seenRecordings.includes(c.id))
    .sort((a, b) => (b.ended_at ?? "").localeCompare(a.ended_at ?? ""));
  if (fresh.length > 0) return { kind: "recording", item: fresh[0] };
  const newGrades = (grades?.courses ?? []).flatMap((c) =>
    c.items
      .filter((i) => i.score !== null && !seenGrades.includes(i.item_id))
      .map((i) => ({ id: i.item_id, campus: c.campus_name })),
  );
  if (newGrades.length > 0) {
    return {
      kind: "grade",
      count: newGrades.length,
      ids: newGrades.map((g) => g.id),
      campus: newGrades[0].campus,
    };
  }
  return { kind: "none" };
}
