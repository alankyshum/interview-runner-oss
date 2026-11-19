export function validCourseImage(src: string | null | undefined, alt: string | null | undefined): src is string {
  return Boolean(src && alt?.trim() && src.startsWith('/images/') && !/[\\%?#\u0000-\u0020\u007f]/.test(src) && !src.includes('..') && !src.slice(8).split('/').some((part) => !part || part === '.'));
}
