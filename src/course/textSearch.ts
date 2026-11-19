export const normalizeSearchText = (value: string) => value.normalize("NFKC").toLocaleLowerCase();

export const searchWords = (query: string) => normalizeSearchText(query).trim().split(/\s+/).filter(Boolean);

export function matchesSearchWords(words: string[], fields: Array<string | undefined>): boolean {
  const text = fields.filter((field): field is string => Boolean(field)).map(normalizeSearchText);
  return words.every((word) => text.some((field) => field.includes(word)));
}
