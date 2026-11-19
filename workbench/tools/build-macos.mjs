import {spawnSync} from 'node:child_process';
import {cpSync, mkdirSync} from 'node:fs';
import path from 'node:path';
import {PROJECT} from './workspace-paths.mjs';

if (process.platform !== 'darwin') throw Error('请在安装了 Xcode 命令行工具的 macOS 上构建');
const target = path.join(PROJECT,'native-build');
const result = spawnSync(path.join(PROJECT,'node_modules/.bin/tauri'),['build','--bundles','app'],{
 cwd:PROJECT,stdio:'inherit',env:{...process.env,CARGO_TARGET_DIR:target}
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
mkdirSync(path.join(PROJECT,'bin'),{recursive:true});
cpSync(path.join(target,'release/bundle/macos/织境工坊.app'),path.join(PROJECT,'bin/织境工坊.app'),{recursive:true});

