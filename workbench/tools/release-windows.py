"""Stage the Windows x64 release without copying local worlds or game files."""
import argparse
from hashlib import sha256
import json
import os
from pathlib import Path
import shutil
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(__file__).resolve().parents[1]
version = json.loads((root / "package.json").read_text(encoding="utf-8"))["version"]
node_version = "24.15.0"
node_digest = "cc5149eabd53779ce1e7bdc5401643622d0c7e6800ade18928a767e940bb0e62"
parser = argparse.ArgumentParser()
parser.add_argument("node_zip", type=Path, help=f"Official node-v{node_version}-win-x64.zip")
parser.add_argument("webview_bootstrapper", type=Path, help="Microsoft-signed Evergreen Bootstrapper")
parser.add_argument("--archive", action="store_true")
args = parser.parse_args()
if sha256(args.node_zip.read_bytes()).hexdigest() != node_digest:
    raise SystemExit("Node.js archive checksum mismatch.")

stage = root / "packages" / "windows-runtime"
(stage / "assets").mkdir(parents=True, exist_ok=True)
config = stage / "assets" / "render-settings.json"
config.write_text('{"pack_order":[],"shader":"off","roots":[]}', encoding="utf-8")
shutil.copyfile(root / "assets/block-states-1.20.1.json", stage / "assets/block-states-1.20.1.json")
for source in (root / "tools").glob("*.mjs"):
    if source.name.endswith((".test.mjs", "-qa.mjs")) or source.name.startswith(("verify-", "test-")):
        continue
    target = stage / "tools" / source.name
    target.parent.mkdir(exist_ok=True)
    shutil.copyfile(source, target)
for name in ("snapshot-delta.js", "minecraft-version.js", "package.json", "SDK.md"):
    shutil.copyfile(root / name, stage / name)
(stage / "runtime").mkdir(exist_ok=True)
shutil.copyfile(args.webview_bootstrapper, stage / "runtime/MicrosoftEdgeWebview2Setup.exe")
with ZipFile(args.node_zip) as node:
    for name in ("node.exe", "LICENSE"):
        dest = "NODE-LICENSE.txt" if name == "LICENSE" else name
        (stage / "runtime" / dest).write_bytes(node.read(f"node-v{node_version}-win-x64/{name}"))
payload = [config, stage / "assets/block-states-1.20.1.json", stage / "snapshot-delta.js", stage / "minecraft-version.js", stage / "package.json",
           stage / "SDK.md", stage / "runtime/node.exe", stage / "runtime/NODE-LICENSE.txt",
           stage / "runtime/MicrosoftEdgeWebview2Setup.exe"]
payload.extend(stage / "tools" / file.name for file in (root / "tools").glob("*.mjs")
               if not file.name.endswith((".test.mjs", "-qa.mjs")) and not file.name.startswith(("verify-", "test-")))
resources = {Path(os.path.relpath(file, root / "src-tauri")).as_posix():file.relative_to(stage).as_posix()
             for file in payload}
installer_config = {
    "mainBinaryName": "织境工坊",
    "bundle": {
        "active": True,
        "targets": ["nsis"],
        "resources": resources,
        "windows": {"nsis": {
            "installMode": "currentUser",
            "languages": ["English", "SimpChinese"],
            "displayLanguageSelector": True,
            "installerIcon": "icons/icon.ico"
        }}
    }
}
(stage.parent / "installer.json").write_text(json.dumps(installer_config, ensure_ascii=False, indent=2), encoding="utf-8")
if args.archive:
    binary = root / "native-build/release/terraweave.exe"
    output = stage.parent / f"TerraWeave-{version}-windows-x64-portable.zip"
    pending = output.with_suffix(".partial")
    with ZipFile(pending, "w", ZIP_DEFLATED, compresslevel=5) as archive:
        archive.write(binary, "织境工坊.exe")
        for file in sorted(payload):
            archive.write(file, file.relative_to(stage).as_posix())
        for name in ("package-lock.json", "index.html", "server-plugin/WorkbenchLive.java", "server-plugin/PaperBlockEntityCodec.java", "server-plugin/plugin.yml"):
            archive.write(root / name, name)
        for pattern in ("*.css","*.js","src-tauri/*.*","src-tauri/src/*.rs","src-tauri/icons/*","src-tauri/capabilities/*.json","public/*","tools/*"):
            for file in root.glob(pattern):
                if file.is_file():
                    name = file.relative_to(root).as_posix()
                    if name not in archive.NameToInfo:
                        archive.write(file, name)
    with ZipFile(pending) as archive:
        if archive.testzip():
            raise RuntimeError("Portable archive CRC check failed")
    pending.replace(output)
    print(output)

