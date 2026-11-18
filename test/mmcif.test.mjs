// 解析与解释器单元测试：不经过 HTTP，直接用合成 mmCIF 文本验证词法/语法/关联语义。
// 合成样本为公开性质的测试数据，不包含真实凭据；本脚本自身在 test 目录，数据经参数传入。
import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../src/mmcif/tokenizer.mjs';
import { parse } from '../src/mmcif/parser.mjs';
import { interpret } from '../src/mmcif/interpreter.mjs';

const receiptId = 'a'.repeat(64);

function interpretText(text) {
  return interpret(parse(text), receiptId, 'test://sample.cif');
}

test('点号与问号保留原 token，不统一成空字符串', () => {
  const text = [
    'data_demo',
    'loop_',
    '_atom_site.id',
    '_atom_site.label_asym_id',
    '_atom_site.auth_asym_id',
    '_atom_site.label_comp_id',
    '_atom_site.auth_seq_id',
    '_atom_site.label_seq_id',
    '_atom_site.label_atom_id',
    '_atom_site.label_alt_id',
    '_atom_site.pdbx_PDB_ins_code',
    '_atom_site.pdbx_PDB_model_num',
    '_atom_site.Cartn_x',
    '_atom_site.Cartn_y',
    '_atom_site.Cartn_z',
    '1 A X ALA 10 . CA . ? 1 1.0 2.0 3.0',
  ].join('\n');
  const { records, issues } = interpretText(text);
  assert.equal(issues.length, 0);
  const atom = records.find(record => record.kind === 'atom-observation');
  assert.equal(atom.value.alt, '.');
  assert.equal(atom.value.insertionCode, '?');
  assert.equal(atom.value.fields.label_alt_id.token, '.');
  assert.equal(atom.value.fields.pdbx_PDB_ins_code.token, '?');
  assert.equal(atom.value.labelSeqId, '.');
});

test('loop 列次序改变仍按列名正确映射', () => {
  const text = [
    'data_reorder',
    'loop_',
    '_atom_site.Cartn_z',
    '_atom_site.pdbx_PDB_model_num',
    '_atom_site.label_alt_id',
    '_atom_site.id',
    '_atom_site.label_asym_id',
    '_atom_site.auth_asym_id',
    '_atom_site.label_comp_id',
    '_atom_site.auth_seq_id',
    '_atom_site.label_seq_id',
    '_atom_site.label_atom_id',
    '_atom_site.pdbx_PDB_ins_code',
    '_atom_site.Cartn_x',
    '_atom_site.Cartn_y',
    '3.0 1 A 7 L W GLY 20 2 N . 1.0 2.0',
  ].join('\n');
  const { records } = interpretText(text);
  const atom = records.find(record => record.kind === 'atom-observation');
  assert.equal(atom.value.id, '7');
  assert.equal(atom.value.labelAsym, 'L');
  assert.equal(atom.value.authAsym, 'W');
  assert.equal(atom.value.alt, 'A');
  assert.equal(atom.value.model, 1);
  assert.deepEqual([atom.value.cartnX, atom.value.cartnY, atom.value.cartnZ], [1, 2, 3]);
});

test('替代构象产生两条独立原子观察，键不相同且互不覆盖', () => {
  const text = [
    'data_alt',
    'loop_',
    '_struct_asym.id',
    '_struct_asym.entity_id',
    'A 1',
    '#',
    'loop_',
    '_atom_site.id',
    '_atom_site.label_asym_id',
    '_atom_site.auth_asym_id',
    '_atom_site.label_comp_id',
    '_atom_site.auth_seq_id',
    '_atom_site.label_seq_id',
    '_atom_site.label_atom_id',
    '_atom_site.label_alt_id',
    '_atom_site.pdbx_PDB_ins_code',
    '_atom_site.pdbx_PDB_model_num',
    '_atom_site.Cartn_x',
    '_atom_site.Cartn_y',
    '_atom_site.Cartn_z',
    '1 A X ALA 10 1 CA A . 1 1.0 2.0 3.0',
    '2 A X ALA 10 1 CA B . 1 1.1 2.1 3.1',
  ].join('\n');
  const { records } = interpretText(text);
  const atoms = records.filter(record => record.kind === 'atom-observation');
  assert.equal(atoms.length, 2);
  assert.notEqual(atoms[0].key, atoms[1].key);
  assert.deepEqual(atoms.map(record => record.value.alt).sort(), ['A', 'B']);
  const residues = records.filter(record => record.kind === 'residue-observation');
  assert.equal(residues.length, 2);
});

test('关联类别缺交或标识无法解释时显式登记 issue，不猜测补全', () => {
  const text = [
    'data_link',
    'loop_',
    '_struct_asym.id',
    '_struct_asym.entity_id',
    'A 9',
    '#',
    'loop_',
    '_atom_site.id',
    '_atom_site.label_asym_id',
    '_atom_site.auth_asym_id',
    '_atom_site.label_comp_id',
    '_atom_site.auth_seq_id',
    '_atom_site.label_seq_id',
    '_atom_site.label_atom_id',
    '_atom_site.label_alt_id',
    '_atom_site.pdbx_PDB_ins_code',
    '_atom_site.pdbx_PDB_model_num',
    '_atom_site.Cartn_x',
    '_atom_site.Cartn_y',
    '_atom_site.Cartn_z',
    '1 Z X GLY 1 . N . . 1 1 2 3',
  ].join('\n');
  const { records, issues } = interpretText(text);
  assert.ok(records.some(record => record.kind === 'atom-observation' && record.value.labelAsym === 'Z'));
  assert.ok(issues.some(issue => issue.reason === 'unresolved_identifier' && issue.detail.includes('Z')));
  // _entity 类别整体缺交：链引用的实体 9 无法核对，按缺件报告而非伪造实体记录。
  assert.ok(issues.some(issue => issue.reason === 'missing_related_category' || issue.detail.includes('9')));
});

test('未支持的标准类别与扩展字段明确标识，不假称已解释', () => {
  const text = [
    'data_ext',
    'loop_',
    '_atom_site.id',
    '_atom_site.label_asym_id',
    '_atom_site.auth_asym_id',
    '_atom_site.label_comp_id',
    '_atom_site.auth_seq_id',
    '_atom_site.label_seq_id',
    '_atom_site.label_atom_id',
    '_atom_site.label_alt_id',
    '_atom_site.pdbx_PDB_ins_code',
    '_atom_site.pdbx_PDB_model_num',
    '_atom_site.Cartn_x',
    '_atom_site.Cartn_y',
    '_atom_site.Cartn_z',
    '_atom_site.custom_extension',
    '1 A X GLY 1 . N . . 1 1 2 3 kept',
    '#',
    'loop_',
    '_chem_comp.id',
    '_chem_comp.name',
    'GLY "glycine"',
  ].join('\n');
  const { records, issues } = interpretText(text);
  assert.equal(records.filter(record => record.kind === 'atom-observation').length, 1);
  assert.ok(issues.some(issue => issue.reason === 'unsupported_category_field' && issue.detail.includes('custom_extension')));
  assert.ok(issues.some(issue => issue.reason === 'unsupported_category' && issue.detail.includes('_chem_comp')));
  // 扩展字段原值仍随原子观察保留。
  const atom = records.find(record => record.kind === 'atom-observation');
  assert.equal(atom.value.fields.custom_extension.token, 'kept');
});

test('引号、分号多行值与注释按词法处理并保留行列出处', () => {
  const text = [
    '# leading comment',
    'data_quoted',
    '_struct.title',
    ';line one',
    'line two',
    ';',
    'loop_',
    '_struct_asym.id',
    '_struct_asym.entity_id',
    "'A' 1",
  ].join('\n');
  const { tokens, issues } = tokenize(text);
  assert.equal(issues.length, 0);
  const multiline = tokens.find(token => token.type === 'text');
  assert.equal(multiline.value, 'line one\nline two');
  assert.equal(multiline.start.line, 4);
  const parsed = parse(text);
  assert.equal(parsed.blocks[0].items.get('_struct.title').value.token, 'line one\nline two');
  const chainLoop = parsed.blocks[0].loops[0];
  assert.equal(chainLoop.rows[0].cells[0].token, 'A');
});

test('截断 loop 行登记问题，已完整单元格仍可解释，出处回到行列', () => {
  const text = [
    'data_cut',
    'loop_',
    '_atom_site.id',
    '_atom_site.label_asym_id',
    '_atom_site.auth_asym_id',
    '_atom_site.label_comp_id',
    '_atom_site.auth_seq_id',
    '_atom_site.label_seq_id',
    '_atom_site.label_atom_id',
    '_atom_site.label_alt_id',
    '_atom_site.pdbx_PDB_ins_code',
    '_atom_site.pdbx_PDB_model_num',
    '_atom_site.Cartn_x',
    '_atom_site.Cartn_y',
    '_atom_site.Cartn_z',
    '1 A X GLY 1 . N . . 1 1 2 3',
    '2 B',
  ].join('\n');
  const parsed = parse(text);
  assert.ok(parsed.issues.some(issue => issue.reason === 'loop_row_truncated'));
  const { records, issues } = interpret(parsed, receiptId, 'test://cut.cif');
  assert.equal(records.filter(record => record.kind === 'atom-observation').length, 1);
  assert.ok(issues.every(issue => issue.receiptId === receiptId && issue.location.includes('line:')));
  const atom = records.find(record => record.kind === 'atom-observation');
  assert.ok(atom.provenance[0].location.startsWith('line:'));
  assert.equal(atom.provenance[0].receiptId, receiptId);
});

test('多个 data block 分别解释，block 名进入记录身份', () => {
  const header = [
    'loop_',
    '_atom_site.id',
    '_atom_site.label_asym_id',
    '_atom_site.auth_asym_id',
    '_atom_site.label_comp_id',
    '_atom_site.auth_seq_id',
    '_atom_site.label_seq_id',
    '_atom_site.label_atom_id',
    '_atom_site.label_alt_id',
    '_atom_site.pdbx_PDB_ins_code',
    '_atom_site.pdbx_PDB_model_num',
    '_atom_site.Cartn_x',
    '_atom_site.Cartn_y',
    '_atom_site.Cartn_z',
  ].join('\n');
  const row = '1 A X GLY 1 . N . . 1 1 2 3';
  const text = ['data_one', header, row, 'data_two', header, row].join('\n');
  const { records } = interpretText(text);
  const blocks = new Set(records.filter(record => record.kind === 'atom-observation').map(record => record.value.block));
  assert.deepEqual([...blocks].sort(), ['one', 'two']);
  const keys = records.filter(record => record.kind === 'atom-observation').map(record => record.key);
  assert.equal(new Set(keys).size, keys.length);
});
