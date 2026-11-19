use std::{os::windows::process::CommandExt, path::Path, process::Command};

const NO_WINDOW: u32 = 0x08000000;
const CLIENT_KEY: &str = r"Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";

fn has_webview() -> bool {
    [
        format!(r"HKLM\SOFTWARE\WOW6432Node\{CLIENT_KEY}"),
        format!(r"HKCU\SOFTWARE\{CLIENT_KEY}"),
    ]
    .iter()
    .any(|key| {
        Command::new("reg.exe")
            .args(["query", key, "/v", "pv", "/reg:64"])
            .creation_flags(NO_WINDOW)
            .output()
            .is_ok_and(|result| {
                result.status.success() && String::from_utf8_lossy(&result.stdout)
                    .lines().filter_map(|line| line.trim().strip_prefix("pv"))
                    .filter_map(|line| line.split_whitespace().last())
                    .any(|version| version.split('.').any(|part| part.parse::<u32>().is_ok_and(|n| n > 0)))
            })
    })
}

pub fn ensure_webview(project: &Path) -> Result<(), String> {
    if has_webview() {
        return Ok(());
    }
    let bootstrapper = project.join("runtime/MicrosoftEdgeWebview2Setup.exe");
    if bootstrapper.is_file() {
        Command::new(bootstrapper)
            .args(["/silent", "/install"])
            .creation_flags(NO_WINDOW)
            .status()
            .map_err(|err| format!("无法启动 WebView2 安装程序：{err}"))?;
        if has_webview() {
            return Ok(());
        }
    }
    Err("无法安装 Microsoft Edge WebView2。请检查网络后重新打开织境工坊。".into())
}

pub fn show_error(message: &str) {
    #[link(name = "user32")]
    unsafe extern "system" {
        fn MessageBoxW(window: isize, text: *const u16, title: *const u16, flags: u32) -> i32;
    }
    let title: Vec<u16> = "织境工坊".encode_utf16().chain([0]).collect();
    let text: Vec<u16> = message.encode_utf16().chain([0]).collect();
    unsafe { MessageBoxW(0, text.as_ptr(), title.as_ptr(), 0x10); }
}

