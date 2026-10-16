//! duo Desktop 外壳（Tauri v2）：窗口 + 托盘 + invoke/emit 转发。
//!
//! 外壳刻意做薄：所有业务都在 `duo_host_core::hub` 里，这里只负责
//! - 把 `hub.handle(cmd, args)` 暴露成一条 `duo_invoke` command（而不是 50 个 command，
//!   命令名与前端 `Commands` 接口逐字对齐，防漂移由 Rust 侧测试把住）；
//! - 把 `DuoEvent` 以 `duo://event` 广播给 WebView；
//! - 关窗 = 隐藏到托盘（后台任务继续跑），托盘菜单提供「显示主窗口 / 退出 duo」；
//! - 退出前回收 MCP 子进程组（PLAN §8「退出即回收」）。
use duo_host_core::adapt::{DbProviderFactory, RpiRuntime};
use duo_host_core::hub::{EventSink, Hub};
use duo_host_core::ipc::{Envelope, SCHEMA_VERSION};
use duo_host_core::store::Store;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri::WebviewWindow;

/// 事件出口：Envelope 原样发给前端（前端按 (session, turn, seq) 游标排序）
struct TauriSink {
    app: Mutex<Option<AppHandle>>,
}

impl EventSink for TauriSink {
    fn emit(&self, env: &Envelope) {
        if let Some(app) = self.app.lock().ok().and_then(|a| a.clone()) {
            let _ = app.emit("duo://event", env);
        }
    }
}

struct Shared {
    hub: Arc<Hub>,
}

/// 数据目录：`DUO_DATA_DIR` 覆盖（测试/便携模式），否则 `~/.local/share/duo-desktop`
fn data_dir() -> PathBuf {
    if let Ok(d) = std::env::var("DUO_DATA_DIR") {
        return PathBuf::from(d);
    }
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
    home.join(".local/share/duo-desktop")
}

/// 工作区：`DUO_WORKDIR` 覆盖，否则当前目录（真实产品里由项目选择器决定）
fn workdir() -> PathBuf {
    std::env::var("DUO_WORKDIR").map(PathBuf::from).unwrap_or_else(|_| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

#[tauri::command]
fn duo_invoke(state: State<'_, Shared>, cmd: String, args: serde_json::Value) -> Result<serde_json::Value, String> {
    state.hub.handle(&cmd, args).map_err(|e| e.to_string())
}

#[tauri::command]
fn duo_versions() -> serde_json::Value {
    serde_json::json!({
        "appVersion": duo_host_core::ipc::APP_VERSION,
        "runtimeVersion": duo_host_core::ipc::RUNTIME_VERSION,
        "schemaVersion": SCHEMA_VERSION,
        "git": duo_host_core::gitx::Git::installed(),
    })
}

#[tauri::command]
fn duo_window_minimize(win: WebviewWindow) -> Result<(), String> {
    win.minimize().map_err(|e| e.to_string())
}

#[tauri::command]
fn duo_window_toggle_maximize(win: WebviewWindow) -> Result<bool, String> {
    let max = win.is_maximized().unwrap_or(false);
    if max {
        win.unmaximize()
    } else {
        win.maximize()
    }
    .map_err(|e| e.to_string())?;
    Ok(!max)
}

#[tauri::command]
fn duo_window_close(win: WebviewWindow) -> Result<(), String> {
    win.close().map_err(|e| e.to_string())
}

fn main() {
    let sink = Arc::new(TauriSink { app: Mutex::new(None) });
    let data = data_dir();
    std::fs::create_dir_all(&data).ok();
    let store = Arc::new(Store::open(&data).expect("打不开 SQLite，无法启动"));
    // rpi runtime(T3):端点未配置时 submit 如实返回 provider_unconfigured,不假装跑通
    let runtime = RpiRuntime::new(Arc::new(DbProviderFactory::new(store.clone())));
    let hub = Hub::open(store, workdir(), &data, sink.clone(), runtime.clone()).expect("宿主初始化失败");
    runtime.attach(hub.clone());

    tauri::Builder::default()
        .manage(Shared { hub: hub.clone() })
        .invoke_handler(tauri::generate_handler![
            duo_invoke,
            duo_versions,
            duo_window_minimize,
            duo_window_toggle_maximize,
            duo_window_close
        ])
        .setup(move |app| {
            *sink.app.lock().unwrap_or_else(|e| e.into_inner()) = Some(app.handle().clone());

            // 托盘（PLAN §5.1：关窗进托盘，后台任务继续）
            let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出 duo", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let mut tray = TrayIconBuilder::with_id("duo-tray").menu(&menu).tooltip("duo Desktop").on_menu_event({
                let handle = app.handle().clone();
                move |_app, ev| match ev.id.as_ref() {
                    "show" => {
                        if let Some(w) = handle.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => handle.exit(0),
                    _ => {}
                }
            });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            // 启动握手：前端拿 app/runtime/schema 三个版本做不匹配提示（PLAN §9.2）
            hub.emit(duo_host_core::ipc::DuoEvent::Ready {
                app_version: duo_host_core::ipc::APP_VERSION.to_string(),
                runtime_version: duo_host_core::ipc::RUNTIME_VERSION.to_string(),
                schema_version: SCHEMA_VERSION,
            });
            log::info!("duo 宿主就绪：data={} git={}", data.display(), duo_host_core::gitx::Git::installed());
            Ok(())
        })
        .on_window_event(|window, event| {
            // 关窗先隐藏，真正退出走托盘菜单 / cmd+q
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("构建 Tauri 应用失败")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                // 退出前回收所有 MCP 子进程组（含孙进程）
                app.state::<Shared>().hub.shutdown_mcp();
            }
        });
}
