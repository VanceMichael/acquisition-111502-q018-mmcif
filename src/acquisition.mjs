// 自动接入编排：领取来源入口 -> 按 delivery 索引领取 roots -> 全部原文登记收件
// -> 对 mmCIF 原文做结构化解释 -> 记录与问题整体提交。
// 任何自动取得的依赖都保留真实原文收件；解释失败转为结构化 issue，不抛成内部崩溃，
// 也不用人工造 records 代替自动接入。

import { retrieve } from './transport.mjs';
import { parse } from './mmcif/parser.mjs';
import { interpret } from './mmcif/interpreter.mjs';

function looksLikeMmCif(sourceKey, mediaType, bytes) {
  const lowerType = (mediaType || '').split(';')[0].trim().toLowerCase();
  if (lowerType.endsWith('mmcif') || lowerType.endsWith('cif')) return true;
  if (sourceKey.toLowerCase().includes('.cif')) return true;
  // 内容嗅探仅作兜底：词法上以 data_ 行起始。
  return /^\s*data_\S+/m.test(bytes.toString('utf8').slice(0, 4096));
}

function absolute(entry, base) {
  return new URL(entry, base).toString();
}

// 与 transport 保持同一来源冻结策略：入口及解析出的 root 必须落在启动时冻结的 origin，
// 任何越界地址在发出请求前直接拒绝，不登记成静默 issue。
function assertAllowed(target, allowedOrigin) {
  const url = new URL(target);
  if (url.origin !== allowedOrigin || url.username || url.password) {
    throw Object.assign(new Error('source_not_allowed'), { status: 403 });
  }
}

export async function acquire({ archive, collectionId, entry, options = {}, allowedOrigin }) {
  assertAllowed(entry, allowedOrigin);
  const issues = [];
  const receipts = [];

  async function fetchAndStore(target) {
    let result;
    try {
      result = await retrieve(target, allowedOrigin);
    } catch (error) {
      issues.push({ reason: 'source_retrieval_failed', location: target, detail: error.message });
      return null;
    }
    const receipt = await archive.receive({
      collectionId, sourceKey: target, revision: result.revision,
      mediaType: result.mediaType, bytes: result.bytes,
      summary: { format: looksLikeMmCif(target, result.mediaType, result.bytes) ? 'mmcif' : 'unknown', byteLength: result.bytes.length },
    });
    receipts.push(receipt);
    return { receipt, bytes: result.bytes, mediaType: result.mediaType };
  }

  const entryResult = await fetchAndStore(entry);
  if (!entryResult) {
    if (issues.length) await archive.commitInterpretation(collectionId, { records: [], issues });
    return { collectionId, receiptIds: receipts.map(receipt => receipt.receiptId), records: [], issues };
  }

  const rootTargets = [];
  let delivery = null;
  const mediaType = (entryResult.mediaType || '').split(';')[0].trim().toLowerCase();
  if (mediaType.includes('json')) {
    try {
      delivery = JSON.parse(entryResult.bytes.toString('utf8'));
    } catch (error) {
      issues.push({ reason: 'delivery_index_unparseable', receiptId: entryResult.receipt.receiptId, location: 'line:1', detail: error.message });
    }
  }

  if (delivery && Array.isArray(delivery.roots)) {
    for (const root of delivery.roots) {
      if (!root || typeof root.href !== 'string') {
        issues.push({ reason: 'invalid_delivery_root', receiptId: entryResult.receipt.receiptId, location: 'line:1', detail: 'delivery 索引中的 root 缺少 href' });
        continue;
      }
      rootTargets.push(absolute(root.href, entry));
    }
  } else if (delivery) {
    issues.push({ reason: 'invalid_delivery_index', receiptId: entryResult.receipt.receiptId, location: 'line:1', detail: 'delivery 索引缺少 roots 数组，无法定位结构入口' });
  } else if (!mediaType.includes('json')) {
    // 入口本身即结构文件（兼容直接指向 .cif 的来源）。
    rootTargets.push(entry);
  }

  const allRecords = [];
  for (const target of rootTargets) {
    try {
      assertAllowed(target, allowedOrigin);
    } catch (error) {
      issues.push({ reason: 'source_not_allowed', location: target, detail: 'delivery 索引指向授权来源之外的地址，未发起请求' });
      continue;
    }
    const targetResult = target === entry ? entryResult : await fetchAndStore(target);
    if (!targetResult) continue;
    if (!looksLikeMmCif(target, targetResult.mediaType, targetResult.bytes)) {
      issues.push({ reason: 'unsupported_media_type', receiptId: targetResult.receipt.receiptId, location: 'line:1', detail: `资源 ${target} 的媒体类型 ${targetResult.mediaType} 暂无结构化解释，原文已收件` });
      continue;
    }
    let parsed;
    try {
      parsed = parse(targetResult.bytes.toString('utf8'));
    } catch (error) {
      issues.push({ reason: 'mmcif_parse_failed', receiptId: targetResult.receipt.receiptId, location: 'line:1', detail: error.message });
      continue;
    }
    const { records, issues: interpretationIssues } = interpret(parsed, targetResult.receipt.receiptId, target);
    allRecords.push(...records);
    issues.push(...interpretationIssues);
  }

  const commit = await archive.commitInterpretation(collectionId, { records: allRecords, issues });
  return {
    collectionId,
    receiptIds: [...new Set(receipts.map(receipt => receipt.receiptId))],
    records: commit.records,
    issues: commit.issues,
  };
}
