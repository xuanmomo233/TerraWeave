#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod workbench;
mod ui_worker;
mod clipboard;
#[cfg(windows)] mod windows_dependencies;
#[cfg(windows)] mod iris_context;
#[cfg(windows)] mod iris_pack;
#[cfg(windows)] mod iris_mesh;
#[cfg(windows)] mod iris_pipeline;
#[cfg(windows)] mod iris_native;
#[cfg(not(windows))] mod iris_native {
 use serde_json::Value;
 const MESSAGE:&str="此平台尚未提供原版光影的 OpenGL 后端";
 #[tauri::command] pub async fn iris_check_pack(pack:Value)->Result<Value,String>{drop(pack);Err(MESSAGE.into())}
 #[tauri::command] pub async fn iris_prepare(pack:Value,scene:Value)->Result<Value,String>{drop((pack,scene));Err(MESSAGE.into())}
 #[tauri::command] pub async fn iris_draw(frame:Value)->Result<Value,String>{drop(frame);Err(MESSAGE.into())}
 #[tauri::command] pub async fn iris_report()->Result<Value,String>{Err(MESSAGE.into())}
}
use base64::{engine::general_purpose::STANDARD,Engine};
use std::{fs,path::Path};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

fn bounded(root:&Path,name:&str,max:u64)->Result<Vec<u8>,String>{
 if name.is_empty()||name.contains("..")||name.contains('\\')||name.starts_with('/')||name.contains(':'){return Err("Invalid asset path".into())}
 let root=root.canonicalize().map_err(|e|e.to_string())?;let file=root.join(name).canonicalize().map_err(|e|e.to_string())?;
 if !file.starts_with(&root)||!file.is_file()||fs::metadata(&file).map_err(|e|e.to_string())?.len()>max{return Err("Invalid local asset".into())}
 fs::read(file).map_err(|e|e.to_string())
}
#[tauri::command]
fn read_asset(name:String,minecraft:Option<String>)->Result<String,String>{
 let allowed=((name.starts_with("minecraft/models/")||name.starts_with("minecraft/blockstates/"))&&name.ends_with(".json"))||(name.starts_with("minecraft/textures/")&&name.ends_with(".png"));
 if !allowed{return Err("Unsupported asset type".into())}
 let assets=workbench::project().join("assets");
 let settings=fs::read(assets.join("render-settings.json")).ok().and_then(|data|serde_json::from_slice::<serde_json::Value>(&data).ok());
 let overlay=if let Some(roots)=settings.as_ref().and_then(|s|s["roots"].as_array()){
  roots.iter().rev().filter_map(|r|r.as_str()).find_map(|r|{
   if !(r.starts_with("resourcepacks/")||r.starts_with("render-pack-cache/")){return None;}
   let root=assets.join(r).canonicalize().ok()?;
   if !root.starts_with(assets.canonicalize().ok()?){return None;}
   bounded(&root,&name,2_000_000).ok()
  })
 }else if name.starts_with("minecraft/textures/block/"){
  bounded(&assets.join("liuyun-textures"),&name,2_000_000).ok()
 }else{None};
 let version=minecraft.as_deref().unwrap_or("1.20.1");
 if version.len()>12||!matches!(version.split('.').count(),2|3)
  ||!version.split('.').all(|n|!n.is_empty()&&n.bytes().all(|b|b.is_ascii_digit())){
  return Err("Invalid Minecraft version".into());
 }
 let vanilla=if version=="1.20.1"{assets}else{assets.join("vanilla").join(version)};
 let bytes=match overlay{Some(bytes)=>bytes,None=>bounded(&vanilla,&name,2_000_000)
  .or_else(|error|if name=="minecraft/textures/entity/banner_base.png" {
      bounded(&vanilla,"minecraft/textures/entity/banner/banner_base.png",2_000_000)
  }else{Err(error)})?};
 if name.ends_with(".png"){Ok(format!("data:image/png;base64,{}",STANDARD.encode(bytes)))}else{String::from_utf8(bytes).map_err(|e|e.to_string())}
}
#[tauri::command]
fn open_pack_folder(kind:&str)->Result<(),String>{
 let folder=match kind{
  "resourcepacks"=>"resourcepacks",
  "shaderpacks"=>"shaderpacks",
  _=>return Err("未知的渲染资源目录".into()),
 };
 let directory=workbench::project().join("assets").join(folder);
 fs::create_dir_all(&directory).map_err(|e|format!("无法准备目录：{e}"))?;
 open_local_directory(&directory)
}
fn open_local_directory(directory:&Path)->Result<(),String>{
 if !directory.is_dir(){return Err("目录不存在或不可访问".into())}
 #[cfg(target_os="windows")]
 let program="explorer.exe";
 #[cfg(target_os="macos")]
 let program="open";
 #[cfg(not(any(target_os="windows",target_os="macos")))]
 let program="xdg-open";
 std::process::Command::new(program).arg(directory).spawn()
  .map(|_|()).map_err(|e|format!("无法打开目录：{e}"))
}
#[tauri::command]
async fn open_project_folder(id:String,kind:String)->Result<(),String>{
 let details=workbench::workbench_call("project_locations".into(),serde_json::json!({"id":id})).await?;
 let directory=match kind.as_str(){
  "project"=>details["project_directory"].as_str(),
  "save" if details["error"].is_null()=>details["directory"].as_str(),
  "save"=>return Err("存档目录不可读取，请重新关联存档".into()),
  _=>return Err("未知的工程目录类型".into()),
 }.ok_or("当前工程没有对应的目录")?;
 open_local_directory(Path::new(directory))
}
#[tauri::command]
fn center_view_cursor(window:tauri::Window,x:i32,y:i32)->Result<(),String>{
 if !window.is_focused().map_err(|e|e.to_string())? {return Ok(())}
 let size=window.inner_size().map_err(|e|e.to_string())?;
 if x>=0 && y>=0 && (x as u32)<size.width && (y as u32)<size.height {
  window.set_cursor_position(tauri::PhysicalPosition::new(x,y)).map_err(|e|e.to_string())?;
 }
 Ok(())
}
#[tauri::command]
async fn pick_world_directory(window: tauri::Window, initial_path: String, title: Option<String>) -> Result<Option<String>, String> {
 let title=title.unwrap_or_else(||"选择 Minecraft 世界存档目录".into());
 let dialog = window.dialog().file().set_title(title).set_parent(&window);
 let path = Path::new(initial_path.trim());
 let dialog = if path.is_absolute() && path.is_dir() { dialog.set_directory(path) } else { dialog };
 let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_folder())
  .await.map_err(|error|error.to_string())?;
 picked.map(|entry|entry.into_path().map_err(|error|error.to_string()).and_then(|path|
  path.into_os_string().into_string().map_err(|_|"该目录路径无法转换为文本".to_string()))).transpose()
}
fn main(){
 if std::env::args_os().any(|arg|arg=="--installation-path"){
  println!("{}",workbench::project().display());
  return;
 }
 let _instance=match workbench::claim_instance(){Ok(file)=>file,Err(_)=>{workbench::show_existing();return;}};
 #[cfg(windows)]
 if let Err(message)=windows_dependencies::ensure_webview(&workbench::project()){
  windows_dependencies::show_error(&message);
  return;
 }
 workbench::recover_requests().expect("Recover pending desktop requests");
 let mut context=tauri::generate_context!();
 if std::env::var("MAP_WORKBENCH_TEST_HIDDEN").as_deref()==Ok("1"){for window in &mut context.config_mut().app.windows{window.visible=false;}}
 tauri::Builder::default().plugin(tauri_plugin_dialog::init()).setup(|app|{
  if let Some(window)=app.get_webview_window("main"){workbench::monitor_window(window);}
  Ok(())
 }).invoke_handler(tauri::generate_handler![pick_world_directory,center_view_cursor,iris_native::iris_check_pack,iris_native::iris_prepare,iris_native::iris_draw,iris_native::iris_report,read_asset,open_pack_folder,open_project_folder,clipboard::workbench_clipboard,workbench::workbench_heartbeat,workbench::workbench_poll,workbench::workbench_complete,workbench::workbench_call,workbench::workbench_show,workbench::workbench_read_image,workbench::workbench_window_action]).run(context).expect("TerraWeave startup failed");
}
#[cfg(test)]mod tests{
 use super::*;
 #[test]fn assets_remain_local(){assert!(bounded(Path::new("."),"../secret",10).is_err());assert!(read_asset("minecraft/../../secret.png".into(),None).is_err());assert!(read_asset("minecraft/textures/block/stone.png".into(),Some("..".into())).is_err());}
}
