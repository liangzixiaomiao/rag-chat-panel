// embedding + 入库验收：node scripts/embed.check.mjs out/chunks.json
import { readFile } from 'node:fs/promises';
import { db } from './db.mjs';
import { ingestChunks } from '../lib/ingest.ts';
import { embedTexts } from '../lib/embed.ts';

const file = process.argv[2] ?? 'out/chunks.json';

function usageSnapshot() {
  return db
    .prepare(
      'select count(*) as rows, coalesce(sum(calls), 0) as calls, coalesce(sum(tokens), 0) as tokens from usage'
    )
    .get();
}

function loadGroups(raw) {
  if (Array.isArray(raw) && raw.length > 0 && raw[0] && Array.isArray(raw[0].parents)) {
    return raw.map((item, index) => ({ name: item.case ?? `case-${index + 1}`, parents: item.parents }));
  }
  return [{ name: 'all', parents: Array.isArray(raw) ? raw : [] }];
}

async function runPass(groups, label) {
  let inserted = 0;
  let skipped = 0;
  for (const [index, group] of groups.entries()) {
    const docId = `embed-check-${index + 1}`;
    db.prepare(
      'insert or ignore into documents (id, title, storage_path, file_type) values (?, ?, ?, ?)'
    ).run(docId, group.name, file, 'json');
    const result = await ingestChunks(docId, group.parents);
    inserted += result.inserted;
    skipped += result.skipped;
  }
  console.log(`${label} → 入库 ${inserted} / 跳过 ${skipped}`);
  return { inserted, skipped };
}

async function main() {
  const groups = loadGroups(JSON.parse(await readFile(file, 'utf8')));
  console.log(`input      = ${file}`);
  console.log(`groups     = ${groups.length}`);

  const before = usageSnapshot();
  const startedAt = Date.now();

  const first = await runPass(groups, '第一次');
  const elapsed = Date.now() - startedAt;
  const after = usageSnapshot();
  const stored = db.prepare("select count(*) as n from chunks where document_id like 'embed-check-%'").get().n;

  console.log(`chunks     = ${stored}`);
  console.log(`elapsed    = ${elapsed} ms`);
  console.log(
    `tokens     = ${after.tokens - before.tokens}（usage rows ${before.rows}→${after.rows}，calls ${before.calls}→${after.calls}）`
  );

  const second = await runPass(groups, '第二次（幂等）');
  const storedAgain = db.prepare("select count(*) as n from chunks where document_id like 'embed-check-%'").get().n;
  console.log(`chunks     = ${storedAgain}（${second.inserted === 0 && storedAgain === stored ? '条数不变' : '条数异常'}）`);

  const samples = db
    .prepare("select id, content from chunks where document_id like 'embed-check-%' order by random() limit 3")
    .all();
  const queryVectors = await embedTexts(samples.map((sample) => sample.content));

  samples.forEach((sample, index) => {
    const hits = db
      .prepare('select chunk_id, distance from vec_chunks where embedding match ? and k = 5')
      .all(new Float32Array(queryVectors[index]));
    const hit = hits.find((row) => row.chunk_id === sample.id) ?? hits[0];
    if (!hit) {
      console.log(`sample ${index + 1} = 没有召回任何向量`);
      return;
    }
    const similarity = 1 - hit.distance;
    console.log(
      `sample ${index + 1} = chunk ${hit.chunk_id}（原 ${sample.id}）similarity ${similarity.toFixed(6)}｜${sample.content.slice(0, 20)}`
    );
  });

  console.log(`quota      = DAILY_TOKEN_CAP=${process.env.DAILY_TOKEN_CAP ?? '默认 100000'}`);
  console.log(`first      = ${first.inserted} inserted`);
}

main().catch((err) => {
  console.log(`${err.name}: ${err.message}`);
  process.exit(1);
});
