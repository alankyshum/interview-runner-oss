import { useCallback, useEffect, useRef, useState } from 'react';
import type { Course } from '../../shared/courseSchema';

export type RecallProgress = { checked: number; total: number; hasStoredChecks: boolean };
export function useRecallProgress(course: Course | null) {
  const [values, setValues] = useState<Record<string, RecallProgress>>({});
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const versions = useRef<Record<string, number>>({});
  const activeCourse = useRef<string | undefined>(undefined);
  useEffect(() => {
    let active = true;
    if (activeCourse.current !== course?.id) { setValues({}); versions.current = {}; activeCourse.current = course?.id; }
    setError('');
    if (course?.type !== 'map-recall') return;
    const snapshot = { ...versions.current };
    const lessons = course.chapters.flatMap((chapter) => chapter.drills).filter((drill) => drill.contentType === 'recall' || drill.contentType === 'whiteboard');
    void fetch(`/api/recall-progress/${encodeURIComponent(course.id)}`).then(async (response) => {
      if (!response.ok) throw new Error(`Recall progress unavailable (${response.status})`);
      const data: unknown = await response.json();
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid recall progress response');
      const records = data as Record<string, unknown>;
      return lessons.map((drill) => {
        const value = records[drill.id] as Partial<RecallProgress> | undefined;
        if (!value || !Number.isInteger(value.checked) || !Number.isInteger(value.total) || value.checked! < 0 || value.total! < value.checked! || typeof value.hasStoredChecks !== 'boolean') throw new Error(`Invalid recall progress for ${drill.title}`);
        return [drill.id, { checked: value.checked!, total: value.total!, hasStoredChecks: value.hasStoredChecks }] as const;
      });
    }).then((entries) => { if (active) setValues((current) => Object.fromEntries(entries.map(([id, value]) => [id, versions.current[id] !== snapshot[id] ? current[id] : value]))); }).catch((failure: unknown) => { if (active) setError(failure instanceof Error ? failure.message : 'Recall progress unavailable'); });
    return () => { active = false; };
  }, [course?.id, course?.type, retry]);
  const update = useCallback((id: string, value: Pick<RecallProgress, 'checked' | 'total'>) => { versions.current[id] = (versions.current[id] ?? 0) + 1; setValues((current) => ({ ...current, [id]: { ...value, hasStoredChecks: value.checked > 0 || Boolean(current[id]?.hasStoredChecks) } })); }, []);
  return { values, error, retry: () => setRetry((value) => value + 1), update };
}
