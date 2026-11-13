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
  starts_at: string;
  simulated: boolean;
  ended_at: string | null;
};
export type MyGrades = {
  courses: { campus_name: string; items: { item_id: number; score: number | null }[] }[];
};

/** Grades carry no timestamp in the API, so "seen" is remembered per item and score. */
export function gradeKey(itemId: number, score: number): string {
  return `${itemId}:${score}`;
}

/** Every graded item currently present, as seen-keys. */
export function allGradeKeys(grades: MyGrades | null): string[] {
  return (grades?.courses ?? []).flatMap((c) =>
    c.items.filter((i) => i.score !== null).map((i) => gradeKey(i.item_id, i.score as number)),
  );
}

/** A recording older than this is history, not news. */
export const RECENT_DAYS = 7;

function utc(value: string): number {
  return new Date(value.replace(" ", "T") + "Z").getTime();
}

/** When the class happened: its end, or its start if nobody ended it. */
function happenedAt(c: ClassRow): string {
  return c.ended_at ?? c.starts_at;
}

export type Step =
  | { kind: "class"; item: TodayItem }
  | { kind: "recording"; item: ClassRow }
  | {
      kind: "grade";
      count: number;
      keys: string[];
      campus: string;
      otherCourses: number;
    }
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
  seenGrades: string[],
  now: Date = new Date(),
): Step {
  const live = today
    .filter((c) => c.ended_at === null && !isOver(c, now))
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  if (live.length > 0) return { kind: "class", item: live[0] };
  const fresh = classes
    .filter(
      (c) =>
        READY.includes(c.recording_status) &&
        !seenRecordings.includes(c.id) &&
        now.getTime() - utc(happenedAt(c)) <= RECENT_DAYS * 86_400_000,
    )
    .sort((a, b) => utc(happenedAt(b)) - utc(happenedAt(a)));
  if (fresh.length > 0) return { kind: "recording", item: fresh[0] };
  const perCourse = (grades?.courses ?? [])
    .map((c) => ({
      campus: c.campus_name,
      keys: c.items
        .filter((i) => i.score !== null && !seenGrades.includes(gradeKey(i.item_id, i.score)))
        .map((i) => gradeKey(i.item_id, i.score as number)),
    }))
    .filter((c) => c.keys.length > 0);
  if (perCourse.length > 0) {
    const main = perCourse.reduce((a, b) => (b.keys.length > a.keys.length ? b : a));
    return {
      kind: "grade",
      count: perCourse.reduce((n, c) => n + c.keys.length, 0),
      keys: perCourse.flatMap((c) => c.keys),
      campus: main.campus,
      otherCourses: perCourse.length - 1,
    };
  }
  return { kind: "none" };
}
