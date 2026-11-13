import { NextResponse } from 'next/server';
import { z } from 'zod';
import { retrieve } from '@/lib/retrieve';

const bodySchema = z.object({
  question: z.string().min(1),
  documentId: z.string().min(1),
});

export async function POST(request: Request): Promise<NextResponse> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: '请求体必须是合法 JSON' }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json({ error: '缺少 question 或 documentId' }, { status: 400 });
  }

  // 与 embed 的 token 化字符集保持一致：纯标点/空白提取不到 token 的问题直接拒绝
  if (!/[\u3400-\u9fffa-zA-Z0-9]/.test(parsed.data.question)) {
    return NextResponse.json({ error: '请输入有效的问题' }, { status: 400 });
  }

  const result = await retrieve({
    question: parsed.data.question,
    documentId: parsed.data.documentId,
  });

  return NextResponse.json(result);
}
