import { useEffect, useState } from 'react';
import { deadlineCopy, deadlineDate, isDateOnly } from './deadlines';
import './DeadlineLine.css';

export function useDeadlineClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const update = () => setNow(new Date());
    const timer = setInterval(update, 60_000);
    document.addEventListener('visibilitychange', update);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', update); };
  }, []);
  return now;
}
export function compactDeadline(value: string, active: boolean, now: Date) {
  const { relative } = deadlineCopy(value, now, active);
  const date = deadlineDate(value), two = (number: number) => String(number).padStart(2, '0');
  const day = new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(date);
  const compact = `${day} ${two(date.getMonth() + 1)}/${two(date.getDate())}${isDateOnly(value) ? '' : ` ${two(date.getHours())}:${two(date.getMinutes())}`}`;
  const shortRelative = relative.toLowerCase().replace(/\b(\d+) (days?|hours?|minutes?)\b/g, (_, count: string, unit: string) => `${count}${unit[0]}`);
  return { compact, shortRelative };
}
export function DeadlineLine({ value, active, now, heading = false }: { value: string; active: boolean; now: Date; heading?: boolean }) {
  const { absolute, relative, tone } = deadlineCopy(value, now, active);
  const text = `${absolute}${relative ? ` · ${relative}` : ''}`;
  if (heading) return <span className="deadline-line deadline-line-heading" data-tone={tone} title={text}><span className="deadline-absolute">{absolute}</span>{relative && <><span className="deadline-separator"> · </span><span className="deadline-relative">{relative}</span></>}</span>;
  const { compact, shortRelative } = compactDeadline(value, active, now);
  return <span className="deadline-row-line" title={text}><span className="metadata-pill deadline-pill" data-tone={tone}>{compact}</span>{shortRelative && <> <span className="deadline-row-relative">{shortRelative}</span></>}</span>;
}
export function HeadingDeadline({ value, active }: { value: string; active: boolean }) {
  const now = useDeadlineClock();
  return <DeadlineLine value={value} active={active} now={now} heading />;
}
