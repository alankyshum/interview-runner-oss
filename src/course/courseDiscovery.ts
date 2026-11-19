import { matchesSearchWords, searchWords } from "./textSearch";

export type CourseSummary = { id: string; title: string; company?: string; tier?: 1 | 2 | 3; role?: string; deadline?: string; tags?: string[]; createdAt?: string; updatedAt?: string };
export type CourseSort = "updated" | "created" | "alphabetical";
export const COURSE_SORT_STORAGE_KEY = "interview-runner-course-sort";

export function readCourseSort(getItem: () => string | null = () => localStorage.getItem(COURSE_SORT_STORAGE_KEY)): CourseSort {
  try {
    const value = getItem();
    return value === "created" || value === "alphabetical" || value === "updated" ? value : "updated";
  } catch {
    return "updated";
  }
}

function timestamp(value?: string): number {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

export function discoverCourses<T extends CourseSummary>(courses: T[], query: string, sort: CourseSort): T[] {
  const words = searchWords(query);
  const filtered = courses.filter((course) => matchesSearchWords(words, [course.title, course.company, course.role, ...(course.tags ?? [])]));
  return [...filtered].sort((a, b) => {
    if (sort === "alphabetical") return a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id);
    const dateOrder = sort === "created"
      ? timestamp(b.createdAt) - timestamp(a.createdAt)
      : timestamp(b.updatedAt ?? b.createdAt) - timestamp(a.updatedAt ?? a.createdAt);
    return dateOrder || a.id.localeCompare(b.id);
  });
}
