import type { ClassItem } from "../api";
import { AttendancePanel } from "./AttendancePanel";

/** Mounted on the class page: the attendance panel (F10). */
export function AttendanceSlot({ classItem }: { classItem: ClassItem }) {
  return (
    <div data-slot="class-attendance" data-class-id={classItem.id}>
      <AttendancePanel classItem={classItem} />
    </div>
  );
}
