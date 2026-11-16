import { Buffer } from 'node:buffer';
import { retrieve } from './transport.mjs';
import { summarize } from './summary.mjs';
import { parseMmCif } from './mmcif-parser.mjs';
import { interpret, looksLikeMmCif } from './mmcif-interpreter.mjs';

// 自动接入编排：
// - 入口与每个自动取得的依赖都保留真实原文收件，不用人工造 records 代替；
// - 只领取交付索引声明的 roots/resources，不把链接当公网搜索指令；
// - mmCIF 解释结果的每条 provenance 绑定该文件的真实 receiptId，出处回到原 data block 和行列；
// - 解释层报出的限制/缺件进入 collection.issues，绝不静默丢弃。

function asUrl(href, base) {
  return new URL(href, base);
}

export function interpretMmCifBytes(bytes, mediaType) {
  if (!looksLikeMmCif(bytes, mediaType)) {
    return {
      records: [],
      issues: [{ reason: 'unsupported_media', location: 'byte=0', detail: '该入口不是可识别的 PDBx/mmCIF 资料，原文已随收件保留' }],
      meta: { blocks: [], byteLength: bytes.length }
    };
  }
  const text = bytes.toString('utf8');
  const parsed = parseMmCif(text);
  return interpret(parsed, { byteLength: bytes.length });
}

export async function ingest({ entry, allowedOrigin }) {
  const fetched = []; // { href, receipt 输入材料、解释结果 }
  const seenHrefs = new Set();

  async function fetchOne(href) {
    const url = asUrl(href, entry);
    if (url.origin !== allowedOrigin) {
      throw Object.assign(new Error('source_not_allowed'), { status: 403 });
    }
    const key = url.href;
    if (seenHrefs.has(key)) return null;
    seenHrefs.add(key);
    const result = await retrieve(key, allowedOrigin);
    const item = { href: key, ...result };
    fetched.push(item);
    return item;
  }

  const root = await fetchOne(entry);
  if (!root) throw Object.assign(new Error('entry_unavailable'), { status: 502 });
  const mediaType = root.mediaType || '';
  const plan = { records: [], issues: [], items: fetched };

  let delivery = null;
  if (mediaType.toLowerCase().includes('application/json')) {
    try {
      delivery = JSON.parse(root.bytes.toString('utf8'));
    } catch {
      delivery = null;
    }
  }

  const explain = (item) => {
    const outcome = interpretMmCifBytes(item.bytes, item.mediaType || '');
    for (const record of outcome.records) {
      plan.records.push({
        ...record,
        provenance: record.provenance.map(origin => ({ ...origin, receiptRef: item }))
      });
    }
    for (const issue of outcome.issues) {
      plan.issues.push({ ...issue, receiptRef: item, href: item.href });
    }
  };

  if (delivery && Array.isArray(delivery.roots)) {
    // 交付索引：roots 是独立入口，resources 是同包可领取资源
    const roots = delivery.roots.map(rootEntry => asUrl(rootEntry.href, entry).href);
    const resources = Array.isArray(delivery.resources)
      ? delivery.resources.map(resource => asUrl(resource.href, entry).href)
      : [];
    for (const href of resources) await fetchOne(href);
    for (const href of roots) {
      // root 可能已作为同包 resource 领取过，不重复请求，但仍要解释
      const item = (await fetchOne(href)) ?? fetched.find(existing => existing.href === href);
      if (item) explain(item);
    }
  } else {
    explain(root);
  }

  return plan;
}

// 把解释产物落到收件台账：receipt 先存档，再把真实 receiptId 写进出处
export async function persistIngestion(archive, collectionId, plan, { entry }) {
  const receipts = [];
  const receiptIdByHref = new Map();
  for (const item of plan.items) {
    const receipt = await archive.receive({
      collectionId,
      sourceKey: item.href,
      revision: item.revision,
      mediaType: item.mediaType || 'application/octet-stream',
      bytes: Buffer.from(item.bytes),
      summary: summarize(Buffer.from(item.bytes), item.mediaType || 'application/octet-stream')
    });
    receipts.push(receipt);
    receiptIdByHref.set(item.href, receipt.receiptId);
  }

  const records = [];
  for (const record of plan.records) {
    const stored = {
      kind: record.kind,
      key: record.key,
      value: record.value,
      provenance: record.provenance.map(origin => ({
        receiptId: receiptIdByHref.get(origin.receiptRef.href),
        location: origin.location
      }))
    };
    await archive.addRecord(collectionId, stored);
    records.push(stored);
  }

  const issues = [];
  for (const issue of plan.issues) {
    const stored = {
      reason: issue.reason,
      location: issue.location,
      ...(issue.block ? { block: issue.block } : {}),
      ...(issue.ref ? { ref: issue.ref } : {}),
      ...(issue.detail ? { detail: issue.detail } : {}),
      receiptId: receiptIdByHref.get(issue.href || entry),
      ...(issue.href ? { source: issue.href } : {})
    };
    await archive.addIssue(collectionId, stored);
    issues.push(stored);
  }

  return { receiptIds: receipts.map(receipt => receipt.receiptId), records, issues };
}
