// 检索验收：node scripts/retrieve.check.mjs
import { db } from './db.mjs';
import { chunkText } from '../lib/chunk.ts';
import { ingestChunks } from '../lib/ingest.ts';
import { retrieve } from '../lib/retrieve.ts';

const DOC_ID = 'retrieve-check';

const paragraphs = [
  { text: '缓存击穿的处理方式是加互斥锁，热点 key 过期时只放一个请求回源。', page: 1, headingPath: '第一章 缓存' },
  { text: 'HNSW 是近似最近邻索引。', page: 2, headingPath: '第二章 索引' },
  { text: '子块之间不做重叠。', page: 3, headingPath: '第三章 切块' },
  { text: 'embedding 额度超额会抛出 QuotaError。', page: 4, headingPath: '第四章 额度' },
  { text: '入库幂等是按 document_id 判断，跳过已存在的子块。', page: 5, headingPath: '第五章 入库' },
];

const questions = [
  { question: '缓存击穿的处理方式是什么', expect: '击穿' },
  { question: 'HNSW 索引是什么', expect: 'HNSW' },
  { question: '子块之间可以做重叠吗', expect: '重叠' },
  { question: 'embedding 额度超了会怎样', expect: 'QuotaError' },
  { question: '入库幂等是怎么做的', expect: '幂等' },
];

async function main() {
  const parents = chunkText(paragraphs);
  // 固定语料每次重建，避免上一版数据残留影响相似度
  db.prepare('delete from documents where id = ?').run(DOC_ID);
  db.prepare('insert or ignore into documents (id, title, storage_path, file_type) values (?, ?, ?, ?)').run(
    DOC_ID,
    '检索验收语料',
    'scripts/retrieve.check.mjs',
    'md'
  );

  const ingest = await ingestChunks(DOC_ID, parents);
  const total = db.prepare('select count(*) as n from chunks where document_id = ?').get(DOC_ID).n;
  console.log(`corpus = ${parents.length} 父块 / ${total} 子块（本次入库 ${ingest.inserted}，跳过 ${ingest.skipped}）`);

  let matchedInTop5 = 0;

  for (const item of questions) {
    const result = await retrieve({ question: item.question, documentId: DOC_ID });
    const top = result.hits.slice(0, 5);
    const inTop5 = top.some((hit) => hit.content.includes(item.expect));
    if (inTop5) matchedInTop5 += 1;

    console.log(
      `\nQ「${item.question}」 hits=${result.hits.length} parents=${result.parents.length} ` +
        `embed=${result.timings.embedMs}ms search=${result.timings.searchMs}ms｜期望关键词「${item.expect}」top5 命中：${inTop5 ? '是' : '否'}`
    );

    top.forEach((hit, index) => {
      console.log(`  #${index + 1} p${hit.pageFrom} sim=${hit.similarity.toFixed(4)}｜${hit.content.slice(0, 60)}`);
    });
  }

  console.log(`\n命中率（top5 含期望关键词）：${matchedInTop5}/${questions.length}`);
}

main().catch((err) => {
  console.log(`${err.name}: ${err.message}`);
  process.exit(1);
});
