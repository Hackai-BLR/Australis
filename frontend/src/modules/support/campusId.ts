import { apiGet } from "../../shared/api";

/** The campus the current page belongs to, from /campuses/:id/... (null elsewhere). */
export function campusIdOf(pathname: string): number | null {
  const match = /^\/campuses\/(\d+)(\/|$)/.exec(pathname);
  return match ? Number(match[1]) : null;
}

/** The class of a /classes/:cid page (null elsewhere). */
export function classIdOf(pathname: string): number | null {
  const match = /^\/classes\/(\d+)(\/|$)/.exec(pathname);
  return match ? Number(match[1]) : null;
}

/**
 * The campus a page belongs to. Class pages live outside /campuses/:id, so their campus is read
 * from the class itself; if that fails the report is filed without a campus.
 */
export async function resolveCampusId(pathname: string): Promise<number | null> {
  const direct = campusIdOf(pathname);
  if (direct !== null) return direct;
  const classId = classIdOf(pathname);
  if (classId === null) return null;
  try {
    const item = await apiGet<{ campus_id: number }>(`/classes/${classId}`);
    return typeof item.campus_id === "number" ? item.campus_id : null;
  } catch {
    return null;
  }
}

/** True for a same-origin path ("/x"), never a URL with a scheme or a "//host" one. */
export function isInAppPath(page: string): boolean {
  if (!page.startsWith("/") || page.startsWith("//")) return false;
  return ![...page].some((c) => c === "\\" || c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);
}
