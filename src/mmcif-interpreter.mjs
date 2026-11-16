// mmCIF 结构化解释：把语法层的 data block/loop 转成收件台账记录。
// 关键不变量：
// - 结构类别按 label 标识关联（struct_asym.id / entity.id / atom_site.label_*），
//   auth_* 字段并列保存，绝不当作跨实体全局主键；
// - 每个 loop 数据行独立登记，替代构象（label_alt_id 的 A/B/…）绝不当重复行合并；
// - 原 token 原样保留：'.' 表示不适用、'?' 表示未知，不归一化为空字符串；
// - 关联类别没有交齐时，只指出尚不能解释的标识，不猜测实体归属；
// - 不做分子渲染、构象合并或化学键推断。

const ENTITY_COLUMNS = {
  id: '_entity.id',
  type: '_entity.type'
};

const ASYM_COLUMNS = {
  id: '_struct_asym.id',
  entityId: '_struct_asym.entity_id'
};

const ATOM_COLUMNS = {
  id: '_atom_site.id',
  groupPdb: '_atom_site.group_PDB',
  labelEntityId: '_atom_site.label_entity_id',
  labelAsym: '_atom_site.label_asym_id',
  labelSeqId: '_atom_site.label_seq_id',
  labelCompId: '_atom_site.label_comp_id',
  labelAtomId: '_atom_site.label_atom_id',
  labelAltId: '_atom_site.label_alt_id',
  authAsym: '_atom_site.auth_asym_id',
  authSeqId: '_atom_site.auth_seq_id',
  authCompId: '_atom_site.auth_comp_id',
  authAtomId: '_atom_site.auth_atom_id',
  insertionCode: '_atom_site.pdbx_PDB_ins_code',
  model: '_atom_site.pdbx_PDB_model_num',
  x: '_atom_site.Cartn_x',
  y: '_atom_site.Cartn_y',
  z: '_atom_site.Cartn_z'
};

const SUPPORTED_CATEGORIES = new Set(['_entity', '_struct_asym', '_atom_site']);
const PARSER_CATEGORY_REASONS = new Set([
  'truncated_loop_row', 'duplicate_loop_column', 'loop_without_columns',
  'loop_without_rows', 'unterminated_semicolon_text', 'unterminated_quoted_value',
  'missing_item_value', 'unexpected_token', 'unsupported_global_section',
  'unsupported_save_frame', 'content_before_data_block'
]);

export function formatLocation(start, end) {
  const base = `line=${start.line},col=${start.column},byte=${start.offset}`;
  if (end && end.offset !== start.offset) return `${base}-${end.offset}`;
  return base;
}

function cellsOf(row) {
  const byName = new Map();
  for (const cell of row.cells) byName.set(cell.name, cell.token);
  return byName;
}

function rawToken(token) {
  if (!token) return undefined;
  return token.value; // '.' 与 '?' 原样返回，不转换
}

function numericToken(token) {
  if (!token) return undefined;
  if (token.value === '.' || token.value === '?') return token.value;
  const number = Number(token.value);
  return Number.isFinite(number) ? number : token.value;
}

function pushIssue(issues, seen, issue) {
  const signature = JSON.stringify([issue.reason, issue.block || '', issue.ref || '', issue.location || '']);
  if (seen.has(signature)) return;
  seen.add(signature);
  issues.push(issue);
}

export function interpret(parsed, { byteLength = 0 } = {}) {
  const records = [];
  const issues = [];
  const seenIssues = new Set();

  for (const issue of parsed.issues) {
    if (!PARSER_CATEGORY_REASONS.has(issue.reason)) continue;
    pushIssue(issues, seenIssues, {
      reason: issue.reason,
      block: issue.block || '',
      location: issue.location ? formatLocation(issue.location, issue.end) : 'unknown',
      detail: issue.message
    });
  }

  for (const block of parsed.blocks) {
    const blockName = block.name;
    const loopsByCategory = new Map();
    for (const loop of block.loops) {
      if (!loopsByCategory.has(loop.category)) loopsByCategory.set(loop.category, []);
      loopsByCategory.get(loop.category).push(loop);
    }

    // 未支持的类别明确标识，不静默丢弃，也不假称已解释
    for (const loop of block.loops) {
      if (!SUPPORTED_CATEGORIES.has(loop.category)) {
        pushIssue(issues, seenIssues, {
          reason: 'unsupported_category',
          block: blockName,
          location: formatLocation(loop.headerStart, loop.headerEnd),
          detail: `类别 ${loop.category} 暂不在自动解释范围，原文已随收件保留`
        });
      }
    }
    for (const item of block.items) {
      const category = item.name.split('.')[0];
      if (!SUPPORTED_CATEGORIES.has(category)) {
        pushIssue(issues, seenIssues, {
          reason: 'unsupported_item',
          block: blockName,
          location: formatLocation(item.item.start, item.item.end),
          detail: `单值项目 ${item.name} 暂不在自动解释范围，原文已随收件保留`
        });
      }
    }

    // _entity：label 侧实体身份
    const entityIds = new Set();
    const entityLoops = loopsByCategory.get('_entity') || [];
    for (const loop of entityLoops) {
      for (const row of loop.rows) {
        const cells = cellsOf(row);
        const idToken = cells.get(ENTITY_COLUMNS.id);
        if (!idToken || idToken.value === '.' || idToken.value === '?') {
          pushIssue(issues, seenIssues, {
            reason: 'missing_entity_identifier',
            block: blockName,
            location: formatLocation(row.start, row.end),
            detail: '_entity 行缺少可用 id，不能登记实体记录'
          });
          continue;
        }
        entityIds.add(idToken.value);
        const value = {
          block: blockName,
          entityId: idToken.value,
          type: cells.get(ENTITY_COLUMNS.type)?.value
        };
        records.push({
          kind: 'entity',
          key: `${blockName}/entity/${idToken.value}`,
          value,
          provenance: [{ location: formatLocation(row.start, row.end) }]
        });
      }
    }

    // _struct_asym：label 链与实体的观察关系
    const asymIds = new Set();
    const asymLoops = loopsByCategory.get('_struct_asym') || [];
    for (const loop of asymLoops) {
      for (const row of loop.rows) {
        const cells = cellsOf(row);
        const asymToken = cells.get(ASYM_COLUMNS.id);
        const entityToken = cells.get(ASYM_COLUMNS.entityId);
        if (!asymToken || asymToken.value === '.' || asymToken.value === '?') {
          pushIssue(issues, seenIssues, {
            reason: 'missing_asym_identifier',
            block: blockName,
            location: formatLocation(row.start, row.end),
            detail: '_struct_asym 行缺少可用 id'
          });
          continue;
        }
        asymIds.add(asymToken.value);
        const entityRef = entityToken?.value;
        if (entityRef === undefined || entityRef === '.' || entityRef === '?') {
          pushIssue(issues, seenIssues, {
            reason: 'unresolved_entity_reference',
            block: blockName,
            ref: String(entityRef ?? ''),
            location: formatLocation(row.start, row.end),
            detail: `链 ${asymToken.value} 的 label entity 标识缺失，尚不能解释其实体归属`
          });
        } else if (!entityIds.has(entityRef)) {
          pushIssue(issues, seenIssues, {
            reason: 'unresolved_entity_reference',
            block: blockName,
            ref: entityRef,
            location: formatLocation(row.start, row.end),
            detail: `链 ${asymToken.value} 指向实体 ${entityRef}，但本 data block 未交齐 _entity 定义`
          });
        }
        const value = {
          block: blockName,
          labelAsym: asymToken.value,
          entityId: rawToken(entityToken)
        };
        records.push({
          kind: 'struct-asym',
          key: `${blockName}/asym/${asymToken.value}`,
          value,
          provenance: [{ location: formatLocation(row.start, row.end) }]
        });
      }
    }

    // _atom_site：逐行原子观察，替代构象不合并
    const atomLoops = loopsByCategory.get('_atom_site') || [];
    for (const loop of atomLoops) {
      for (const row of loop.rows) {
        const cells = cellsOf(row);
        const idToken = cells.get(ATOM_COLUMNS.id);
        if (!idToken) {
          pushIssue(issues, seenIssues, {
            reason: 'missing_atom_identifier',
            block: blockName,
            location: formatLocation(row.start, row.end),
            detail: '_atom_site 行缺少 id 列，不能登记原子观察'
          });
          continue;
        }
        const labelAsymToken = cells.get(ATOM_COLUMNS.labelAsym);
        const labelAsym = labelAsymToken?.value;
        if (labelAsym !== undefined && labelAsym !== '.' && labelAsym !== '?' && !asymIds.has(labelAsym)) {
          pushIssue(issues, seenIssues, {
            reason: 'unresolved_asym_reference',
            block: blockName,
            ref: labelAsym,
            location: formatLocation(row.start, row.end),
            detail: `原子 ${idToken.value} 的 label_asym_id=${labelAsym} 在 _struct_asym 中没有对应链`
          });
        }
        const labelEntityToken = cells.get(ATOM_COLUMNS.labelEntityId);
        if (labelEntityToken) {
          const ref = labelEntityToken.value;
          if (ref !== '.' && ref !== '?' && !entityIds.has(ref)) {
            pushIssue(issues, seenIssues, {
              reason: 'unresolved_entity_reference',
              block: blockName,
              ref,
              location: formatLocation(row.start, row.end),
              detail: `原子 ${idToken.value} 的 label_entity_id=${ref} 在 _entity 中没有定义`
            });
          }
        }

        const fields = {};
        for (const cell of row.cells) fields[cell.name] = cell.token.value;

        // label 与 auth 两套标识并列保存；原 token（'.' 不适用 / '?' 未知）不归一化
        const value = {
          block: blockName,
          id: idToken.value,
          labelEntityId: rawToken(cells.get(ATOM_COLUMNS.labelEntityId)),
          labelAsym: rawToken(cells.get(ATOM_COLUMNS.labelAsym)),
          labelSeqId: rawToken(cells.get(ATOM_COLUMNS.labelSeqId)),
          labelCompId: rawToken(cells.get(ATOM_COLUMNS.labelCompId)),
          labelAtomId: rawToken(cells.get(ATOM_COLUMNS.labelAtomId)),
          authAsym: rawToken(cells.get(ATOM_COLUMNS.authAsym)),
          authSeqId: rawToken(cells.get(ATOM_COLUMNS.authSeqId)),
          authCompId: rawToken(cells.get(ATOM_COLUMNS.authCompId)),
          authAtomId: rawToken(cells.get(ATOM_COLUMNS.authAtomId)),
          model: numericToken(cells.get(ATOM_COLUMNS.model)),
          alt: rawToken(cells.get(ATOM_COLUMNS.labelAltId)),
          insertionCode: rawToken(cells.get(ATOM_COLUMNS.insertionCode)),
          coordinates: {},
          fields
        };
        const coordinate = {
          x: numericToken(cells.get(ATOM_COLUMNS.x)),
          y: numericToken(cells.get(ATOM_COLUMNS.y)),
          z: numericToken(cells.get(ATOM_COLUMNS.z))
        };
        for (const axis of ['x', 'y', 'z']) {
          if (coordinate[axis] !== undefined) value.coordinates[axis] = coordinate[axis];
        }
        const groupPdb = rawToken(cells.get(ATOM_COLUMNS.groupPdb));
        if (groupPdb !== undefined) value.groupPdb = groupPdb;
        for (const key of ['labelEntityId', 'labelAsym', 'labelSeqId', 'labelCompId', 'labelAtomId',
          'authAsym', 'authSeqId', 'authCompId', 'authAtomId', 'alt', 'insertionCode']) {
          if (value[key] === undefined) delete value[key];
        }
        if (value.model === undefined) delete value.model;
        if (Object.keys(value.coordinates).length === 0) delete value.coordinates;

        // 同一原子 id 的不同替代构象/模型必须各自独立，键里带行序与构象 token
        const altToken = cells.get(ATOM_COLUMNS.labelAltId);
        const modelToken = cells.get(ATOM_COLUMNS.model);
        const altPart = altToken ? `/${altToken.value}` : '/-';
        const modelPart = modelToken ? `/${modelToken.value}` : '';
        records.push({
          kind: 'atom-observation',
          key: `${blockName}/atom/${idToken.value}${altPart}${modelPart}/row-${row.ordinal}`,
          value,
          provenance: [{ location: formatLocation(row.start, row.end) }]
        });
      }
    }
  }

  return {
    records,
    issues,
    meta: { blocks: parsed.blocks.map(block => block.name), byteLength }
  };
}

export function looksLikeMmCif(bytes, mediaType = '') {
  if (mediaType.toLowerCase().includes('mmcif') || mediaType.toLowerCase().includes('cif')) return true;
  const head = bytes.subarray(0, 4096).toString('utf8');
  return /(^|\n)\s*data_\S/.test(head);
}
