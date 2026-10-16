//! duo Desktop 宿主核心（PLAN §15 的 Rust 侧模块）
//!
//! - `ipc`        协议单一来源：Rust → 前端 20 事件 + 前端 → Rust 命令入参
//! - `store`      SQLite 事实来源：WAL / user_version 迁移 / 单 writer 队列
//! - `perms`      权限引擎：三态 × 分层作用域 + matcher + 例外 + 审批超时
//! - `gitx`       用户仓库通道：系统 git CLI（PLAN §7.1，不编译 libgit2）
//! - `checkpoint` 第二条通道：shadow 仓库快照与逐消息 Revert / Redo（§7.2）
//! - `fsx`        工作区扫描 / gitignore / 预览与注入预算（§6.8）
//! - `mcp`        stdio MCP 客户端：进程组回收、超时、指数退避重启（§8）
//! - `hub`        §9.2 命令路由 + 事件出口，transport 无关（Tauri 外壳只做转发）
//! - `adapt`      rpi Agent Runtime ↔ 协议适配（PLAN §6.9）：harness 驱动 + 权限钩子 + SQLite 双写

pub mod adapt;
pub mod checkpoint;
pub mod fsx;
pub mod gitx;
pub mod hub;
pub mod ipc;
pub mod mcp;
pub mod perms;
pub mod store;

pub use hub::{Hub, HubError};
pub use ipc::{DuoEvent, SCHEMA_VERSION};
pub use perms::{Decision, PermissionEngine, Policy};
pub use store::Store;
