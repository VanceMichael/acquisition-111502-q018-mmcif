// 结构观察解释器：把已解析的 mmCIF block 转成领域记录与解释问题。
//
// 设计约束（对应 docs/source-contract.md）：
// - 替代构象（label_alt_id 原 token）是独立观察，绝不按重复行合并或删除；
// - label 与 auth 两套标识并列保存；跨类别关联只按 label 标识，auth 不作全局主键；
// - 点号 "."（不适用）与问号 "?"（未知）保留原 token，不统一成空字符串；
// - 不做分子渲染、构象合并或化学键推断；未支持的标准扩展显式登记为 issue；
// - 关联类别缺交时，指出尚不能解释的标识，而不是猜测补全。

const ATOM_SITE = '_atom_site.';
const STRUCT_ASYM = '_struct_asym.';
const ENTITY = '_entity.';

const ATOM_FIELD_PATHS = {
  id: 'id',
  label_entity_id: 'labelEntityId',
  label_asym_id: 'labelAsym',
  auth_asym_id: 'authAsym',
  label_comp_id: 'labelCompId',
  auth_comp_id: 'authCompId',
  label_seq_id: 'labelSeqId',
  auth_seq_id: 'authSeqId',
  label_atom_id: 'labelAtomId',
  auth_atom_id: 'authAtomId',
  label_alt_id: 'alt',
  pdbx_PDB_ins_code: 'insertionCode',
  pdbx_PDB_model_num: 'model',
  Cartn_x: 'cartnX',
  Cartn_y: 'cartnY',
  Cartn_z: 'cartnZ',
  occupancy: 'occupancy',
  B_iso_or_equiv: 'bIsoOrEquiv',
  type_symbol: 'typeSymbol',
  group_PDB: 'groupPdb',
};

const ASYM_FIELD_PATHS = {
  id: 'labelAsym',
  entity_id: 'labelEntityId',
  pdbx_blank_PDB_chainid: 'authBlankChainId',
};

const ENTITY_FIELD_PATHS = {
  id: 'labelEntityId',
  type: 'type',
  pdbx_description: 'description',
};

function rowMap(row) {
  const map = new Map();
  for (const cell of row.cells) map.set(cell.column, cell);
  return map;
}

function numberOrRaw(cell) {
  if (!cell) return undefined;
  // 缺失标记（. / ?）不参与数字解析，原样返回。
  if (cell.token === '.' || cell.token === '?') return cell.token;
  const parsed = Number(cell.token);
  return Number.isFinite(parsed) ? parsed : cell.token;
}

function stableKey(parts) {
  return parts.map(part => String(part).replace(/%/g, '%25').replace(/\//g, '%2F')).join('/');
}

function findLoops(block, prefix) {
  return block.loops.filter(loop => loop.columns.some(column => column.token.startsWith(prefix)));
}

function unknownColumns(loop, knownSuffixes) {
  return loop.columns
    .map(column => column.token)
    .filter(name => {
      const dot = name.indexOf('.');
      const suffix = dot === -1 ? name : name.slice(dot + 1);
      return !knownSuffixes.has(suffix);
    });
}

export function interpret({ blocks, issues: parseIssues }, receiptId, sourceName) {
  const records = [];
  const issues = parseIssues.map(issue => ({ ...issue, receiptId }));
  const knownAtomSuffixes = new Set(Object.keys(ATOM_FIELD_PATHS));
  const knownAsymSuffixes = new Set(Object.keys(ASYM_FIELD_PATHS));
  const knownEntitySuffixes = new Set(Object.keys(ENTITY_FIELD_PATHS));

  function provenance(loc) {
    return [{ receiptId, location: loc, source: sourceName }];
  }

  for (const block of blocks) {
    const blockName = block.name.token;

    // _entity 类别：实体观察（仅在来源实际交付该类别时产生）。
    const entityLoops = findLoops(block, ENTITY);
    const knownEntities = new Set();
    for (const loop of entityLoops) {
      for (const columnName of unknownColumns(loop, knownEntitySuffixes)) {
        issues.push({ reason: 'unsupported_category_field', receiptId, location: loop.loc, detail: `_entity 的扩展字段 ${columnName} 已保留原文，暂不解释` });
      }
      for (const row of loop.rows) {
        if (row.truncated) continue;
        const map = rowMap(row);
        const idCell = map.get('_entity.id');
        if (!idCell) {
          issues.push({ reason: 'missing_required_identifier', receiptId, location: row.loc, detail: '_entity 行缺少 _entity.id，实体身份不能解释' });
          continue;
        }
        if (idCell.token === '.' || idCell.token === '?') {
          issues.push({ reason: 'unresolved_identifier', receiptId, location: idCell.loc, detail: `_entity.id 为缺失标记 "${idCell.token}"，该实体身份尚不能解释` });
          continue;
        }
        knownEntities.add(idCell.token);
        const value = { block: blockName };
        for (const [suffix, path] of Object.entries(ENTITY_FIELD_PATHS)) {
          const cell = map.get('_' + 'entity.' + suffix);
          if (cell) value[path] = cell.token;
        }
        records.push({
          kind: 'entity-observation',
          key: stableKey(['entity', blockName, idCell.token]),
          value,
          provenance: provenance(idCell.loc),
        });
      }
    }

    // _struct_asym 类别：链（结构单体）观察，关联按 label 标识建立。
    const asymLoops = findLoops(block, STRUCT_ASYM);
    const knownChains = new Map(); // label asym id -> entity id（可能为缺失标记）
    for (const loop of asymLoops) {
      for (const columnName of unknownColumns(loop, knownAsymSuffixes)) {
        issues.push({ reason: 'unsupported_category_field', receiptId, location: loop.loc, detail: `_struct_asym 的扩展字段 ${columnName} 已保留原文，暂不解释` });
      }
      for (const row of loop.rows) {
        if (row.truncated) continue;
        const map = rowMap(row);
        const idCell = map.get('_struct_asym.id');
        if (!idCell) {
          issues.push({ reason: 'missing_required_identifier', receiptId, location: row.loc, detail: '_struct_asym 行缺少 _struct_asym.id，链身份不能解释' });
          continue;
        }
        if (idCell.token === '.' || idCell.token === '?') {
          issues.push({ reason: 'unresolved_identifier', receiptId, location: idCell.loc, detail: `_struct_asym.id 为缺失标记 "${idCell.token}"，该链身份尚不能解释` });
          continue;
        }
        const entityCell = map.get('_struct_asym.entity_id');
        knownChains.set(idCell.token, entityCell ? entityCell.token : null);
        const value = { block: blockName, labelAsym: idCell.token };
        for (const [suffix, path] of Object.entries(ASYM_FIELD_PATHS)) {
          if (suffix === 'id') continue;
          const cell = map.get('_' + 'struct_asym.' + suffix);
          if (cell) value[path] = cell.token;
        }
        records.push({
          kind: 'chain-observation',
          key: stableKey(['chain', blockName, idCell.token]),
          value,
          provenance: provenance(idCell.loc),
        });
        if (!entityCell) {
          issues.push({ reason: 'missing_related_category', receiptId, location: idCell.loc, detail: `链 ${idCell.token} 缺少 _struct_asym.entity_id，其实体归属尚不能解释` });
        } else if (entityCell.token === '.' || entityCell.token === '?') {
          issues.push({ reason: 'unresolved_identifier', receiptId, location: entityCell.loc, detail: `链 ${idCell.token} 的实体标识为缺失标记 "${entityCell.token}"，实体归属尚不能解释` });
        } else if (entityLoops.length === 0) {
          // 关联类别整体缺交：指出尚不能解释的标识，不伪造实体记录。
          issues.push({ reason: 'missing_related_category', receiptId, location: entityCell.loc, detail: `链 ${idCell.token} 引用实体 ${entityCell.token}，但来源未交付 _entity 类别，实体身份尚不能解释` });
        } else if (!knownEntities.has(entityCell.token)) {
          issues.push({ reason: 'unresolved_identifier', receiptId, location: entityCell.loc, detail: `链 ${idCell.token} 引用实体 ${entityCell.token}，但 _entity 中没有该标识` });
        }
      }
    }

    // _atom_site 类别：残基观察与原子观察（替代构象各自独立）。
    const atomLoops = findLoops(block, ATOM_SITE);
    const seenResidues = new Set();
    for (const loop of atomLoops) {
      for (const columnName of unknownColumns(loop, knownAtomSuffixes)) {
        issues.push({ reason: 'unsupported_category_field', receiptId, location: loop.loc, detail: `_atom_site 的扩展字段 ${columnName} 已随原子观察保留原字段，暂不单独解释` });
      }
      for (const row of loop.rows) {
        if (row.truncated) continue; // 截断行已由 parser 登记 issue，不产生半条解释
        const map = rowMap(row);
        const rowProvenance = provenance(row.loc);

        const labelAsymCell = map.get('_atom_site.label_asym_id');
        const labelAsym = labelAsymCell ? labelAsymCell.token : null;
        if (!labelAsymCell) {
          issues.push({ reason: 'missing_required_identifier', receiptId, location: row.loc, detail: '_atom_site 行缺少 label_asym_id，链归属不能解释' });
        } else if (labelAsym !== '.' && labelAsym !== '?' && asymLoops.length > 0 && !knownChains.has(labelAsym)) {
          issues.push({ reason: 'unresolved_identifier', receiptId, location: labelAsymCell.loc, detail: `原子行引用 label 链 ${labelAsym}，但 _struct_asym 中没有该标识` });
        }

        const altCell = map.get('_atom_site.label_alt_id');
        const alt = altCell ? altCell.token : '.';
        const modelCell = map.get('_atom_site.pdbx_PDB_model_num');
        const model = modelCell ? numberOrRaw(modelCell) : null;
        const insCell = map.get('_atom_site.pdbx_PDB_ins_code');

        // 残基观察：同一 label 链 + 残基标识 + 构象 + 模型只登记一次，
        // 但替代构象不同（alt 原 token 不同）即为不同残基观察，不做构象合并。
        const labelSeqCell = map.get('_atom_site.label_seq_id');
        const authSeqCell = map.get('_atom_site.auth_seq_id');
        const compCell = map.get('_atom_site.label_comp_id');
        const residueIdentity = [
          'residue', blockName, labelAsym ?? '∄label_asym',
          labelSeqCell ? labelSeqCell.token : '∄label_seq',
          authSeqCell ? authSeqCell.token : '∄auth_seq',
          compCell ? compCell.token : '∄comp',
          alt, String(model ?? '∄model'),
        ];
        const residueKey = stableKey(residueIdentity);
        if (!seenResidues.has(residueKey)) {
          seenResidues.add(residueKey);
          const residueValue = { block: blockName };
          if (labelAsymCell) residueValue.labelAsym = labelAsym;
          const authAsymCell = map.get('_atom_site.auth_asym_id');
          if (authAsymCell) residueValue.authAsym = authAsymCell.token;
          if (compCell) residueValue.labelCompId = compCell.token;
          const authCompCell = map.get('_atom_site.auth_comp_id');
          if (authCompCell) residueValue.authCompId = authCompCell.token;
          if (labelSeqCell) residueValue.labelSeqId = numberOrRaw(labelSeqCell);
          if (authSeqCell) residueValue.authSeqId = numberOrRaw(authSeqCell);
          residueValue.alt = alt;
          if (insCell) residueValue.insertionCode = insCell.token;
          if (modelCell) residueValue.model = model;
          records.push({ kind: 'residue-observation', key: residueKey, value: residueValue, provenance: rowProvenance });
        }

        // 原子观察：契约字段全部保留原 token，数字字段附解析值，其余原类别字段（含未支持扩展）整体保留。
        const value = { block: blockName };
        const fields = {};
        for (const cell of row.cells) {
          const suffix = cell.column.slice(ATOM_SITE.length);
          const mappedPath = ATOM_FIELD_PATHS[suffix];
          fields[suffix] = { token: cell.token, loc: cell.loc };
          if (!mappedPath) continue; // 未识别扩展只原值留存，不提升为解释字段
          if (suffix === 'pdbx_PDB_model_num' || suffix === 'Cartn_x' || suffix === 'Cartn_y' || suffix === 'Cartn_z' || suffix === 'occupancy' || suffix === 'B_iso_or_equiv' || suffix === 'auth_seq_id' || suffix === 'label_seq_id') {
            value[mappedPath] = numberOrRaw(cell);
          } else {
            value[mappedPath] = cell.token;
          }
        }
        if (!('alt' in value)) value.alt = '.';
        value.fields = fields;

        const idCell = map.get('_atom_site.id');
        const atomNameCell = map.get('_atom_site.label_atom_id');
        const identityParts = [
          'atom', blockName, String(model ?? '∄model'),
          labelAsym ?? '∄label_asym',
          labelSeqCell ? labelSeqCell.token : '∄label_seq',
          authSeqCell ? authSeqCell.token : '∄auth_seq',
          atomNameCell ? atomNameCell.token : '∄atom',
          alt,
        ];
        const key = idCell && idCell.token !== '.' && idCell.token !== '?'
          ? stableKey(['atom', blockName, idCell.token, alt, String(model ?? '∄model')])
          : stableKey(identityParts);
        records.push({ kind: 'atom-observation', key, value, provenance: rowProvenance });
      }
    }

    // 已出现但本版本不解释的标准类别：显式标识未支持，不假称已解释。
    const supportedPrefixes = new Set(['_atom_site.', '_struct_asym.', '_entity.']);
    for (const loop of block.loops) {
      const prefixes = new Set(loop.columns.map(column => column.token.slice(0, column.token.indexOf('.') + 1)));
      for (const prefix of prefixes) {
        if (!supportedPrefixes.has(prefix)) {
          issues.push({ reason: 'unsupported_category', receiptId, location: loop.loc, detail: `类别 ${prefix.slice(0, -1)} 的 loop 已随原文收件保留，本版本不做结构化解释` });
        }
      }
    }
    if (block.loops.length === 0 && block.items.size === 0) {
      issues.push({ reason: 'empty_data_block', receiptId, location: block.name.loc, detail: `data block ${blockName || '(未命名)'} 不含任何字段` });
    }
  }

  return { records, issues };
}
