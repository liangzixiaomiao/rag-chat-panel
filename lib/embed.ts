export const EMBED_DIMS = 512;
export const EMBED_MODEL = 'doubao-embedding-large-text-250515';

export async function embedTexts(texts: string[]): Promise<number[][]> {
  throw new Error('not implemented');
}

export function estimateTokens(texts: string[]): number {
  throw new Error('not implemented');
}
