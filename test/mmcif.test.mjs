import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMmCif, tokenize } from '../src/mmcif-parser.mjs';
import { interpret, formatLocation } from '../src/mmcif-interpreter.mjs';

function atomRecords(text) {
  return interpret(parseMmCif(text)).records.filter(record => record.kind === 'atom-observation');
}

test('loop 列顺序改变后仍按列名正确关联', () => {
  const standard = `data_b
loop_
_atom_site.id
_atom_site.label_asym_id
_atom_site.label_alt_id
_atom_site.pdbx_PDB_model_num
1 A A 1
#
`;
  const reordered = `data_b
loop_
_atom_site.pdbx_PDB_model_num
_atom_site.label_alt_id
_atom_site.label_asym_id
_atom_site.id
1 A A 1
#
`;
  const [a] = atomRecords(standard);
  const [b] = atomRecords(reordered);
  assert.deepEqual(a.value, b.value);
  assert.equal(a.value.labelAsym, 'A');
  assert.equal(a.value.alt, 'A');
  assert.equal(a.value.model, 1);
});

test('点号与问号保留原 token，不归一化为空字符串', () => {
  const text = `data_c
loop_
_atom_site.id
_atom_site.label_alt_id
_atom_site.pdbx_PDB_ins_code
_atom_site.label_seq_id
1 . ? .
#
`;
  const [record] = atomRecords(text);
  assert.equal(record.value.alt, '.', '点号表示不适用');
  assert.equal(record.value.insertionCode, '?', '问号表示未知');
  assert.equal(record.value.labelSeqId, '.');
  assert.equal(record.value.fields['_atom_site.label_alt_id'], '.');
  assert.equal(record.value.fields['_atom_site.pdbx_PDB_ins_code'], '?');
});

test('同一原子 id 的替代构象逐行保留，不做重复行合并', () => {
  const text = `data_d
loop_
_struct_asym.id
_struct_asym.entity_id
A 1
#
loop_
_atom_site.id
_atom_site.label_asym_id
_atom_site.label_alt_id
_atom_site.pdbx_PDB_model_num
1 A A 1
1 A B 1
1 A . 1
#
`;
  const records = atomRecords(text);
  assert.equal(records.length, 3);
  assert.deepEqual(records.map(r => r.value.alt), ['A', 'B', '.']);
  assert.equal(new Set(records.map(r => r.key)).size, 3, '替代构象必须有各自独立的键');
});

test('模型号与插入码共同区分观察，插入码 token 原样保留', () => {
  const text = `data_e
loop_
_atom_site.id
_atom_site.label_asym_id
_atom_site.pdbx_PDB_model_num
_atom_site.pdbx_PDB_ins_code
_atom_site.label_alt_id
1 A 1 A .
1 A 2 ? .
#
`;
  const records = atomRecords(text);
  assert.equal(records.length, 2);
  assert.equal(records[0].value.model, 1);
  assert.equal(records[0].value.insertionCode, 'A');
  assert.equal(records[1].value.model, 2);
  assert.equal(records[1].value.insertionCode, '?');
});

test('分号多行值只在行首识别，引号值按 CIF 词法处理', () => {
  const text = `data_f
_struct.title
;first line
second line
;
loop_
_atom_site.id
_atom_site.label_asym_id
1 'chain A'
2 "chain B"
#
`;
  const parsed = parseMmCif(text);
  const title = parsed.blocks[0].items.find(item => item.name === '_struct.title');
  assert.equal(title.value.value, 'first line\nsecond line');
  const records = atomRecords(text);
  assert.deepEqual(records.map(r => r.value.labelAsym), ['chain A', 'chain B']);
});

test('截断的 loop 行产生 issue，完整行仍保留出处', () => {
  const text = `data_g
loop_
_atom_site.id
_atom_site.label_asym_id
1 A
2
`;
  const parsed = parseMmCif(text);
  const outcome = interpret(parsed);
  assert.ok(outcome.issues.some(issue => issue.reason === 'truncated_loop_row'));
  const records = outcome.records.filter(r => r.kind === 'atom-observation');
  assert.equal(records.length, 1);
  assert.equal(records[0].value.id, '1');
  assert.match(records[0].provenance[0].location, /line=\d+,col=\d+,byte=\d+/);
});

test('关联类别未交齐时指出尚不能解释的标识', () => {
  const text = `data_h
loop_
_atom_site.id
_atom_site.label_asym_id
_atom_site.label_entity_id
1 A 9
#
`;
  const outcome = interpret(parseMmCif(text));
  assert.ok(outcome.issues.some(issue => issue.reason === 'unresolved_asym_reference' && issue.ref === 'A'));
  assert.ok(outcome.issues.some(issue => issue.reason === 'unresolved_entity_reference' && issue.ref === '9'));
  assert.equal(outcome.records.filter(r => r.kind === 'atom-observation').length, 1, '观察本身仍登记');
});

test('label 与 auth 同名链并列保存，auth 不作为跨实体主键', () => {
  const text = `data_i
loop_
_struct_asym.id
_struct_asym.entity_id
A 1
B 2
#
loop_
_atom_site.id
_atom_site.label_asym_id
_atom_site.auth_asym_id
1 A X
2 B X
#
`;
  const records = atomRecords(text);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map(r => [r.value.labelAsym, r.value.authAsym]), [['A', 'X'], ['B', 'X']]);
  assert.equal(new Set(records.map(r => r.value.labelAsym)).size, 2);
});

test('出处行列与字节位置指向 token 真实起点', () => {
  const text = `data_j
loop_
_atom_site.id
_atom_site.label_asym_id
1 A
#
`;
  const [record] = atomRecords(text);
  const location = record.provenance[0].location;
  const match = location.match(/^line=(\d+),col=(\d+),byte=(\d+)/);
  assert.ok(match);
  const line = Number(match[1]);
  const column = Number(match[2]);
  const byteOffset = Number(match[3]);
  const lines = text.split('\n');
  assert.equal(lines[line - 1].slice(column - 1, column), '1');
  assert.equal(Buffer.byteLength(text.slice(0, byteOffset)), byteOffset);
});

test('多 data block 分别解释，block 名进入每条记录', () => {
  const text = `data_one
loop_
_atom_site.id
1
#
data_two
loop_
_atom_site.id
2
#
`;
  const records = atomRecords(text);
  assert.deepEqual(records.map(r => r.value.block), ['one', 'two']);
});

test('未支持的类别明确标识，不假称已解释', () => {
  const text = `data_k
loop_
_geom_bond.atom_site_id_1
_geom_bond.atom_site_id_2
1 2
#
`;
  const outcome = interpret(parseMmCif(text));
  assert.ok(outcome.issues.some(issue => issue.reason === 'unsupported_category'));
  assert.equal(outcome.records.length, 0, '不做化学键推断');
});

test('formatLocation 对零宽点保留单字节定位', () => {
  const formatted = formatLocation({ line: 3, column: 5, offset: 42 });
  assert.equal(formatted, 'line=3,col=5,byte=42');
});

test('词法层记录行列，注释与空行不破坏定位', () => {
  const text = `# leading comment

data_l
# another
_atom_site.id 7
`;
  const { tokens, issues } = tokenize(text);
  assert.deepEqual(issues, []);
  const value = tokens.find(token => token.type === 'value' && token.value === '7');
  assert.equal(value.start.line, 5);
});

test('跨行引号值之后的 token 行列与字节定位仍然准确', () => {
  const text = `data_m
_loop_demo.value
"line one
line two"
after_token
`;
  const { tokens, issues } = tokenize(text);
  assert.deepEqual(issues, []);
  const after = tokens.find(token => token.type === 'value' && token.value === 'after_token');
  assert.equal(after.start.line, 5);
  assert.equal(after.start.column, 1);
  const prefix = text.slice(0, text.indexOf('after_token'));
  assert.equal(after.start.offset, Buffer.byteLength(prefix, 'utf8'));
});
