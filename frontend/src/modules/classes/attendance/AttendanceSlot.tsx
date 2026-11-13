import type { ClassItem } from "../api";

/** Seam for F10: replace the body with the attendance panel. Mounted on the class page. */
export function AttendanceSlot({ classItem }: { classItem: ClassItem }) {
  return <div data-slot="class-attendance" data-class-id={classItem.id} hidden />;
}
