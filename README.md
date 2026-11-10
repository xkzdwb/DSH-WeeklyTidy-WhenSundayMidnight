# DSH-WeeklyTidy-WhenSundayMidnight

> 每周日 00:00，让模型看一眼每个工作区根目录的散落文件，按项目收进 `NN-中文项目名/` 文件夹。

- **给 DSH 用**：Cordis 插件，挂在 HOST 里，到点自己整理；到点时 DSH 没开，下次启动补跑一次。
- **判断靠模型**：读文件名、大小、日期和文本片段，决定哪些文件属于同一个项目、该叫什么名字。
- **只移动，不删除**：文件保持原名搬进文件夹，每次运行都有账本，一条命令整批撤回。
- **零依赖**：只用 Node 内置模块，不需要 `npm install`。

---

## 1. 它做什么、不做什么

| 做 | 不做 |
|---|---|
| 只看工作区**根目录第一层**的散落文件 | 不递归子目录，不动子目录里的任何东西 |
| 把文件按项目归组，建 `<工作区>/NN-中文项目名/` | 不改文件名（避免打断脚本里的相对路径） |
| 编号接根目录已有编号的最大值往后排 | 不重建、不覆盖已有项目文件夹 |
| 一组不到 3 个文件就留在原处 | 不为一个文件单开文件夹 |
| 写 `audit/` 账本 + 可读报告，支持整批撤回 | 不删除任何文件、不改工作区目录本身 |

以数字开头的文件夹（`01-项目名`、`02-项目名` 这种）会被当成「已经整理好的项目」，整棵跳过；
README、`package.json`、`cordis.patch.yml`、锁文件、隐藏项、`.git`/`node_modules`/`build` 之类开发目录、
最近 1 天改过的文件，也都不动。

## 2. 判断与命名

- 每个工作区一次模型调用：输入是该工作区标题、已有编号目录、README 里登记过的项目名，以及候选文件的
  文件名 / 大小 / 日期 / 文本片段预览；要求模型输出 `{"groups":[{"folder":"…","files":[…]}]}`。
- 模型输出不可信，全部在本地校验：文件名必须在候选里，项目名要清洗（去编号、去标点、限长），
  撞上已有文件夹自动加 `-2`，组太小拆回未分组。
- 编号从根目录已有 `NN-` 的最大值 +1 开始；文件名保持原样，不做 `01-` 前缀。
- 拿不准的文件留在原处，报告里逐条写原因。

## 3. 装上它

需要 DSH 的桌面版（插件依赖 `workspaceRegistry`、`llm`、`agentDefaultModel` 这几个 HOST 服务）。

**方式一：插件管理页安装（推荐）**

1. 插件管理 → 安装本地包，选这个目录（包含 `package.json` 的那一层）。
2. 安装后确认状态是 enabled / active。
3. 看状态：浏览器打开 `http://127.0.0.1:<DSH 端口>/plugin-weekly-tidy/status`。

**方式二：手动写进 profile 的 `cordis.patch.yml`**

把 `examples/cordis.patch.snippet.yml` 里的 `insert` 段合并进
`~/.dsh/profiles/<你的 profile>/cordis.patch.yml`，`name` 改成这个目录的绝对路径或包名。

装好后，插件的配置项都在 `cordis.patch.yml` 里（见第 4 节），插件管理页也能改。

## 4. 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `weekday` | `0` | 0=周日 … 6=周六 |
| `time` | `'00:00'` | 墙钟时间 |
| `timeZone` | `Asia/Shanghai` | 时区，不看本机时区 |
| `catchUp` | `true` | 错过 0 点后开机 5 分钟内补跑 |
| `tickIntervalMs` | `30000` | 轮询间隔（毫秒） |
| `minAgeDays` | `1` | 最近 N 天改过的不动；0 = 不限 |
| `minFilesPerProject` | `3` | 一组至少几个文件才建夹 |
| `maxFilesPerRun` | `200` | 单次运行最多搬几个文件（熔断） |
| `maxFilesPerPrompt` | `40` | 一次模型调用喂几个文件，多时自动分批 |
| `nameMaxLength` | `24` | 项目名最长字符数（不含编号） |
| `model` | `''` | 留空 = 当前会话默认模型；也可写 `provider/model` |
| `workspaces` | `[]` | 留空 = 全部注册工作区；可填 id / 标题 / 绝对路径 |
| `excludeWorkspaces` | `['default-workspace']` | 不整理的工作区 |
| `protectPaths` | `[]` | 额外保护路径（连同下面所有东西） |
| `protectNames` | `[]` | 额外保护的文件名（根目录里见到就跳过） |

保护名单里永远有：插件自身目录、profile 的 `cordis.patch.yml` / `package.json` 里用引号写着的绝对路径。

## 5. 命令

```bash
cd /path/to/DSH-WeeklyTidy-WhenSundayMidnight

node tools/tidy.mjs status        # 下次什么时候跑、上次搬了什么
node tools/tidy.mjs plan          # 只读预览：打算建哪些夹、搬哪些文件（会调模型）
node tools/tidy.mjs plan --json   # 同上，完整 JSON
node tools/tidy.mjs apply --yes   # 真搬（不带 --yes 只打印计划）
node tools/tidy.mjs undo last     # 撤回最近一次运行
node tools/tidy.mjs undo 20261115-000012
```

命令默认连 `http://127.0.0.1:9683`，端口不同就加 `--base http://127.0.0.1:<端口>`；
`undo` 不联网，直接读本地账本。

对应路由（HOST 里注册）：

- `GET /plugin-weekly-tidy/status` — 状态、下次运行时间
- `GET /plugin-weekly-tidy/plan` — 只读预览
- `POST /plugin-weekly-tidy/run` — `{"dryRun":true}` 只出计划；`{"confirm":"run"}` 真搬

## 6. 账本与撤回

每次运行写：

- `audit/runs/<runId>.json` / `.md` — 完整计划、执行结果、可读报告
- `audit/journal.jsonl` — 追加式账本，`undo` 靠它反序把文件搬回原位并删掉这次新建的空目录
- `audit/state.json` — 上次运行时间、下次运行时间

`undo` 不覆盖已有文件：整理后的文件被人挪走、或原位置已经有同名文件，那一条记为失败并列出来，
其余照常撤回。

## 7. 自测

```bash
node test/run-tests.mjs
```

22 项离线测试，不联网、不调真模型（临时目录 + 假 `askModel`），覆盖命名/编号/扫描/分批/模型报错/
熔断/执行与撤回/时区与配置回退。GitHub Actions 也会在每次 push 时跑一遍（`.github/workflows/test.yml`）。

## 8. 已知限制

- 项目名由模型起，同一次运行内稳定，不同次运行措辞可能略有差别。
- 文件保持原名，但搬进子目录后，原本按相对路径读写它们的脚本可能需要跟着改；
  不满意直接 `undo <runId>` 全部还原。
- 一个工作区散落文件很多时按 `maxFilesPerPrompt` 分批调用模型，再按项目名合并；
  跨批次同名项目会合并，但不同批次可能给出略不同的名字，此时会各建一个文件夹（可用 `undo` 重来）。
- 只在 Windows / macOS / Linux 的 Node 20+ 上验证过路径处理；Windows 上路径比较不区分大小写。

## License

MIT
