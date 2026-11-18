import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function identifier(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.-]{1,100}$/.test(value)) {
    throw Object.assign(new Error('invalid_identifier'), { status: 400 });
  }
  return value;
}

export class Archive {
  constructor(directory) {
    this.directory = directory;
    this.pending = Promise.resolve();
  }

  async initialize() {
    for (const name of ['blobs', 'receipts', 'collections']) {
      await mkdir(join(this.directory, name), { recursive: true });
    }
  }

  async serialized(operation) {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => {});
    return result;
  }

  async saveJson(path, value) {
    const temporary = path + '.pending';
    await writeFile(temporary, JSON.stringify(value, null, 2));
    await rename(temporary, path);
  }

  async collection(collectionId) {
    identifier(collectionId);
    try {
      return JSON.parse(await readFile(join(this.directory, 'collections', collectionId + '.json'), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { collectionId, receiptIds: [], records: [], issues: [] };
    }
  }

  async receive({ collectionId, sourceKey, revision, mediaType, bytes, summary }) {
    identifier(collectionId);
    if (typeof sourceKey !== 'string' || !sourceKey || typeof revision !== 'string' || !revision) {
      throw Object.assign(new Error('missing_source_identity'), { status: 400 });
    }
    const sha256 = digest(bytes);
    const receiptId = digest(Buffer.from(JSON.stringify([collectionId, sourceKey, revision])));
    return this.serialized(async () => {
      const path = join(this.directory, 'receipts', receiptId + '.json');
      try {
        const existing = JSON.parse(await readFile(path, 'utf8'));
        if (existing.sha256 !== sha256) throw Object.assign(new Error('revision_content_conflict'), { status: 409 });
        const collection = await this.collection(collectionId);
        if (!collection.receiptIds.includes(receiptId)) {
          collection.receiptIds.push(receiptId);
          await this.saveJson(join(this.directory, 'collections', collectionId + '.json'), collection);
        }
        return existing;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await writeFile(join(this.directory, 'blobs', sha256), bytes, { flag: 'wx' }).catch(error => {
        if (error.code !== 'EEXIST') throw error;
      });
      const receipt = { receiptId, collectionId, sourceKey, revision, mediaType, sha256, byteLength: bytes.length, summary };
      await this.saveJson(path, receipt);
      const collection = await this.collection(collectionId);
      collection.receiptIds.push(receiptId);
      await this.saveJson(join(this.directory, 'collections', collectionId + '.json'), collection);
      return receipt;
    });
  }

  async receipt(receiptId) {
    if (!/^[a-f0-9]{64}$/.test(receiptId)) throw Object.assign(new Error('invalid_receipt'), { status: 400 });
    try {
      return JSON.parse(await readFile(join(this.directory, 'receipts', receiptId + '.json'), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') throw Object.assign(new Error('receipt_not_found'), { status: 404 });
      throw error;
    }
  }

  async body(receiptId) {
    const receipt = await this.receipt(receiptId);
    return readFile(join(this.directory, 'blobs', receipt.sha256));
  }

  async addRecord(collectionId, record) {
    identifier(collectionId);
    if (!record || typeof record.kind !== 'string' || typeof record.key !== 'string' || !record.value || typeof record.value !== 'object') {
      throw Object.assign(new Error('invalid_record'), { status: 400 });
    }
    if (!Array.isArray(record.provenance) || record.provenance.length === 0) {
      throw Object.assign(new Error('missing_provenance'), { status: 400 });
    }
    for (const origin of record.provenance) {
      const receipt = await this.receipt(origin.receiptId);
      if (receipt.collectionId !== collectionId || typeof origin.location !== 'string' || !origin.location) {
        throw Object.assign(new Error('provenance_scope'), { status: 400 });
      }
    }
    return this.serialized(async () => {
      const collection = await this.collection(collectionId);
      const match = collection.records.find(existing => existing.kind === record.kind && existing.key === record.key);
      if (match && JSON.stringify(match) !== JSON.stringify(record)) {
        throw Object.assign(new Error('record_identity_conflict'), { status: 409 });
      }
      if (!match) collection.records.push(record);
      await this.saveJson(join(this.directory, 'collections', collectionId + '.json'), collection);
      return record;
    });
  }

  // 自动解释结果的整体提交：records 与 issues 都按内容幂等，
  // 重复领取同一修订不会产生重复行，也不会覆盖已归档原文。
  async commitInterpretation(collectionId, { records, issues }) {
    identifier(collectionId);
    for (const record of records || []) {
      if (!record || typeof record.kind !== 'string' || typeof record.key !== 'string' || !record.value || typeof record.value !== 'object') {
        throw Object.assign(new Error('invalid_record'), { status: 400 });
      }
      if (!Array.isArray(record.provenance) || record.provenance.length === 0) {
        throw Object.assign(new Error('missing_provenance'), { status: 400 });
      }
      for (const origin of record.provenance) {
        const receipt = await this.receipt(origin.receiptId);
        if (receipt.collectionId !== collectionId || typeof origin.location !== 'string' || !origin.location) {
          throw Object.assign(new Error('provenance_scope'), { status: 400 });
        }
      }
    }
    for (const issue of issues || []) {
      if (!issue || typeof issue.reason !== 'string' || typeof issue.location !== 'string') {
        throw Object.assign(new Error('invalid_issue'), { status: 400 });
      }
    }
    return this.serialized(async () => {
      const collection = await this.collection(collectionId);
      let addedRecords = 0;
      for (const record of records) {
        const match = collection.records.find(existing => existing.kind === record.kind && existing.key === record.key);
        if (match) {
          if (JSON.stringify(match) !== JSON.stringify(record)) {
            throw Object.assign(new Error('record_identity_conflict'), { status: 409 });
          }
        } else {
          collection.records.push(record);
          addedRecords += 1;
        }
      }
      let addedIssues = 0;
      for (const issue of issues) {
        const duplicate = collection.issues.some(existing => JSON.stringify(existing) === JSON.stringify(issue));
        if (!duplicate) { collection.issues.push(issue); addedIssues += 1; }
      }
      await this.saveJson(join(this.directory, 'collections', collectionId + '.json'), collection);
      return { collectionId, records: collection.records, issues: collection.issues, addedRecords, addedIssues };
    });
  }

  async list() {
    return (await readdir(join(this.directory, 'collections'))).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5));
  }
}
