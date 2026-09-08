export const HOTWORD_LIMIT = 200;
export type HotwordStatus = {
  words: string[];
  updatedAt: number | null;
  sync: 'empty' | 'pending' | 'ready' | 'error';
  message?: string;
  models: { model: string; label: string; supported: boolean; ready: boolean }[];
};

export function normalizeHotwords(value: unknown): string[] {
  if (typeof value !== 'string' || value.length > 30_000) throw new Error('热词内容无效');
  const words = [...new Set(value.split(/[\n,，;；]/u).map(word => word.trim().replace(/\s+/gu, ' ')).filter(Boolean))];
  if (words.length > HOTWORD_LIMIT) throw new Error(`最多保存 ${HOTWORD_LIMIT} 个热词`);
  if (words.some(word => /[\u0000-\u001f\u007f]/u.test(word) || word.length > 100
    || (/[^\x00-\x7f]/u.test(word) ? [...word].length > 15 : word.split(' ').length > 7))) {
    throw new Error('含中文的热词最多 15 个字，英文最多 7 个单词、100 个字符');
  }
  return words;
}
