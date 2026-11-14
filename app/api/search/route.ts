import { NextResponse } from 'next/server';
import { z } from 'zod';
import { retrieve } from '@/lib/retrieve';

const bodySchema = z.object({
  question: z.string().min(1),
  scope: z.enum(['current', 'all', 'selected']).optional(),
  documentId: z.string().min(1).optional(),
  documentIds: z.array(z.string().min(1)).max(20).optional(),
  topK: z.number().int().min(1).max(100).optional(),
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
    return NextResponse.json({ error: '缺少 question，或 scope/documentId/documentIds 格式不对' }, { status: 400 });
  }

  // 不传 scope 时按 current 处理，保持旧调用方兼容；scope=all 时必须显式声明，不做静默全库
  const scope = parsed.data.scope ?? 'current';
  let documentId: string | null = null;
  let documentIds: string[] = [];
  if (scope === 'current') {
    if (parsed.data.documentId === undefined) {
      return NextResponse.json({ error: 'scope=current 时必须提供 documentId' }, { status: 400 });
    }
    documentId = parsed.data.documentId;
  } else if (scope === 'selected') {
    if (parsed.data.documentIds === undefined || parsed.data.documentIds.length === 0) {
      return NextResponse.json({ error: 'scope=selected 时必须提供 documentIds' }, { status: 400 });
    }
    documentIds = [...new Set(parsed.data.documentIds)];
  }

  // 与 embed 的 token 化字符集保持一致：纯标点/空白提取不到 token 的问题直接拒绝
  if (!/[\u3400-\u9fffa-zA-Z0-9]/.test(parsed.data.question)) {
    return NextResponse.json({ error: '请输入有效的问题' }, { status: 400 });
  }

  const result = await retrieve({
    question: parsed.data.question,
    documentId,
    documentIds,
    topK: parsed.data.topK,
  });

  return NextResponse.json(result);
}
