#[cfg(windows)]mod windows{
 use std::ffi::c_void;
 #[link(name="user32")]extern "system"{fn OpenClipboard(window:*mut c_void)->i32;fn CloseClipboard()->i32;fn EmptyClipboard()->i32;fn GetClipboardData(format:u32)->*mut c_void;fn SetClipboardData(format:u32,memory:*mut c_void)->*mut c_void;}
 #[link(name="kernel32")]extern "system"{fn GlobalAlloc(flags:u32,bytes:usize)->*mut c_void;fn GlobalLock(memory:*mut c_void)->*mut c_void;fn GlobalUnlock(memory:*mut c_void)->i32;fn GlobalFree(memory:*mut c_void)->*mut c_void;fn GlobalSize(memory:*mut c_void)->usize;}
 struct Clipboard;impl Drop for Clipboard{fn drop(&mut self){unsafe{CloseClipboard();}}}
 struct Memory(*mut c_void);impl Drop for Memory{fn drop(&mut self){if !self.0.is_null(){unsafe{GlobalFree(self.0);}}}}
 pub fn text(window:*mut c_void,value:Option<String>)->Result<String,String>{unsafe{
  if OpenClipboard(window)==0{return Err("剪贴板正被其他程序使用，请重试".into())}let _clipboard=Clipboard;
  if let Some(value)=value{let data=value.encode_utf16().chain(std::iter::once(0)).collect::<Vec<_>>();if data.len()>1_000_000{return Err("剪贴板文本过长".into())}let mut memory=Memory(GlobalAlloc(2,data.len()*2));if memory.0.is_null(){return Err("无法分配剪贴板内存".into())}let target=GlobalLock(memory.0) as *mut u16;if target.is_null(){return Err("无法访问剪贴板内存".into())}std::ptr::copy_nonoverlapping(data.as_ptr(),target,data.len());GlobalUnlock(memory.0);if EmptyClipboard()==0||SetClipboardData(13,memory.0).is_null(){return Err("无法写入剪贴板".into())}memory.0=std::ptr::null_mut();return Ok(String::new())}
  let handle=GetClipboardData(13);if handle.is_null(){return Ok(String::new())}let len=GlobalSize(handle)/2;if len>1_000_000{return Err("剪贴板文本过长".into())}let pointer=GlobalLock(handle) as *const u16;if pointer.is_null(){return Err("无法读取剪贴板文本".into())}let data=std::slice::from_raw_parts(pointer,len);let end=data.iter().position(|n|*n==0).unwrap_or(len);let text=String::from_utf16_lossy(&data[..end]);GlobalUnlock(handle);Ok(text)
 }}
}
#[tauri::command]
pub fn workbench_clipboard(window:tauri::Window,text:Option<String>)->Result<String,String>{
 #[cfg(windows)]{return windows::text(window.hwnd().map_err(|e|e.to_string())?.0 as *mut std::ffi::c_void,text)}
 #[cfg(not(windows))]{let _=(window,text);Err("当前平台不支持此剪贴板操作".into())}
}
