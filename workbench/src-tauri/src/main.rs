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

fn bounded(root:&Path,name:&str,max:u64)->Result<Vec<u8>,String>{
 if name.is_empty()||name.contains("..")||name.contains('\\')||name.starts_with('/')||name.contains(':'){return Err("Invalid asset path".into())}
 let root=root.canonicalize().map_err(|e|e.to_string())?;let file=root.join(name).canonicalize().map_err(|e|e.to_string())?;
 if !file.starts_with(&root)||!file.is_file()||fs::metadata(&file).map_err(|e|e.to_string())?.len()>max{return Err("Invalid local asset".into())}
 fs::read(file).map_err(|e|e.to_string())
}
#[tauri::command]
fn read_asset(name:String)->Result<String,String>{
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
 let bytes=match overlay{Some(bytes)=>bytes,None=>bounded(&assets,&name,2_000_000)?};
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
 std::process::Command::new(if cfg!(target_os="macos") {"open"} else {"explorer.exe"}).arg(directory).spawn()
  .map(|_|()).map_err(|e|format!("无法打开目录：{e}"))
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
 tauri::Builder::default().invoke_handler(tauri::generate_handler![center_view_cursor,iris_native::iris_check_pack,iris_native::iris_prepare,iris_native::iris_draw,iris_native::iris_report,read_asset,open_pack_folder,clipboard::workbench_clipboard,workbench::workbench_heartbeat,workbench::workbench_poll,workbench::workbench_complete,workbench::workbench_call,workbench::workbench_show,workbench::workbench_read_image,workbench::workbench_window_action]).run(context).expect("TerraWeave startup failed");
}
#[cfg(test)]mod tests{
 use super::*;
 #[test]fn assets_remain_local(){assert!(bounded(Path::new("."),"../secret",10).is_err());assert!(read_asset("minecraft/../../secret.png".into()).is_err());}
}
