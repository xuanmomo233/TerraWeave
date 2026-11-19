//! Tauri IPC for the persistent, workbench-owned renderer.
use crate::{
    iris_mesh::SceneSource,
    iris_pack::PackSources,
    iris_pipeline::{DrawFrame, Engine},
};
use serde_json::Value;
use std::sync::{
    mpsc::{self, Sender},
    OnceLock,
};
use std::time::Duration;
use tauri::ipc::Response;

enum Request {
    Check(PackSources, Sender<Result<Value, String>>),
    Prepare(PackSources, SceneSource, Sender<Result<Value, String>>),
    Draw(DrawFrame, Sender<Result<Vec<u8>, String>>),
    Report(Sender<Result<Value, String>>),
}
static WORKER: OnceLock<Sender<Request>> = OnceLock::new();

fn worker() -> &'static Sender<Request> {
    WORKER.get_or_init(|| {
        let (send, receive) = mpsc::channel();
        // OpenGL objects are created, used and dropped on this thread only.
        std::thread::Builder::new()
            .name("terraweave-offline-iris".into())
            .spawn(move || {
                let mut engine = Engine::new();
                for request in receive {
                    match request {
                        Request::Check(pack, reply) => {
                            let result = engine.as_mut().map_err(|e| e.clone()).and_then(|e| e.check(pack));
                            let _ = reply.send(result);
                        }
                        Request::Prepare(pack, scene, reply) => {
                            let result = engine
                                .as_mut()
                                .map_err(|e| e.clone())
                                .and_then(|e| e.prepare(pack, scene));
                            let _ = reply.send(result);
                        }
                        Request::Draw(frame, reply) => {
                            let result = engine
                                .as_mut()
                                .map_err(|e| e.clone())
                                .and_then(|e| e.draw(frame));
                            let _ = reply.send(result);
                        }
                        Request::Report(reply) => {
                            let result = engine.as_ref().map_err(|e| e.clone()).map(Engine::report);
                            let _ = reply.send(result);
                        }
                    }
                }
            })
            .expect("Start workbench renderer thread");
        send
    })
}
async fn call<T: Send + 'static>(
    request: impl FnOnce(Sender<Result<T, String>>) -> Request,
) -> Result<T, String> {
    let (reply, wait) = mpsc::channel();
    worker()
        .send(request(reply))
        .map_err(|_| "离线渲染线程已关闭".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        wait.recv_timeout(Duration::from_secs(90))
            .map_err(|_| "离线渲染未完成".to_string())?
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn iris_check_pack(pack: PackSources) -> Result<Value, String> {
    call(|reply| Request::Check(pack, reply)).await
}
#[tauri::command]
pub async fn iris_prepare(pack: PackSources, scene: SceneSource) -> Result<Value, String> {
    call(|reply| Request::Prepare(pack, scene, reply)).await
}
#[tauri::command]
pub async fn iris_draw(frame: DrawFrame) -> Result<Response, String> {
    call(|reply| Request::Draw(frame, reply))
        .await
        .map(Response::new)
}
#[tauri::command]
pub async fn iris_report() -> Result<Value, String> {
    call(Request::Report).await
}
