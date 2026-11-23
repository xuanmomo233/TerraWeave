# TerraWeave 桌面开发包

将整个 ZIP 解压至可写目录，双击第一层的「织境工坊.exe」。便携开发包与安装版均内置 Node.js，缺少 WebView2 时通过微软官方安装程序补齐。安装版支持 English、简体中文和自选安装目录。

在「文件 → 世界存档来源」选择含 `level.dat` 的 Java 版存档根目录。首次进入三维会从本机资源或 Mojang 获取对应存档版本的原版模型和纹理。规划和预览写入本地 `project-state/workbench`，可用 `TERRAWEAVE_STATE` 指定独立工程目录。

## 插件与 MCP 使用指南

| 组件 | 用途 | 运行位置 |
| --- | --- | --- |
| `map_workbench` | 读存档、管理规划、截图、编辑草稿及导出方案 | 织境工坊所在电脑 |
| `world_writer` | 提交导出方案、查看回执、续接、撤销和重做 | 能直接读写 `plugins/TerraWeave` 的主机 |
| TerraWeave 插件 | 核对目标世界和现有方块，再在服务端执行写入 | 目标 Paper 服务端 |

日常离线工作配置 `map_workbench` 即可。需要把方案写入目标服时，再配置 `world_writer` 并安装插件。

### 安装 TerraWeave 插件

1. 停止目标 Paper 服务端，移出先前安装的桥接插件 JAR，再将 `TerraWeave.jar` 放入 `plugins`。下表通过验收的 Paper 版本共用这个文件。[下载 TerraWeave.jar 1.2.0](https://github.com/xuanmomo233/TerraWeave/releases/download/plugin-v1.2.0/TerraWeave.jar)
2. 启动目标服。确认服务端日志显示 `Persistent map workbench ready`，且 `plugins/TerraWeave/heartbeat.json` 持续更新。插件绑定服务端启动时的第一个已加载世界，心跳文件中的 `world`、`world_uuid` 和 `minecraft` 可用于核对目标。
3. 用织境工坊打开目标服的存档或其副本。副本应保留世界身份文件。新版 Paper 的主世界身份在 `dimensions/minecraft/overworld/data/paper/metadata.dat`，旧版使用 `uid.dat`。已有工程曾按 `local-` 标识记录规划时，工坊会从该工程关联的存档读取 Paper UUID，导出时填入方案。导出方案的世界 UUID 和游戏版本须与目标服匹配，目标坐标须位于已生成的区块内。

工作台制作和导出草稿只写入工程目录里的方案文件。提交后由目标 Paper 服务端按其当前 Minecraft 版本写方块和保存区块。Minecraft 或 Paper 升级存档时，由游戏服务端负责迁移。

新版在 `plugins/TerraWeave` 下建立独立的写入记录。已有的 `world_writer` 配置需把 `TERRAWEAVE_WRITE_BRIDGE` 和显式设置的 `TERRAWEAVE_WRITER_STATE` 改为下文的新路径，再在新聊天中确认 MCP 已加载。先前的操作记录可留存备查，新版从新目录读取回执。

### Paper 版本兼容

TerraWeave 插件 **1.2.0** 使用同一份 JAR 在 Paper 1.20.1 至 26.3 范围内逐版验收。下表列出实际测试的官方构建及上游渠道。1.20.x 至 1.21.11 使用 Java 21，26.1.1 至 26.3 使用 Java 25。[Paper 下载服务](https://docs.papermc.io/misc/downloads-service/) · [Paper Java 要求](https://docs.papermc.io/paper/getting-started/)

每个通过的构建均在实际 Paper 进程中写入箱子、木桶和旗帜，再执行撤销、重做和二次撤销。测试比较两次恢复得到的完整 SNBT，覆盖物品槽位及数量、物品自定义数据、容器名称、旗帜图案和插件持久数据。另验证重做会保留后来改过内容的箱子。

| Minecraft 版本 | Paper 构建 | 渠道 | 写入、撤销、重做及 NBT |
| --- | ---: | --- | --- |
| 1.20.1 | 196 | STABLE | 通过 |
| 1.20.2 | 318 | STABLE | 通过 |
| 1.20.3 | — | — | 官方源无构建 |
| 1.20.4 | 499 | STABLE | 通过 |
| 1.20.5 | 22 | ALPHA | 通过 |
| 1.20.6 | 151 | STABLE | 通过 |
| 1.21 | 130 | STABLE | 通过 |
| 1.21.1 | 133 | STABLE | 通过 |
| 1.21.2 | — | — | 官方源无构建 |
| 1.21.3 | 83 | STABLE | 通过 |
| 1.21.4 | 232 | STABLE | 通过 |
| 1.21.5 | 114 | ALPHA | 通过 |
| 1.21.6 | 48 | STABLE | 通过 |
| 1.21.7 | 32 | STABLE | 通过 |
| 1.21.8 | 60 | STABLE | 通过 |
| 1.21.9 | 59 | ALPHA | 通过 |
| 1.21.10 | 130 | STABLE | 通过 |
| 1.21.11 | 132 | STABLE | 通过 |
| 26.1 | — | — | 官方源无构建 |
| 26.1.1 | 29 | ALPHA | 通过 |
| 26.1.2 | 74 | STABLE | 通过 |
| 26.2 | 135 | STABLE | 通过 |
| 26.3 | 259 | STABLE | 通过 |

NBT 回执绑定其生成时的 Minecraft 版本。执行恢复时使用与回执一致的版本。服务端心跳的 `block_entity_payload=1` 表示原版容器与旗帜的 NBT 适配器已启用。

### 跨版本转换建筑方案

1. 在工坊打开目标 Paper 世界的存档，选择「文件 → 转换建筑方案」，打开原工程导出的 JSON。
2. 查看目标版本、方块兼容结果和原坐标上将被替换的已有方块。对待处理的方块输入目标方块状态，然后点「检查方案」重新核对。
3. 点「生成方案」。新 JSON 保存在目标工程的 `exports` 下，包含目标存档的 UUID、版本和方块基线。用写入 MCP 提交新方案时，目标服会再次校验。

支持 1.20.1 到 26.3 的 23 个 Java 正式版。版本表由对应 Mojang 正式服务端的方块报告生成，记录所有方块 ID、合法属性取值和默认状态。已确认的跨版本改名包括 1.20.3 的短草与 1.21.9 的铁链。可保留的属性会一并转换。目标版本新增的属性使用官方默认值。旧版缺少的方块、无法表示的含水或乐器状态，以及苍白之心等无法直接对应的属性，需要明确指定替换状态。[Java 版 1.20.3](https://feedback.minecraft.net/hc/en-us/articles/21968446892173-Minecraft-Java-Edition-1-20-3) · [Java 版 1.21.9](https://www.minecraft.net/en-us/article/minecraft-java-edition-1-21-9)

转换针对方块布局。建筑方案格式记录位置和方块状态，容器物品、告示牌文字、实体及整张世界的数据不属于方案。转换不会升级、降级或写入存档。

### 配置 Codex

在可信任的 Codex 工程的 `.codex/config.toml` 中加入以下配置。示例使用便携包内的 Node.js，路径按实际安装位置替换。已有同名配置时，编辑原配置块。加载工程配置时可用 `codex mcp list` 检查条目，新聊天中再检查工具是否出现。[Codex MCP 配置说明](https://developers.openai.com/codex/mcp)

```toml
[mcp_servers.map_workbench]
command = 'D:\TerraWeave\runtime\node.exe'
args = ['D:\TerraWeave\tools\creative-workbench.mjs', '--stdio']
cwd = 'D:\TerraWeave'
startup_timeout_sec = 20
tool_timeout_sec = 180

[mcp_servers.map_workbench.env]
TERRAWEAVE_STATE = 'D:\TerraWeave\project-state\workbench'

[mcp_servers.world_writer]
command = 'D:\TerraWeave\runtime\node.exe'
args = ['D:\TerraWeave\tools\writer-mcp.mjs', '--stdio']
cwd = 'D:\TerraWeave'
startup_timeout_sec = 20
tool_timeout_sec = 180
default_tools_approval_mode = 'prompt'

[mcp_servers.world_writer.env]
TERRAWEAVE_WRITE_BRIDGE = 'D:\Paper\plugins\TerraWeave'
TERRAWEAVE_WRITER_STATE = 'D:\Paper\plugins\TerraWeave\writer-state'
```

- 默认为原工程时可沿用示例的 `TERRAWEAVE_STATE`。使用其他工程时，从织境工坊「文件 → 打开工程目录」取得实际工程路径并填入。调用 `map_workbench.workbench_status` 核对存档及所选规划。
- `TERRAWEAVE_WRITE_BRIDGE` 填插件生成 `heartbeat.json` 的目录。写入 MCP 的运行账号需要读取心跳和回执，并能在插件数据目录中创建请求文件。连接后可调用 `world_writer.list_world_writes`，首次返回空列表属于正常情况。该调用只查历史，服务端是否在线仍由心跳确认。
- `TERRAWEAVE_WRITER_STATE` 存放写入与撤销记录。省略时默认为插件数据目录下的 `writer-state`。同一目标世界复用同一个记录目录，测试服和生产服使用各自的记录目录。

### 远程 Paper 服务端

远程服务器上准备 Node.js，以及同版本的织境工坊文件。可以将便携开发包解压后把 `tools/`、`minecraft-version.js` 和 `package.json` 传到服务端，保留它们的目录结构。Windows 便携包中的 `node.exe` 用于 Windows 主机。

写入 MCP 可在 Paper 所在主机运行。本机 Codex 可以通过已有的 SSH 连接启动该 STDIO 进程。下例替换同机配置中的整个 `world_writer` 部分，`map_workbench` 仍使用本机配置。先把导出的 JSON 传到服务器，`export_path` 填服务器上该文件的绝对路径。

```toml
[mcp_servers.world_writer]
command = 'ssh'
args = ['-T', '-o', 'BatchMode=yes', 'deploy@paper.example.org',
  'env TERRAWEAVE_WRITE_BRIDGE=/srv/paper/plugins/TerraWeave TERRAWEAVE_WRITER_STATE=/srv/paper/plugins/TerraWeave/writer-state /usr/bin/node /opt/terraweave/tools/writer-mcp.mjs --stdio']
startup_timeout_sec = 25
tool_timeout_sec = 180
default_tools_approval_mode = 'prompt'
```

### AI 施工前的规划归属

每个由 AI 制作的建筑、地台、廊道或园景都必须先归入一个规划。需要独立选中或隐藏的部分分别建规划。同一部分的扩建、材质调整和细节修整沿用原有规划。

1. 先调用 `world_map_info` 和 `planning_state` 查看全图。用 `inspect_plan` 核对已有规划的几何、图层和用途，确认后沿用其 ID，或用 `save_plan` 新建有明确名称的规划。
2. 用 `create_draft` 传入对应的 `plan_id`。需要横跨多个规划的施工，按各部分归属分别创建和导出方案。提交前核对导出方案中的规划 ID、世界 UUID 和草稿修订。
3. 施工后核对实际写入回执。逐项检查隐藏规划时对应建筑从视图消失、显示时恢复，并将显隐状态还原为检查前的设置。重叠位置按已核对的施工记录显示仍可见的方块。显隐只改变工坊视图，存档保持原样。

工作台使用可读的已提交回执确定方块归属。同机施工时，直接使用本工程导出的方案文件提交。跨主机施工时，保留目标服的写入记录，并确认工作台能够读取对应记录后验收显隐。

### 首次写入、撤销与重做

1. 在织境工坊打开草稿的差异预览，确认改动后点「导出方案」。也可用 `map_workbench.export_draft` 传入 `draft_id`，从返回结果中取 `path`。
2. 用 `world_writer.apply_exported_design` 传入 `export_path`。记录返回的 `operation_id`。确认 `complete` 为 `true`、`conflict_count` 为 `0`，并核对 `changed` 和 `already`。有冲突时查看坐标；同一方案可能已经成功写入其他坐标。
3. 用 `world_writer.world_write_status` 查询操作。遇到超时或部分批次完成时，先查历史和回执，再用同一份导出文件和原 `operation_id` 重试。调用超时且尚未拿到 ID 时，可先通过 `list_world_writes` 找到记录。保留导出文件、`writer-state` 和插件回执，便于恢复。
4. 对 `undoable` 为 `true` 的施工，用 `world_writer.undo_world_write` 和原始写入的 `operation_id` 撤销。重做使用 `world_writer.redo_world_write` 及同一个原始写入 ID。插件会保留施工后由其他操作改过的方块；将冲突坐标留给人工核对。

## 开发与构建

在开发包根目录运行 `npm ci`。前端用 Vite 构建，桌面使用 Tauri 2 和 Rust。Rust 使用 1.89 或更新版本。

| 操作 | 命令 |
| --- | --- |
| 前端开发服务 | `npm run dev` |
| 桌面开发窗口 | `npm run tauri -- dev` |
| 单元测试 | `npm test` |
| Windows 构建 | `npm run build`，然后 `npm run build:desktop` |
| macOS 本机构建 | `npm run build:mac` |
| 重新生成图标 | 安装 Python 3 和 Pillow 后执行 `npm run build:icons` |
| Windows 发行包 | 首先生成 release 版 `native-build/release/terraweave.exe`，再用 `python tools/release-windows.py <Node 24.15.0 win-x64 ZIP> <微软 WebView2 Bootstrapper EXE> --archive` 生成便携包和安装器配置 |

Windows 开发构建需要 Visual Studio C++ 工具和 Windows SDK。macOS 开发构建需要 Xcode 命令行工具，本机构建产物位于 `bin/织境工坊.app`。程序通过祖先目录定位 `tools` 与 `assets`，移动程序时保留开发包目录结构。外部 Node 路径可通过 `TERRAWEAVE_NODE` 指定。原版光影 ZIP 的原生 OpenGL 后端支持 Windows。

## 目录与扩展点

| 路径 | 用途 |
| --- | --- |
| index.html、workspace-ui.js、creative-main.js | 桌面界面、命令、地图与三维视图 |
| appearance.js、appearance.css | 主题预设、导入校验、语义颜色与外观设置 |
| viewport-look.js | 画布右键相对移动和指针恢复 |
| src-tauri/src | 原生命令、窗口、剪贴板、离线光影 |
| src-tauri/icons | 透明底山体河流母图、Windows ICO、macOS ICNS 和窗口 PNG |
| tools | 离线存档服务、MCP、构建与测试 |
| assets/minecraft | 预览所需的基础方块模型与纹理 |
| assets/resourcepacks、assets/shaderpacks | 用户添加的材质与光影 |
| server-plugin | 配套写入插件源码 |

## 主题格式

在「视图 → 外观与主题」选择预设、设置界面字号和文字颜色，或展开「面板与控件颜色」调整配色。设置可即时预览，点击保存后同步到同一用户的工程窗口。导出的 JSON 可用于备份或分享主题。

```json
{
  "version": 2,
  "fontSize": 14,
  "preset": "atlas",
  "colors": {
    "background": "#16181d", "chrome": "#1b1e24", "panel": "#23262d",
    "field": "#2b2f38", "text": "#e2e4ea", "muted": "#b0b5c2", "heading": "#f4f5f8",
    "accent": "#aab9fa", "selected": "#363e56", "line": "#424751"
  }
}
```

预设标识支持 `atlas`、`graphite`、`midnight`、`paper`。颜色使用六位十六进制值，字号支持 12–18 的整数。导入旧版主题时会迁移自定义颜色并移除背景图片数据。

