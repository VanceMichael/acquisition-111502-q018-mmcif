# 来源资料契约

支持 PDBx/mmCIF 文本词法、data block、单值与 loop，分号多行值在行首识别；不得假设列顺序。atom-observation 的 value 使用 block、id、labelAsym、authAsym、model、alt（原token）、insertionCode（原token），并保留其余原类别字段和坐标。点号为不适用，问号为未知，原表示不丢失。结构类别按 label 标识关联，auth 字段并列保存，不作为跨实体全局主键。partial 文件最后 loop 行被截断，其余完整观察仍有出处。

每条已解释资料均可回到真实来源收件和具体位置。原始载荷与版本必须继续可查，不能以解析后的摘要替代原文。未列出的标准扩展允许明确标识未支持，不允许假称已解释。
