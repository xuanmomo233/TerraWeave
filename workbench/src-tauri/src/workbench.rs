use base64::{engine::general_purpose::STANDARD,Engine};
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use std::{fs,io::Write,path::{Path,PathBuf},process::{Command,Stdio},sync::atomic::{AtomicU64,Ordering},time::{SystemTime,UNIX_EPOCH}};
pub fn project()->PathBuf{
 static DIRECTORY:std::sync::OnceLock<PathBuf>=std::sync::OnceLock::new();
 DIRECTORY.get_or_init(||{
  let exe=std::env::current_exe().expect("Locate TerraWeave executable");
  exe.ancestors().flat_map(|p|[p.to_path_buf(),p.join("workbench")])
   .find(|p|p.join("tools/creative-workbench.mjs").is_file()&&p.join("assets").is_dir())
   .expect("在程序旁找不到织境工坊的 tools 与 assets 目录")
 }).clone()
}
pub fn node_program()->std::ffi::OsString {
 if let Some(node)=std::env::var_os("TERRAWEAVE_NODE"){return node}
 #[cfg(target_os="macos")]
 for path in ["/opt/homebrew/bin/node","/usr/local/bin/node"] {
  if Path::new(path).is_file(){return path.into()}
 }
 #[cfg(windows)] {
  let bundled=project().join("runtime/node.exe");
  if bundled.is_file(){return bundled.into_os_string()}
 }
 if cfg!(windows) {"node.exe".into()} else {"node".into()}
}
fn root()->PathBuf{
 let project=project();
 std::env::var_os("TERRAWEAVE_STATE").map(|p|project.join(p)).unwrap_or_else(||project.join("project-state/workbench"))
}
fn ms()->u128{SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis()}
static WRITES:AtomicU64=AtomicU64::new(0);
static LAST_HEARTBEAT:AtomicU64=AtomicU64::new(0);
fn valid(id:&str)->bool{!id.is_empty()&&id.len()<100&&id.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-')}
fn write(path:&Path,value:&Value)->Result<(),String>{
 let pending=path.with_extension(format!("pending-{}-{}",std::process::id(),WRITES.fetch_add(1,Ordering::Relaxed)));
 fs::write(&pending,serde_json::to_vec(value).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
 fs::rename(pending,path).map_err(|e|e.to_string())
}
pub fn claim_instance()->Result<fs::File,String>{
 fs::create_dir_all(root()).map_err(|e|e.to_string())?;
 let mut options=fs::OpenOptions::new();options.write(true).create(true);
 #[cfg(windows)]{use std::os::windows::fs::OpenOptionsExt;options.share_mode(0);}
 let file=options.open(root().join("desktop.instance.lock")).map_err(|e|e.to_string())?;
 #[cfg(unix)] file.try_lock().map_err(|e|e.to_string())?;
 Ok(file)
}
pub fn show_existing(){
 let id=format!("{}-{}",ms(),std::process::id());let _=fs::create_dir_all(root().join("requests"));
 let _=write(&root().join("requests").join(format!("{id}.json")),&json!({"id":id,"kind":"show","reply":false,"expires_at_ms":ms()+10000}));
}
#[tauri::command]
pub fn workbench_heartbeat()->Result<(),String>{let now=ms() as u64;if now.saturating_sub(LAST_HEARTBEAT.load(Ordering::Relaxed))<1000{return Ok(())}LAST_HEARTBEAT.store(now,Ordering::Relaxed);write(&root().join("heartbeat.json"),&json!({"pid":std::process::id(),"at_ms":now.to_string(),"version":2}))}
fn read(path:&Path,max:u64)->Result<Value,String>{
 if fs::metadata(path).map_err(|e|e.to_string())?.len()>max{return Err("Workbench data exceeds limit".into())}
 serde_json::from_slice(&fs::read(path).map_err(|e|e.to_string())?).map_err(|e|e.to_string())
}
#[tauri::command]
pub async fn workbench_poll()->Result<Value,String>{
 tauri::async_runtime::spawn_blocking(poll_workbench).await.map_err(|e|e.to_string())?
}
fn queue_dirs(r:&Path)->Result<(),String>{
 for name in ["requests","processing","responses","snapshots","regions","captures"]{
  fs::create_dir_all(r.join(name)).map_err(|e|e.to_string())?;
 }
 Ok(())
}
fn reply(r:&Path,id:&str,result:&Value)->Result<(),String>{
 write(&r.join("responses").join(format!("{id}.json")),result)
}
pub fn recover_requests()->Result<(),String>{
 let r=root();
 queue_dirs(&r)?;
 for entry in fs::read_dir(r.join("processing")).map_err(|e|e.to_string())?.filter_map(Result::ok){
  let name=entry.file_name();
  let Some(id)=name.to_str().and_then(|s|s.strip_suffix(".json")).filter(|s|valid(s)) else{continue};
  let output=r.join("responses").join(format!("{id}.json"));
  if !output.exists(){reply(&r,id,&json!({"ok":false,"error":"工作台已重启，该请求已中断"}))?;}
  fs::remove_file(entry.path()).map_err(|e|e.to_string())?;
 }
 let cutoff=ms().saturating_sub(900_000);
 for entry in fs::read_dir(r.join("responses")).map_err(|e|e.to_string())?.filter_map(Result::ok){
  let stamp=entry.metadata().ok().and_then(|m|m.modified().ok())
   .and_then(|t|t.duration_since(UNIX_EPOCH).ok()).map(|d|d.as_millis());
  if stamp.is_some_and(|time|time<cutoff){let _=fs::remove_file(entry.path());}
 }
 Ok(())
}
fn load_claim(r:&Path,file:&Path,id:&str)->Result<Value,String>{
 let mut q=read(file,65536)?;
 if q["id"].as_str()!=Some(id){return Err("Invalid request identity".into());}
 if q["expires_at_ms"].as_u64().is_some_and(|expiry|u128::from(expiry)<=ms()){
  return Err("请求已过期".into());
 }
 if let Some(region_id)=q["region_id"].as_str(){
  if !valid(region_id){return Err("Invalid region identity".into());}
  let region=read(&r.join("regions").join(format!("{region_id}.json")),32*1024*1024)?;
  if region["id"]!=region_id||region["snapshot_hash"]!=q["snapshot_hash"]{return Err("Region changed since request".into());}
  q["region"]=region;
  for key in ["entity_id","is_current_revision","revision_count","last_verified_at"]{
   if !q["view_metadata"][key].is_null(){q["region"][key]=q["view_metadata"][key].clone();}
  }
 }
 if q["kind"]=="display"||q["kind"]=="capture"{
  let id=q["region"]["snapshot_id"].as_str().ok_or("Missing snapshot")?;
  if !valid(id){return Err("Invalid snapshot identity".into());}
  let path=r.join("snapshots").join(format!("{id}.json"));
  if fs::metadata(&path).map_err(|e|e.to_string())?.len()>32*1024*1024{return Err("Snapshot exceeds limit".into());}
  let bytes=fs::read(path).map_err(|e|e.to_string())?;
  if q["region"]["snapshot_hash"]!=format!("{:x}",Sha256::digest(&bytes)){return Err("Snapshot hash mismatch".into());}
  q["snapshot"]=serde_json::from_slice(&bytes).map_err(|e|e.to_string())?;
 }
 Ok(q)
}
fn claim_next(r:&Path)->Result<Value,String>{
 let mut entries=fs::read_dir(r.join("requests")).map_err(|e|e.to_string())?.filter_map(Result::ok)
  .filter(|e|e.path().extension().and_then(|s|s.to_str())==Some("json")).collect::<Vec<_>>();
 entries.sort_by_key(|e|e.file_name());
 for entry in entries{
  let name=entry.file_name();
  let Some(id)=name.to_str().and_then(|s|s.strip_suffix(".json")).filter(|s|valid(s)) else{continue};
  let claimed=r.join("processing").join(&name);
  match fs::rename(entry.path(),&claimed){
   Ok(())=>{},
   Err(e) if e.kind()==std::io::ErrorKind::NotFound=>continue,
   Err(e)=>return Err(e.to_string()),
  }
  match load_claim(r,&claimed,id){
   Ok(q)=>return Ok(q),
   Err(error)=>{
    reply(r,id,&json!({"ok":false,"error":error}))?;
    fs::remove_file(claimed).map_err(|e|e.to_string())?;
   }
  }
 }
 Ok(Value::Null)
}
fn poll_workbench()->Result<Value,String>{
 let r=root();
 queue_dirs(&r)?;
 workbench_heartbeat()?;
 claim_next(&r)
}
fn store_images(r:&Path,id:&str,q:&Value,result:&mut Value)->Result<(),String>{
 let data=std::mem::take(&mut result["result"]["images"]);
 let images=data.as_array().ok_or("Missing captured images")?;
 if images.is_empty()||images.len()>8{return Err("Invalid capture count".into());}
 let dir=r.join("captures").join(id);
 let stage=r.join("captures").join(format!(".{id}-pending"));
 fs::create_dir(&stage).map_err(|e|e.to_string())?;
 let commit=(||{
  let mut saved=Vec::new();
  for (index,img) in images.iter().enumerate(){
   let data=img["data_url"].as_str().and_then(|s|s.strip_prefix("data:image/png;base64,")).ok_or("Expected PNG capture")?;
   if data.len()>24*1024*1024{return Err("Capture exceeds limit".into());}
   let bytes=STANDARD.decode(data).map_err(|e|e.to_string())?;
   if bytes.len()<24||&bytes[..8]!=b"\x89PNG\r\n\x1a\n"{return Err("Invalid PNG image".into());}
   let width=u32::from_be_bytes(bytes[16..20].try_into().unwrap());
   let height=u32::from_be_bytes(bytes[20..24].try_into().unwrap());
   if width!=q["width"].as_u64().unwrap_or(1024) as u32||height!=q["height"].as_u64().unwrap_or(768) as u32{return Err("Capture dimensions differ from request".into());}
   let name=format!("view-{index}.png");
   fs::write(stage.join(&name),&bytes).map_err(|e|e.to_string())?;
   saved.push(json!({"name":img["name"],"path":dir.join(&name),"width":width,"height":height,"camera":img["camera"],"sha256":format!("{:x}",Sha256::digest(&bytes))}));
  }
  result["result"]["images"]=json!(saved);
  let mut metadata=result["result"].clone();
  if let Some(object)=metadata.as_object_mut(){object.remove("scene_geometry");}
  write(&stage.join("capture.json"),&metadata)?;
  fs::rename(&stage,&dir).map_err(|e|e.to_string())
 })();
 if commit.is_err(){
  // Only the temporary files created above are owned by this request.
  for index in 0..8{let _=fs::remove_file(stage.join(format!("view-{index}.png")));}
  let _=fs::remove_file(stage.join("capture.json"));
  let _=fs::remove_dir(stage);
 }
 commit
}
#[cfg(test)]
mod queue_tests{
 use super::*;
 #[test]
 fn expired_or_missing_region_does_not_block_next_request(){
  let temp=std::env::temp_dir();
  let directory=temp.join(format!("terraweave-queue-{}-{}",std::process::id(),ms()));
  queue_dirs(&directory).unwrap();
  write(&directory.join("requests/a.json"),&json!({"id":"a","kind":"display","region_id":"missing"})).unwrap();
  write(&directory.join("requests/b.json"),&json!({"id":"b","kind":"scene_view","expires_at_ms":7})).unwrap();
  write(&directory.join("requests/c.json"),&json!({"id":"c","kind":"scene_view"})).unwrap();
  assert_eq!(claim_next(&directory).unwrap()["id"],"c");
  assert_eq!(read(&directory.join("responses/a.json"),65536).unwrap()["ok"],false);
  assert_eq!(read(&directory.join("responses/b.json"),65536).unwrap()["ok"],false);
  let resolved=directory.canonicalize().unwrap();
  assert_eq!(resolved.parent(),Some(temp.canonicalize().unwrap().as_path()));
  for file in ["responses/a.json","responses/b.json","processing/c.json"]{
   fs::remove_file(resolved.join(file)).unwrap();
  }
  for name in ["requests","processing","responses","regions","snapshots","captures"]{
   fs::remove_dir(resolved.join(name)).unwrap();
  }
  fs::remove_dir(resolved).unwrap();
 }
}
#[tauri::command]
pub fn workbench_complete(id:String,mut result:Value)->Result<(),String>{
 if !valid(&id){return Err("Invalid request identity".into());}
 let r=root();
 let claimed=r.join("processing").join(format!("{id}.json"));
 let q=read(&claimed,65536)?;
 if result["ok"]==true&&matches!(q["kind"].as_str(),Some("capture"|"capture_map"|"capture_scene"|"capture_viewport")){
  if let Err(error)=store_images(&r,&id,&q,&mut result){result=json!({"ok":false,"error":error});}
 }
 if q["reply"]!=false{reply(&r,&id,&result)?;}
 fs::remove_file(claimed).map_err(|e|e.to_string())
}
#[tauri::command]
pub async fn workbench_call(tool:String,args:Value)->Result<Value,String>{
 tauri::async_runtime::spawn_blocking(move||{
  if crate::ui_worker::handles(&tool){return crate::ui_worker::request(&tool,args)}
  let mut command=Command::new(node_program());command.arg(project().join("tools/creative-workbench.mjs")).arg("--json").current_dir(project()).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
  #[cfg(windows)]{use std::os::windows::process::CommandExt;command.creation_flags(0x08000000);}
  let mut child=command.spawn().map_err(|e|e.to_string())?;
  child.stdin.take().ok_or("Missing tool stdin")?.write_all(serde_json::to_string(&json!({"tool":tool,"args":args})).unwrap().as_bytes()).map_err(|e|e.to_string())?;
  let output=child.wait_with_output().map_err(|e|e.to_string())?;let v:Value=serde_json::from_slice(&output.stdout).map_err(|_|format!("Invalid workbench tool response: {}",String::from_utf8_lossy(&output.stderr)))?;
  if !output.status.success()||v["error"].is_string(){return Err(v["error"].as_str().unwrap_or("Workbench tool failed").into())}Ok(v)
 }).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub fn workbench_show(window:tauri::Window)->Result<(),String>{window.unminimize().map_err(|e|e.to_string())?;window.show().map_err(|e|e.to_string())}
#[tauri::command]
pub fn workbench_window_action(window:tauri::Window,action:String)->Result<Value,String>{
 match action.as_str(){
  "drag"=>{window.start_dragging().map_err(|e|e.to_string())?;return Ok(Value::Null)},
  "minimize"=>{window.minimize().map_err(|e|e.to_string())?;return Ok(json!({"minimized":true}))},
  "maximize"=>{if window.is_maximized().map_err(|e|e.to_string())?{window.unmaximize().map_err(|e|e.to_string())?;}else{window.maximize().map_err(|e|e.to_string())?;}},
  "enter-fullscreen" | "exit-fullscreen" => {
   window.set_fullscreen(action == "enter-fullscreen").map_err(|e| e.to_string())?;
  },
  "close"=>{window.close().map_err(|e|e.to_string())?;return Ok(json!({"closed":true}))},
  "state"=>{},_=>return Err("Unknown window action".into())
 }
 Ok(json!({"decorated":window.is_decorated().map_err(|e|e.to_string())?,"maximized":window.is_maximized().map_err(|e|e.to_string())?,"fullscreen":window.is_fullscreen().map_err(|e|e.to_string())?}))
}
#[tauri::command]
pub fn workbench_read_image(capture_id:String,index:usize)->Result<String,String>{
 if !valid(&capture_id)||index>7{return Err("Invalid saved image identity".into())}
 let file=root().join("captures").join(&capture_id).join(format!("view-{index}.png"));
 if fs::metadata(&file).map_err(|e|e.to_string())?.len()>9*1024*1024{return Err("Saved image exceeds limit".into())}
 let bytes=fs::read(file).map_err(|e|e.to_string())?;
 let metadata=read(&root().join("captures").join(&capture_id).join("capture.json"),65536)?;
 if metadata["images"][index]["sha256"]!=format!("{:x}",Sha256::digest(&bytes)){return Err("Saved capture image changed".into())}
 Ok(format!("data:image/png;base64,{}",STANDARD.encode(bytes)))
}
