# 来源资料契约

支持 PDBx/mmCIF 文本词法、data block、单值与 loop，分号多行值在行首识别；不得假设列顺序。atom-observation 的 value 使用 block、id、labelAsym、authAsym、model、alt（原token）、insertionCode（原token），并保留其余原类别字段和坐标。点号为不适用，问号为未知，原表示不丢失。结构类别按 label 标识关联，auth 字段并列保存，不作为跨实体全局主键。partial 文件最后 loop 行被截断，其余完整观察仍有出处。

## 自动解释记录形态

自动接入在保留原始收件的同时，产出以下结构化记录（见 GET /collections/{collectionId} 的 records）：

- `entity`：来自 `_entity` loop，value 含 block、entityId、type（列缺失时省略）。
- `struct-asym`：来自 `_struct_asym` loop，value 含 block、labelAsym、entityId；entityId 保留原 token，可能为 `.` 或 `?`。
- `atom-observation`：来自 `_atom_site` loop，每个数据行一条，替代构象（alt 的 A/B/`.` 等）逐行独立登记，绝不按重复行合并。value 并列保存两套标识：
  - label 侧：labelEntityId、labelAsym、labelSeqId、labelCompId、labelAtomId；
  - auth 侧：authAsym、authSeqId、authCompId、authAtomId；
  - 模型与构象：model（数值化，token 为 `.`/`?` 时保留原 token）、alt（label_alt_id 原 token）、insertionCode（pdbx_PDB_ins_code 原 token）；
  - coordinates 保留 Cartn_x/y/z 数值；fields 保留该行全部原类别字段的原 token，列顺序变化不影响取值。

记录键由 block、原子 id、构象 token、模型号与 loop 行序组成，保证同 id 的不同构象与模型各自独立。`.token` 与 `?` 的区别在 value 与 fields 中原样保留，不统一为空字符串。

## 出处与问题

每条记录的 provenance 至少含一个出处：receiptId 绑定该文件的真实原文收件，location 采用 `line=L,col=C,byte=B[-E]` 定位到原 data block 中的 loop 行；GET /receipts/{receiptId}/body 始终返回未改写的原字节。解析后的记录不替代原文。

关联类别没有交齐时，在 issues 中指出尚不能解释的标识，而不是猜测归属：

- `unresolved_entity_reference`：struct_asym 或 atom_site 引用的 label entity 在 `_entity` 中没有定义；
- `unresolved_asym_reference`：atom_site 的 label_asym_id 在 `_struct_asym` 中没有对应链；
- `truncated_loop_row`：loop 最后一行值数不足，该行不登记为观察，其余完整行保留；
- `unsupported_category` / `unsupported_item`：未纳入自动解释的类别或单值项目，原文随收件保留，不假称已解释；
- 词法问题（未闭合引号或分号文本等）同样逐条登记原因与位置。

每条已解释资料均可回到真实来源收件和具体位置。原始载荷与版本必须继续可查，不能以解析后的摘要替代原文。未列出的标准扩展允许明确标识未支持，不允许假称已解释。本服务不做分子渲染、构象合并或化学键推断。
