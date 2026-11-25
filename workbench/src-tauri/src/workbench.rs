use base64::{engine::general_purpose::STANDARD,Engine};
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use std::{fs,io::Write,path::{Path,PathBuf},process::{Command,Stdio},sync::{Mutex,OnceLock,atomic::{AtomicU64,Ordering}},time::{SystemTime,UNIX_EPOCH}};
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
const DESKTOP_SESSION:&str="desktop-session.json";
struct Startup{primary:PathBuf,root:PathBuf}
fn catalog_project(primary:&Path,id:&str)->Option<PathBuf>{
 if id.len()!=36||!id.bytes().enumerate().all(|(i,b)|match i{
  8|13|18|23=>b==b'-',_=>b.is_ascii_digit()||(b'a'..=b'f').contains(&b)
 }){return None}
 let root=primary.join("projects").join(id);
 let descriptor=read(&root.join("project.json"),65536).ok()?;
 (descriptor["schema"]==1&&descriptor["id"]==id&&descriptor["name"].is_string()).then_some(root)
}
fn resolve_startup(install:&Path,state:Option<PathBuf>,catalog:Option<PathBuf>,pinned_world:bool)->Startup{
 let primary=catalog.unwrap_or_else(||{
  if let Some(root)=&state{
   if let Some(projects)=root.parent().filter(|p|p.file_name().is_some_and(|n|n=="projects")){
    if let (Some(parent),Some(id))=(projects.parent(),root.file_name().and_then(|n|n.to_str())){
     if catalog_project(parent,id).is_some(){return parent.to_path_buf()}
    }
   }
   root.clone()
  }else{install.join("project-state/workbench")}
 });
 let root=state.unwrap_or_else(||{
  if !pinned_world{
   if let Ok(session)=read(&primary.join(DESKTOP_SESSION),4096){
    if let Some(root)=session["project_id"].as_str().and_then(|id|catalog_project(&primary,id)){return root}
   }
  }
  primary.clone()
 });
 Startup{primary,root}
}
fn startup()->&'static Startup{
 static STARTUP:OnceLock<Startup>=OnceLock::new();
 STARTUP.get_or_init(||{
  let install=project();
  let scoped=|key|std::env::var_os(key).filter(|p|!p.is_empty()).map(|p|install.join(p));
  resolve_startup(&install,scoped("TERRAWEAVE_STATE"),scoped("TERRAWEAVE_PRIMARY_STATE"),
   std::env::var_os("TERRAWEAVE_WORLD").is_some_and(|p|!p.is_empty()))
 })
}
fn remember_project(primary:&Path,state:&Path){
 let id=if state==primary{"primary"}else{
  let Some(id)=state.file_name().and_then(|v|v.to_str()) else{return};
  if catalog_project(primary,id).as_deref()!=Some(state){return}
  id
 };
 let file=primary.join(DESKTOP_SESSION);
 if read(&file,4096).is_ok_and(|previous|previous["project_id"]==id){return}
 if let Err(e)=write(&file,&json!({"project_id":id})){eprintln!("保存最近使用的工程失败：{e}");}
}
struct DesktopProject{root:PathBuf,_instance:fs::File,last_heartbeat:u64,epoch:u64,operations:usize}
impl DesktopProject{
 fn check_page(&self,epoch:u64)->Result<(),String>{
  if self.epoch==epoch{Ok(())}else{Err("请求来自已切换的工程页面".into())}
 }
}
static ACTIVE_PROJECT:OnceLock<Mutex<DesktopProject>>=OnceLock::new();
fn active_project()->&'static Mutex<DesktopProject>{ACTIVE_PROJECT.get().expect("Desktop project initialized")}
pub(crate) fn root()->PathBuf{
 ACTIVE_PROJECT.get().map(|p|p.lock().expect("Desktop project lock").root.clone()).unwrap_or_else(||startup().root.clone())
}
pub(crate) fn project_env(command:&mut Command,state:&Path){
 static PRIMARY_WORLD:OnceLock<Option<std::ffi::OsString>>=OnceLock::new();
 let initial=startup();
 let primary=&initial.primary;
 let primary_world=PRIMARY_WORLD.get_or_init(||std::env::var_os("TERRAWEAVE_PRIMARY_WORLD").or_else(||
  (initial.root==*primary).then(||std::env::var_os("TERRAWEAVE_WORLD")).flatten()));
 command.env("TERRAWEAVE_STATE",state).env("TERRAWEAVE_PRIMARY_STATE",primary);
 if let Some(world)=primary_world{command.env("TERRAWEAVE_PRIMARY_WORLD",world);}
 if state!=initial.root{
  command.env_remove("TERRAWEAVE_WORLD");
  if state==primary{if let Some(world)=primary_world{command.env("TERRAWEAVE_WORLD",world);}}
 }
}
fn ms()->u128{SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis()}
static WRITES:AtomicU64=AtomicU64::new(0);
fn valid(id:&str)->bool{!id.is_empty()&&id.len()<100&&id.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-')}
fn write(path:&Path,value:&Value)->Result<(),String>{
 let pending=path.with_extension(format!("pending-{}-{}",std::process::id(),WRITES.fetch_add(1,Ordering::Relaxed)));
 fs::write(&pending,serde_json::to_vec(value).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
 fs::rename(pending,path).map_err(|e|e.to_string())
}
fn lock_project(root:&Path)->std::io::Result<fs::File>{
 fs::create_dir_all(root)?;
 let mut options=fs::OpenOptions::new();options.write(true).create(true);
 #[cfg(windows)]{use std::os::windows::fs::OpenOptionsExt;options.share_mode(0);}
 let file=options.open(root.join("desktop.instance.lock"))?;
 #[cfg(unix)] file.try_lock().map_err(std::io::Error::from)?;
 Ok(file)
}
pub fn claim_instance()->Result<(),String>{
 let root=startup().root.clone();
 let instance=lock_project(&root).map_err(|e|e.to_string())?;
 ACTIVE_PROJECT.set(Mutex::new(DesktopProject{root,_instance:instance,last_heartbeat:0,epoch:0,operations:0}))
  .map_err(|_|"桌面工程已初始化".into())
}
pub fn show_existing(){
 let id=format!("{}-{}",ms(),std::process::id());let _=fs::create_dir_all(root().join("requests"));
 let _=write(&root().join("requests").join(format!("{id}.json")),&json!({"id":id,"kind":"show","reply":false,"expires_at_ms":ms()+10000}));
 let _=fs::write(root().join("wake-window"),[]);
}
pub fn monitor_window(window:tauri::WebviewWindow){
 let focused_window=window.clone();
 let remember=move||{
  if focused_window.is_visible().unwrap_or(false)&&focused_window.is_focused().unwrap_or(false){
   remember_project(&startup().primary,&root());
  }
 };
 remember();
 window.on_window_event(move|event|if let tauri::WindowEvent::Focused(true)=event{remember()});
 std::thread::spawn(move||loop{
  let _=workbench_heartbeat();
  if fs::remove_file(root().join("wake-window")).is_ok(){
   let _=window.show();
   let _=window.unminimize();
   let _=window.set_focus();
  }
  std::thread::sleep(std::time::Duration::from_millis(300));
 });
}
#[tauri::command]
pub fn workbench_heartbeat()->Result<(),String>{
 let mut state=active_project().lock().map_err(|e|e.to_string())?;
 refresh_heartbeat(&mut state)
}
fn refresh_heartbeat(state:&mut DesktopProject)->Result<(),String>{
 let now=ms() as u64;
 if now.saturating_sub(state.last_heartbeat)<1000{return Ok(())}
 write(&state.root.join("heartbeat.json"),&heartbeat(now))?;
 state.last_heartbeat=now;
 Ok(())
}
fn heartbeat(now:u64)->Value{json!({"pid":std::process::id(),"at_ms":now.to_string(),"version":2})}
fn read(path:&Path,max:u64)->Result<Value,String>{
 if fs::metadata(path).map_err(|e|e.to_string())?.len()>max{return Err("Workbench data exceeds limit".into())}
 serde_json::from_slice(&fs::read(path).map_err(|e|e.to_string())?).map_err(|e|e.to_string())
}
#[tauri::command]
pub async fn workbench_poll(project_epoch:u64)->Result<Value,String>{
 tauri::async_runtime::spawn_blocking(move||poll_workbench(project_epoch)).await.map_err(|e|e.to_string())?
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
 recover_project_requests(&root())
}
fn recover_project_requests(r:&Path)->Result<(),String>{
 queue_dirs(r)?;
 for entry in fs::read_dir(r.join("processing")).map_err(|e|e.to_string())?.filter_map(Result::ok){
  let name=entry.file_name();
  let Some(id)=name.to_str().and_then(|s|s.strip_suffix(".json")).filter(|s|valid(s)) else{continue};
  let output=r.join("responses").join(format!("{id}.json"));
  if !output.exists(){reply(r,id,&json!({"ok":false,"error":"工作台已重启，该请求已中断"}))?;}
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
fn poll_workbench(project_epoch:u64)->Result<Value,String>{
 let mut active=active_project().lock().map_err(|e|e.to_string())?;
 active.check_page(project_epoch)?;
 refresh_heartbeat(&mut active)?;
 queue_dirs(&active.root)?;
 claim_next(&active.root)
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
 fn startup_resumes_a_registered_project_without_changing_explicit_bindings(){
  let temp=std::env::temp_dir().join(format!("terraweave-startup-{}-{}",std::process::id(),ms()));
  let primary=temp.join("project-state/workbench");
  let id="11111111-2222-3333-4444-555555555555";
  let child=primary.join("projects").join(id);
  fs::create_dir_all(&child).unwrap();
  write(&child.join("project.json"),&json!({"schema":1,"id":id,"name":"山谷"})).unwrap();
  let resume=||resolve_startup(&temp,None,None,false);
  assert_eq!(resume().root,primary);
  remember_project(&primary,&child);
  assert_eq!(resume().root,child);
  assert_eq!(resolve_startup(&temp,None,None,true).root,primary);
  assert_eq!(resolve_startup(&temp,Some(primary.clone()),None,false).root,primary);
  let pinned=resolve_startup(&temp,Some(child.clone()),None,false);
  assert_eq!(pinned.primary,primary);assert_eq!(pinned.root,child);
  remember_project(&primary,&temp);
  assert_eq!(resume().root,child);
  remember_project(&primary,&primary);
  assert_eq!(resume().root,primary);
  write(&primary.join(DESKTOP_SESSION),&json!({"project_id":"../elsewhere"})).unwrap();
  assert_eq!(resume().root,primary);
  remember_project(&primary,&child);
  fs::remove_file(child.join("project.json")).unwrap();
  assert_eq!(resume().root,primary);
  let dir=temp.canonicalize().unwrap();
  assert_eq!(dir.parent(),Some(std::env::temp_dir().canonicalize().unwrap().as_path()));
  fs::remove_dir_all(dir).unwrap();
 }
 #[test]
 fn stale_page_and_pending_queue_are_detected_during_handoff(){
  let temp=std::env::temp_dir();
  let root=temp.join(format!("terraweave-handoff-{}-{}",std::process::id(),ms()));
  queue_dirs(&root).unwrap();
  let active=DesktopProject{_instance:lock_project(&root).unwrap(),root:root.clone(),last_heartbeat:0,epoch:7,operations:0};
  assert!(active.check_page(6).is_err());
  assert!(active.check_page(7).is_ok());
  assert!(lock_project(&root).is_err());
  assert!(!has_desktop_requests(&root).unwrap());
  let queued=root.join("requests/queued.json");
  write(&queued,&json!({"id":"queued","kind":"scene_view"})).unwrap();
  assert!(has_desktop_requests(&root).unwrap());
  assert_eq!(claim_next(&root).unwrap()["id"],"queued");
  assert!(has_desktop_requests(&root).unwrap());
  fs::remove_file(root.join("processing/queued.json")).unwrap();
  assert!(!has_desktop_requests(&root).unwrap());
  drop(active);
  let resolved=root.canonicalize().unwrap();
  assert_eq!(resolved.parent(),Some(temp.canonicalize().unwrap().as_path()));
  fs::remove_dir_all(resolved).unwrap();
 }
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
pub fn workbench_complete(id:String,mut result:Value,project_epoch:u64)->Result<(),String>{
 if !valid(&id){return Err("Invalid request identity".into());}
 let r=page_root(project_epoch)?;
 let claimed=r.join("processing").join(format!("{id}.json"));
 let q=read(&claimed,65536)?;
 if result["ok"]==true&&matches!(q["kind"].as_str(),Some("capture"|"capture_map"|"capture_scene"|"capture_viewport")){
  if let Err(error)=store_images(&r,&id,&q,&mut result){result=json!({"ok":false,"error":error});}
 }
 if q["reply"]!=false{reply(&r,&id,&result)?;}
 fs::remove_file(claimed).map_err(|e|e.to_string())
}
fn page_root(epoch:u64)->Result<PathBuf,String>{
 let active=active_project().lock().map_err(|e|e.to_string())?;
 active.check_page(epoch)?;
 Ok(active.root.clone())
}
fn has_desktop_requests(root:&Path)->Result<bool,String>{
 for name in ["processing","requests"]{
  for entry in fs::read_dir(root.join(name)).map_err(|e|e.to_string())?{
   if entry.map_err(|e|e.to_string())?.path().extension().and_then(|s|s.to_str())==Some("json"){return Ok(true)}
  }
 }
 Ok(false)
}
struct ProjectOperation;
impl Drop for ProjectOperation{
 fn drop(&mut self){
  if let Ok(mut active)=active_project().lock(){active.operations-=1;}
 }
}
fn background_read(tool:&str)->bool{
 matches!(tool,"ui_snapshot"|"world_map_info"|"world_map_tile"|"world_model_tile"|"world_scene_info"
  |"world_volume_tile"|"planning_state"|"workspace_status"|"workbench_status"|"list_regions"|"list_drafts"
  |"list_history"|"list_captures"|"read_editor_state"|"project_locations"|"list_projects"|"render_settings"|"iris_scene_inputs")
}
#[tauri::command]
pub async fn workbench_call(tool:String,args:Value,project_epoch:u64,view_epoch:Option<String>)->Result<Value,String>{
 let (state,operation)={
  let mut active=active_project().lock().map_err(|e|e.to_string())?;
  active.check_page(project_epoch)?;
  let lease=(!background_read(&tool)).then(||{active.operations+=1;ProjectOperation});
  (active.root.clone(),lease)
 };
 tauri::async_runtime::spawn_blocking(move||{
  let _operation=operation;
  if crate::ui_worker::handles(&tool)&&!(tool=="world_scene_info"&&args["preview"]!=true){return crate::ui_worker::request(&tool,args,&state)}
  let mut command=Command::new(node_program());command.arg(project().join("tools/creative-workbench.mjs")).arg("--json").current_dir(project()).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
  project_env(&mut command,&state);
  command.env("TERRAWEAVE_DESKTOP_EXE",std::env::current_exe().map_err(|e|e.to_string())?);
  #[cfg(windows)]{use std::os::windows::process::CommandExt;command.creation_flags(0x08000000);}
  let mut child=command.spawn().map_err(|e|e.to_string())?;
  child.stdin.take().ok_or("Missing tool stdin")?.write_all(serde_json::to_string(&json!({"tool":tool,"args":args,"view_epoch":view_epoch})).unwrap().as_bytes()).map_err(|e|e.to_string())?;
  let output=child.wait_with_output().map_err(|e|e.to_string())?;let v:Value=serde_json::from_slice(&output.stdout).map_err(|_|format!("Invalid workbench tool response: {}",String::from_utf8_lossy(&output.stderr)))?;
  if !output.status.success()||v["error"].is_string(){return Err(v["error"].as_str().unwrap_or("Workbench tool failed").into())}Ok(v)
 }).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub async fn switch_project(window:tauri::Window,id:String,project_epoch:u64)->Result<u64,String>{
 let source=page_root(project_epoch)?;
 let details=workbench_call("project_locations".into(),json!({"id":id}),project_epoch,None).await?;
 let target=PathBuf::from(details["project_directory"].as_str().ok_or("无法读取目标工程目录")?);
 tauri::async_runtime::spawn_blocking(move||{
  {
   let mut active=active_project().lock().map_err(|e|e.to_string())?;
   active.check_page(project_epoch)?;
   if active.root==target{return Ok(project_epoch)}
   if active.operations!=0||has_desktop_requests(&source)?{
    return Err("请等待当前工程的操作完成后再切换".into());
   }
   let instance=lock_project(&target).map_err(|error|{
    if error.kind()==std::io::ErrorKind::WouldBlock||cfg!(windows)&&matches!(error.raw_os_error(),Some(32|33)){
     "目标工程已在另一个窗口打开，可从工程列表显示其窗口".to_owned()
    }else{format!("无法打开目标工程：{error}")}
   })?;
   recover_project_requests(&target)?;
   let now=ms() as u64;
   let new_heartbeat=target.join("heartbeat.json");
   write(&new_heartbeat,&heartbeat(now))?;
   if let Err(error)=fs::remove_file(source.join("heartbeat.json")){
    if error.kind()!=std::io::ErrorKind::NotFound{
     let _=fs::remove_file(new_heartbeat);
     return Err(error.to_string());
    }
   }
   *active=DesktopProject{root:target,_instance:instance,last_heartbeat:now,epoch:project_epoch+1,operations:0};
  }
  crate::ui_worker::retire(&source);
  if window.is_visible().unwrap_or(false)&&window.is_focused().unwrap_or(false){
   remember_project(&startup().primary,&root());
  }
  Ok(project_epoch+1)
 }).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub fn workbench_show(window:tauri::Window)->Result<(),String>{
 window.show().map_err(|e|e.to_string())?;
 window.unminimize().map_err(|e|e.to_string())?;
 window.set_focus().map_err(|e|e.to_string())?;
 remember_project(&startup().primary,&root());
 Ok(())
}
#[tauri::command]
pub fn workbench_window_action(window:tauri::Window,action:String,title:Option<String>)->Result<Value,String>{
 match action.as_str(){
  "drag"=>{window.start_dragging().map_err(|e|e.to_string())?;return Ok(Value::Null)},
  "minimize"=>{window.minimize().map_err(|e|e.to_string())?;return Ok(json!({"minimized":true}))},
  "title"=>{let title=title.filter(|name|!name.is_empty()&&name.chars().count()<=120).ok_or("Invalid window title")?;window.set_title(&title).map_err(|e|e.to_string())?;return Ok(Value::Null)},
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
pub fn workbench_read_image(capture_id:String,index:usize,project_epoch:u64)->Result<String,String>{
 if !valid(&capture_id)||index>7{return Err("Invalid saved image identity".into())}
 let root=page_root(project_epoch)?;
 let file=root.join("captures").join(&capture_id).join(format!("view-{index}.png"));
 if fs::metadata(&file).map_err(|e|e.to_string())?.len()>9*1024*1024{return Err("Saved image exceeds limit".into())}
 let bytes=fs::read(file).map_err(|e|e.to_string())?;
 let metadata=read(&root.join("captures").join(&capture_id).join("capture.json"),65536)?;
 if metadata["images"][index]["sha256"]!=format!("{:x}",Sha256::digest(&bytes)){return Err("Saved capture image changed".into())}
 Ok(format!("data:image/png;base64,{}",STANDARD.encode(bytes)))
}
