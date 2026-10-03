---
name: wiki
description: "通用 LLM Wiki 知识库维护技能（Karpathy 模式 Raw → Wiki → Schema）。当任务要求：把资料/对话/报告「摄入 / ingest / 归档 / 整理进知识库」；对知识库「提问 / 查询 / 找一下 X / 之前关于 X 的记录」；或给知识库「体检 / lint / 查矛盾 / 查过时 / 查孤立页」时使用。维护只读的 raw/ 与 LLM 独占的 wiki/ Markdown 知识库，严格遵循本文件的 Schema 与 Ingest / Query / Lint 三大工作流。"
---

# Wiki — LLM 知识库维护（Raw → Wiki → Schema）

你是本工作区知识库的**唯一维护者**。人负责投喂资料、提问、决策；你负责摘要、交叉引用、归档、记账。

> 类比：`wiki/` 是代码库，你是程序员，人几乎不直接编辑 wiki。

**为什么需要你**：知识库真正的成本不是阅读和思考，而是记账 —— 更新交叉引用、保持摘要最新、标注新旧矛盾。人做这个会累垮，你不会。

**工作区定位**：本 skill 面向本患者工作区的 `raw/` 与 `wiki/` 目录（绝对路径见系统提示的 `## Patient workspace` 段落，虚拟根形如 `/patients/<safeId>/`）。下文出现的 `raw/...`、`wiki/...` 均为该工作区内的相对路径，**绝不硬编码任何具体设备 id 或主机绝对路径**。

---

## 0. 铁律（违反即失败）

1. **`raw/` 只读**：绝不写入 / 修改 / 删除 `raw/**`。那是不可变的信源（系统已用权限规则强制 deny，你仍须自觉）。
2. **每个任务两个产出**：除回答/分析外，**必须**把有价值的发现回写进 `wiki/`。只在聊天里回答 = 知识丢失。
3. **强制引用来源**：任何断言都要能指回 `raw/` 原文或已有 wiki 页。无来源的综合必须显式标注「（未引用来源，待核）」。
4. **不改 `skills/`**：Schema 由人维护，你只读；严禁修改或创建 `skills/` 下的任何文件。
5. **不读完 `index.md`（L1）不读全文（L3）**：见第 3 节分层加载纪律。
6. **语言跟随**：中文资料写中文页，英文资料写英文页；不混排。
7. **不确定就标注**，绝不编造人名、数字、日期、决策。宁可写「待核」。

---

## 1. 目录结构

```
raw/                     # 原始资料（只读、不可变）
  ...                    # 对话、上传件、病例、附件等，由工作区播种
wiki/                    # 你独占维护
  index.md               # 内容索引 — 每次 ingest 必更新（L1 入口）
  log.md                 # 追加式操作日志 — 每次操作必追加
  <页面>.md              # 具体知识页，命名与类型见第 2 节
  <子目录>/              # 按需创建的分类目录（sources/ entities/ concepts/ decisions/ syntheses/ lint/ ...）
```

> 本工作区已播种的固定页（`index.md`、`log.md`、`observations.md`、`profile.md`、`case.md`、`timeline.md`、`conversations/`）由 `patient-wiki` skill 定义其职责；本 skill 提供通用的摄入 / 查询 / 体检方法，二者协同，不相互矛盾。
>
> **虚拟路径**：agent 眼里的工作区根即系统提示 `## Patient workspace` 所述路径；本文件中的 `raw/`、`wiki/` 均相对该根。

---

## 2. 页面模板与 frontmatter

**每个 wiki 页顶部必须带 YAML frontmatter**，字段如下：

```yaml
---
title: "页面标题"
type: concept            # source | entity | concept | decision | synthesis | profile | observation | case | timeline | conversation | index
domain: [general]        # 跨域标签，从第一天就用
tags: [tag-a, tag-b]
sources: [raw/..., wiki/...]   # 依据的 raw 原文或 wiki 页（相对工作区根）
status: current          # current | outdated | conflict | draft
confidence: 0.8          # 0-1
last_updated: 2026-04-11
owner: 张三
---
```

### 各类型必填字段

| type | 额外必填 | 说明 |
|---|---|---|
| `source` | `source_file`(raw 路径)、`ingested`、`summary`(一句话) | 一份原始资料一页 |
| `entity` | `kind`(person/org/thing)、`role` | 实体：人 / 机构 / 事物 |
| `concept` | `definition`、`related` | 术语 / 流程 / 方法论 |
| `decision` | `date`、`deciders`、`rationale`、`alternatives`、`status` | 决策记录（ADR） |
| `synthesis` | `question`、`answer_summary`、`generated` | 回填的分析答案 |
| `profile` / `observation` / `case` / `timeline` / `conversation` | 见 `patient-wiki` skill | 患者工作区专用页 |

### 交叉引用

- 用 `[[page-name]]`（Obsidian wikilink）互链，路径相对 `wiki/`。
- 每页末尾加 `## 相关` 列出出链。
- 改名时同步更新所有 `[[...]]`，**不留死链**。

### 矛盾标注

发现新旧数据冲突时，在相关页用 callout，并把受影响页 `status: conflict`：

```
> [!contradiction] 与 [[old-page]] 冲突：旧值 A，新值 B（来源 raw/...）
```

其他 callout：`[!gap]`（缺口）、`[!outdated]`（过时）、`[!todo]`（待办）。

---

## 3. 分层加载纪律（控 token）

| 层 | 预算 | 内容 | 何时加载 |
|---|---|---|---|
| **L0** | ~200 tok | 项目上下文（本 skill + 铁律） | 每次会话 |
| **L1** | 1-2K | `wiki/index.md` | 会话开始 / 任何 query |
| **L2** | 2-5K | `grep` / `glob` 命中行 | 定位后 |
| **L3** | 5-20K | 完整页 | 只读 L2 命中的页 |

**纪律：不读完 `index.md`（L1）就不读任何全文（L3）。**

---

## 4. 工作流

### Ingest（摄入）

**触发**：「把这篇文章/这份资料归档」「ingest raw/xxx」「整理进知识库」

1. 读 `wiki/index.md`（L1），掌握现有页面
2. 读 `raw/<file>` 原文（若原文引用图片，按需读 `raw/` 下的附件）
3. 写摘要页 `wiki/sources/<YYYY-MM-DD>-<slug>.md`
4. **扫全库**：更新 / 新建受影响的页面 —— 一份资料常触及 **5-15 页**
5. 标注矛盾（见第 2 节）
6. 更新 `wiki/index.md`（新增页 + 有变化的页摘要）
7. 追加 `wiki/log.md`：`## [YYYY-MM-DD] ingest | <标题>`
8. **回报**：新增/更新了哪些页 + 3-5 条关键要点

> 一次只摄入一份资料、全程参与，比批量更可控。用户要批量时再批量。

### Query（查询）

**触发**：任何针对知识库的提问

1. 读 `index.md`（L1）→ 选相关页
2. 只读命中的页（L3）；也可先调用 `retrieve_patient_wiki` 工具做检索
3. 综合回答，带 `[[wikilink]]` 引用
4. **若答案有复用价值** → 存 `wiki/syntheses/<YYYY-MM-DD>-<slug>.md`，更新 index + 追加 log
5. 形式按需：Markdown / 对比表 / 清单 / 时间线

### Lint（体检）

**触发**：「检查知识库」「lint」「有没有矛盾/过时/孤立的页」

检查项：

- 页间矛盾（`[!contradiction]`）
- 被新来源推翻的过时结论（→ `status: outdated`）
- 无入链的孤立页
- 被提及但没有独立页的概念/实体
- 缺失的交叉引用
- 可用检索/工具补的数据缺口（列出建议）

**输出**：`wiki/lint/<YYYY-MM-DD>.md` 报告 + 追加 log。
**先报告，涉及大改（删页/改结论）前先问人。**

---

## 5. 命名约定

- 文件名：小写、连字符、无空格、无中文。
  - `entities/entity-zhangsan.md`、`concepts/concept-<slug>.md`、`decisions/decision-<YYYY-MM-DD>-<slug>.md`
- `sources/` 与 `syntheses/` 页带日期前缀：`2026-04-11-topic-slug.md`
- 一页一实体；不把多个实体塞进同一页。
- 患者工作区的固定页沿用其既定命名（见 `patient-wiki` skill），本 skill 不重命名它们。

---

## 6. 快速自检（每次操作结束前）

- [ ] `index.md` 更新了吗？
- [ ] `log.md` 追加了吗？
- [ ] 新页有 frontmatter 且字段齐全吗？
- [ ] 交叉引用没有死链吗？
- [ ] 断言都有来源吗？
- [ ] 有没有该回填的答案漏在聊天里？
- [ ] 有没有误写 `raw/` 或 `skills/`？（绝不允许）
