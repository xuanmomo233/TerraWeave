use serde::Serialize;

#[derive(Debug, Default, Serialize)]
pub struct RenderCapacity {
    system_total_mib: Option<u64>,
    system_available_mib: Option<u64>,
    // Physical discrete VRAM. The WebView GPU process has its own allocations and budget.
    dedicated_mib: Option<u64>,
    unified: Option<bool>,
}

#[tauri::command]
pub async fn render_capacity(renderer: Option<String>) -> RenderCapacity {
    platform_capacity(renderer.as_deref())
}

#[cfg(any(windows, test))]
fn select_adapter(names: &[String], renderer: Option<&str>) -> Option<usize> {
    let Some(renderer) = renderer.filter(|name| !name.is_empty()) else {
        return (names.len() == 1).then_some(0);
    };
    let renderer = renderer.to_ascii_lowercase();
    let mut matches = names
        .iter()
        .enumerate()
        .filter(|(_, name)| !name.is_empty() && renderer.contains(&name.to_ascii_lowercase()));
    let (index, _) = matches.next()?;
    matches.next().is_none().then_some(index)
}

#[cfg(any(windows, test))]
fn adapter_memory(
    integrated: Option<bool>,
    local_bytes: Option<u64>,
) -> (Option<u64>, Option<bool>) {
    match (integrated, local_bytes) {
        // Firmware reservations do not change the memory architecture of an integrated adapter.
        (Some(true), _) => (None, Some(true)),
        (Some(false), Some(bytes)) if bytes > 0 => (Some(bytes >> 20), Some(false)),
        _ => (None, None),
    }
}

#[cfg(windows)]
fn platform_capacity(renderer: Option<&str>) -> RenderCapacity {
    use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    let mut result = RenderCapacity::default();
    let mut memory = MEMORYSTATUSEX {
        dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
        ..Default::default()
    };
    if unsafe { GlobalMemoryStatusEx(&mut memory) }.is_ok() {
        result.system_total_mib = Some(memory.ullTotalPhys >> 20);
        result.system_available_mib = Some(memory.ullAvailPhys >> 20);
    }
    if let Some((dedicated, unified)) = windows_adapter(renderer) {
        result.dedicated_mib = dedicated;
        result.unified = unified;
    }
    result
}

#[cfg(windows)]
fn windows_adapter(renderer: Option<&str>) -> Option<(Option<u64>, Option<bool>)> {
    use std::ffi::c_void;
    use windows::{
        core::{s, w, Interface, Owned, GUID, HRESULT},
        Win32::{
            Graphics::DXCore::*,
            System::LibraryLoader::{GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_SYSTEM32},
        },
    };
    type CreateFactory = unsafe extern "system" fn(*const GUID, *mut *mut c_void) -> HRESULT;
    fn flag(adapter: &IDXCoreAdapter, property: DXCoreAdapterProperty) -> Option<bool> {
        let mut value = 0u8;
        unsafe { adapter.GetProperty(property, 1, (&mut value as *mut u8).cast()) }.ok()?;
        Some(value != 0)
    }
    unsafe {
        // Optional on older Windows. Keep the system DLL loaded until every COM interface drops.
        let library =
            Owned::new(LoadLibraryExW(w!("dxcore.dll"), None, LOAD_LIBRARY_SEARCH_SYSTEM32).ok()?);
        let address = GetProcAddress(*library, s!("DXCoreCreateAdapterFactory"))?;
        let create: CreateFactory = std::mem::transmute(address);
        let mut raw = std::ptr::null_mut();
        create(&IDXCoreAdapterFactory::IID, &mut raw).ok().ok()?;
        let factory = IDXCoreAdapterFactory::from_raw(raw);
        let list: IDXCoreAdapterList = factory
            .CreateAdapterList(&[DXCORE_ADAPTER_ATTRIBUTE_D3D11_GRAPHICS])
            .ok()?;
        let mut adapters = Vec::new();
        let mut names = Vec::new();
        for index in 0..list.GetAdapterCount() {
            let adapter: IDXCoreAdapter = list.GetAdapter(index).ok()?;
            if !flag(&adapter, IsHardware)? {
                continue;
            }
            let size = adapter.GetPropertySize(DriverDescription).ok()?;
            if !(1..=4096).contains(&size) {
                return None;
            }
            let mut name = vec![0u8; size];
            adapter
                .GetProperty(DriverDescription, size, name.as_mut_ptr().cast())
                .ok()?;
            names.push(
                String::from_utf8(name)
                    .ok()?
                    .trim_end_matches('\0')
                    .to_owned(),
            );
            adapters.push(adapter);
        }
        let adapter = &adapters[select_adapter(&names, renderer)?];
        let mut bytes = 0u64;
        let local_bytes = adapter
            .GetProperty(
                DedicatedAdapterMemory,
                std::mem::size_of::<u64>(),
                (&mut bytes as *mut u64).cast(),
            )
            .ok()
            .map(|_| bytes);
        #[cfg(test)]
        eprintln!(
            "DXCore {names:?}, IsIntegrated={:?}, DedicatedAdapterMemory={local_bytes:?}",
            flag(adapter, IsIntegrated)
        );
        Some(adapter_memory(flag(adapter, IsIntegrated), local_bytes))
    }
}

#[cfg(target_os = "linux")]
fn platform_capacity(_: Option<&str>) -> RenderCapacity {
    let info = std::fs::read_to_string("/proc/meminfo").unwrap_or_default();
    let mib = |label| -> Option<u64> {
        info.lines()
            .find_map(|line| line.strip_prefix(label))?
            .split_whitespace()
            .next()?
            .parse::<u64>()
            .ok()
            .map(|kib| kib / 1024)
    };
    RenderCapacity {
        system_total_mib: mib("MemTotal:"),
        system_available_mib: mib("MemAvailable:"),
        ..Default::default()
    }
}

#[cfg(target_os = "macos")]
fn platform_capacity(_: Option<&str>) -> RenderCapacity {
    unsafe extern "C" {
        fn sysctlbyname(
            name: *const std::ffi::c_char,
            old: *mut std::ffi::c_void,
            len: *mut usize,
            new: *mut std::ffi::c_void,
            new_len: usize,
        ) -> std::ffi::c_int;
    }
    let mut bytes = 0u64;
    let mut len = std::mem::size_of::<u64>();
    let status = unsafe {
        sysctlbyname(
            c"hw.memsize".as_ptr(),
            (&mut bytes as *mut u64).cast(),
            &mut len,
            std::ptr::null_mut(),
            0,
        )
    };
    RenderCapacity {
        system_total_mib: (status == 0 && len == 8).then_some(bytes >> 20),
        ..Default::default()
    }
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn platform_capacity(_: Option<&str>) -> RenderCapacity {
    RenderCapacity::default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integrated_reservations_never_count_as_discrete_memory() {
        assert_eq!(
            adapter_memory(Some(true), Some(512 << 20)),
            (None, Some(true))
        );
        assert_eq!(adapter_memory(Some(true), Some(0)), (None, Some(true)));
        assert_eq!(adapter_memory(None, Some(8192 << 20)), (None, None));
        assert_eq!(
            adapter_memory(Some(false), Some(8192 << 20)),
            (Some(8192), Some(false))
        );
    }

    #[test]
    fn hybrid_system_requires_a_unique_renderer_match() {
        let names = vec!["Intel Graphics".into(), "ACME Model 8".into()];
        assert_eq!(select_adapter(&names, None), None);
        assert_eq!(
            select_adapter(&names, Some("ANGLE (ACME Model 8 Direct3D11)")),
            Some(1)
        );
        assert_eq!(select_adapter(&names, Some("ANGLE (SwiftShader)")), None);
        assert_eq!(
            select_adapter(&["GPU".into(), "GPU".into()], Some("GPU")),
            None
        );
        assert_eq!(select_adapter(&["GPU".into()], None), Some(0));
    }

    #[test]
    #[cfg(windows)]
    fn reads_host_capacity_without_a_window() {
        let renderer = std::env::var("TERRAWEAVE_TEST_RENDERER").ok();
        let info = platform_capacity(renderer.as_deref());
        println!("{info:?}");
        assert!(info.system_total_mib.is_some_and(|total| total > 0));
        assert!(info
            .system_available_mib
            .is_some_and(|available| Some(available) <= info.system_total_mib));
    }
}
