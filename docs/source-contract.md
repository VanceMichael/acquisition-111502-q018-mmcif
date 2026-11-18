# 来源资料契约

支持 PDBx/mmCIF 文本词法、data block、单值与 loop，分号多行值在行首识别；不得假设列顺序。atom-observation 的 value 使用 block、id、labelAsym、authAsym、model、alt（原token）、insertionCode（原token），并保留其余原类别字段和坐标。点号为不适用，问号为未知，原表示不丢失。结构类别按 label 标识关联，auth 字段并列保存，不作为跨实体全局主键。partial 文件最后 loop 行被截断，其余完整观察仍有出处。

## 结构化记录

自动接入在原文收件旁追加以下记录种类，均带 kind、key、value 与 provenance；key 只要求在资料集内同种类稳定，不规定内部编码：

- `chain-observation`：来自 `_struct_asym`，value 含 block、labelAsym 与 labelEntityId 等原字段；链身份按 label 标识。
- `residue-observation`：按 label 链、残基序号（label/auth 并列）、构件号、替代构象原 token 与模型号区分；不同 alt 是不同观察，不做构象合并。
- `atom-observation`：每个 `_atom_site` 行一条，value 含 block、id、labelAsym、authAsym、labelCompId、authCompId、labelSeqId、authSeqId、labelAtomId、authAtomId、alt、insertionCode、model 与坐标；数字字段附解析值，`fields` 内保留每个单元格的原 token 与行列出处。替代构象（alt 原 token 不同）与不同模型各自独立，绝不当重复行删除。
- `entity-observation`：仅当来源实际交付 `_entity` 类别时产生。

label 与 auth 两套标识在链、残基、原子各层并列保存；跨类别关联只按 label 标识，auth 字段不作为全局主键，因此同名 auth 链不会合并不同 label 链。点号 `.` 与问号 `?` 按原 token 保留并可区分，不统一成空字符串；缺失标记不参与数字解析。不做分子渲染、构象合并或化学键推断。

## 问题与未支持范围

关联类别没有交齐（例如 `_struct_asym.entity_id` 引用的 `_entity` 类别缺失）、引用标识在对应类别中不存在、缺失标记占据关键标识时，登记 `missing_related_category` 或 `unresolved_identifier` issue，指出尚不能解释的标识与行列位置，不猜测补全。截断 loop 行登记 `loop_row_truncated`，已完整的行仍产生带出处的观察。未支持的标准类别登记 `unsupported_category`，未识别的扩展字段登记 `unsupported_category_field`，其原值随原子观察或原文保留；不假称已解释。

每条已解释资料均可回到真实来源收件和具体位置。原始载荷与版本必须继续可查，不能以解析后的摘要替代原文。未列出的标准扩展允许明确标识未支持，不允许假称已解释。
