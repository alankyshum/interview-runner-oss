import type { LibraryItem } from './LibraryPanel';

export const isDateOnly = (value: string) => value.length === 10;
export function deadlineDate(value: string): Date {
  if (!isDateOnly(value)) return new Date(value);
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0); date.setFullYear(year!, month! - 1, day!); date.setHours(0, 0, 0, 0); return date;
}
export function deadlineEnd(value: string): number {
  const date = deadlineDate(value);
  if (isDateOnly(value)) date.setDate(date.getDate() + 1);
  return date.getTime();
}
export const deadlineSortTime = (value: string) => deadlineEnd(value) - (isDateOnly(value) ? 1 : 0);
// Gregorian ordinal from local calendar fields, independent of DST and UTC offsets.
export function dayNumber(date: Date): number {
  let year = date.getFullYear(); const month = date.getMonth() + 1;
  year -= month <= 2 ? 1 : 0;
  const era = Math.floor(year / 400), y = year - era * 400;
  const m = month + (month > 2 ? -3 : 9);
  return era * 146097 + y * 365 + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor((153 * m + 2) / 5) + date.getDate();
}
export function calendarDays(now: Date): Date[] {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay());
  return Array.from({ length: 28 }, (_, index) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + index));
}
export function absoluteDeadline(value: string): string {
  const date = deadlineDate(value);
  const day = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).format(date).replace(',', '');
  if (isDateOnly(value)) return day;
  const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(date);
  return `${day}, ${time}`;
}
export function deadlineCopy(value: string, now: Date, active = true): { absolute: string; relative: string; tone: 'normal' | 'soon' | 'overdue' } {
  const absolute = absoluteDeadline(value);
  if (!active) return { absolute, relative: '', tone: 'normal' };
  const date = deadlineDate(value), days = dayNumber(date) - dayNumber(now), delta = deadlineEnd(value) - now.getTime();
  const overdue = delta <= 0;
  const recentTimed = !isDateOnly(value) && (days === 0 || (overdue && -delta < 24 * 60 * 60 * 1000));
  let relative: string;
  if (recentTimed && Math.abs(delta) < 60_000) relative = 'Due now';
  else if (recentTimed && Math.abs(delta) < 3_600_000) {
    const minutes = Math.max(1, Math.floor(Math.abs(delta) / 60_000)); relative = overdue ? `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} overdue` : `in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  } else if (recentTimed) {
    const hours = Math.max(1, Math.floor(Math.abs(delta) / 3_600_000)); relative = overdue ? `${hours} ${hours === 1 ? 'hour' : 'hours'} overdue` : `in ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  } else if (overdue) { const count = Math.max(1, -days); relative = `${count} ${count === 1 ? 'day' : 'days'} overdue`; }
  else if (days === 0) relative = 'Today';
  else if (days === 1) relative = 'Tomorrow';
  else relative = `in ${days} days`;
  return { absolute, relative, tone: overdue ? 'overdue' : days <= 1 ? 'soon' : 'normal' };
}
export function activeDeadlines(items: LibraryItem[]): LibraryItem[] {
  return items.filter((item) => item.kind === 'course' && item.status === 'active' && item.deadline);
}
export function nextDeadline(items: LibraryItem[], now: Date): LibraryItem | undefined {
  return activeDeadlines(items).filter((item) => deadlineEnd(item.deadline!) > now.getTime()).sort((a, b) => deadlineSortTime(a.deadline!) - deadlineSortTime(b.deadline!) || a.position - b.position)[0];
}
