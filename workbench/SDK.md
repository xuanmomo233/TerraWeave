# TerraWeave 桌面开发包

将整个 ZIP 解压至可写目录，双击第一层的「织境工坊.exe」。便携开发包与安装版均内置 Node.js，缺少 WebView2 时通过微软官方安装程序补齐。安装版支持 English、简体中文和自选安装目录。

在「文件 → 世界存档来源」选择含 `level.dat` 和 `region` 的已有 Java 版存档。首次进入三维会从本机 1.20.1 安装或 Mojang 获取原版预览所需的模型和纹理。规划和预览写入本地 `project-state/workbench`，可用 `TERRAWEAVE_STATE` 指定独立工程目录。

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

