export const EMBED_DIMS = 512;
export const EMBED_MODEL = 'doubao-embedding-large-text-250515';

export async function embedTexts(texts: string[]): Promise<number[][]> {
  throw new Error('not implemented');
}

const CJK_CHAR = /[\u3000-\u9fff\uff00-\uffef]/;

function estimateOne(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (CJK_CHAR.test(char)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

export function estimateTokens(texts: string[]): number {
  return texts.reduce((total, text) => total + estimateOne(text), 0);
}
