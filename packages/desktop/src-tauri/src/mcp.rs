//! MCP 客户端（PLAN §8）：stdio 传输 + 进程组回收 + 状态机 + 退避重启。
//!
//! 只实现 stdio（本地子进程）。`sse` / `http` 需要 HTTP 客户端，属后续里程碑；
//! 状态机与工具命名对三种传输是共用的，故这里把 `Transport` 建模完整，仅 stdio 有实现。
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

/// MCP 协议版本（与 PLAN §8 的最小客户端一致）
pub const PROTOCOL_VERSION: &str = "2024-11-05";
/// 退避重启上限（设置页「异常重启上限」文案：指数退避 1/2/4/8s，上限 5 次）
pub const MAX_RESTARTS: u32 = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Transport {
    Stdio,
    Sse,
    Http,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Disabled,
    Connecting,
    Connected,
    NeedsAuth,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerSpec {
    pub name: String,
    pub transport: Transport,
    /// stdio：命令与参数
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// 注入的环境变量（值支持 {env:VAR}）
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// sse/http 用；stdio 忽略
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default = "default_timeout")]
    pub timeout_ms: u64,
    /// 输出截断阈值（字节），超出落盘并给路径引用
    #[serde(default = "default_truncate")]
    pub truncate_bytes: u64,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

fn default_timeout() -> u64 {
    60_000
}
fn default_truncate() -> u64 {
    65_536
}
fn default_enabled() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDef {
    /// 注册进工具引擎的名字：`mcp:<server>:<tool>`（PLAN §8）
    pub qualified: String,
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallResult {
    pub text: String,
    pub is_error: bool,
    pub truncated: bool,
    pub spill_path: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum McpError {
    #[error("启动 {0} 失败：{1}")]
    Spawn(String, String),
    #[error("调用超时（{0}ms），已终止进程组")]
    Timeout(u64),
    #[error("server 未连接（当前 {}）", .0)]
    NotConnected(String),
    #[error("协议错误：{0}")]
    Protocol(String),
    #[error("server 返回错误：{0}")]
    Remote(String),
    #[error("传输 {0} 尚未实现（本轮只做 stdio）")]
    UnsupportedTransport(String),
}

/// 一个 stdio MCP server 的客户端。阻塞式（宿主用 spawn_blocking 包），
/// 读线程把整行 JSON 塞进 channel，从而能给任何请求加超时。
pub struct McpClient {
    spec: ServerSpec,
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    lines: Mutex<Option<Receiver<String>>>,
    stderr_tail: Arc<Mutex<Vec<String>>>,
    next_id: AtomicI64,
    pub status: Mutex<Status>,
    tools: Mutex<Vec<ToolDef>>,
    restarts: Mutex<u32>,
    cache_dir: PathBuf,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

impl McpClient {
    pub fn new(spec: ServerSpec, cache_dir: impl Into<PathBuf>) -> Self {
        Self {
            spec,
            child: Mutex::new(None),
            stdin: Mutex::new(None),
            lines: Mutex::new(None),
            stderr_tail: Arc::new(Mutex::new(Vec::new())),
            next_id: AtomicI64::new(1),
            status: Mutex::new(Status::Disabled),
            tools: Mutex::new(Vec::new()),
            restarts: Mutex::new(0),
            cache_dir: cache_dir.into(),
        }
    }

    pub fn spec(&self) -> &ServerSpec {
        &self.spec
    }

    pub fn status(&self) -> Status {
        *lock(&self.status)
    }

    pub fn tools(&self) -> Vec<ToolDef> {
        lock(&self.tools).clone()
    }

    /// 子进程 pid（unix 下同时是进程组号）；未运行时 0
    pub fn child_pid(&self) -> u32 {
        lock(&self.child).as_ref().map(|c| c.id()).unwrap_or(0)
    }

    pub fn stderr_tail(&self) -> String {
        lock(&self.stderr_tail).join("\n")
    }

    /// 连接 = 起进程 + initialize + tools/list。失败置 Failed 并返回错误（上层决定是否退避重试）。
    pub fn connect(&self) -> Result<Vec<ToolDef>, McpError> {
        if self.spec.transport != Transport::Stdio {
            *lock(&self.status) = Status::Failed;
            return Err(McpError::UnsupportedTransport(format!("{:?}", self.spec.transport)));
        }
        *lock(&self.status) = Status::Connecting;
        self.spawn()?;
        let init = self.rpc("initialize", json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": { "name": "duo-desktop", "version": env!("CARGO_PKG_VERSION") },
        }))?;
        if init.get("authRequired").and_then(Value::as_bool).unwrap_or(false) {
            *lock(&self.status) = Status::NeedsAuth;
            return Err(McpError::Remote("需要鉴权，请在系统浏览器完成授权".into()));
        }
        self.notify("notifications/initialized", json!({}));
        let list = self.rpc("tools/list", json!({}))?;
        let mut tools = Vec::new();
        if let Some(arr) = list.get("tools").and_then(Value::as_array) {
            for t in arr {
                tools.push(ToolDef {
                    qualified: format!("mcp:{}:{}", self.spec.name, t["name"].as_str().unwrap_or("?")),
                    name: t["name"].as_str().unwrap_or("?").to_string(),
                    description: t["description"].as_str().unwrap_or_default().to_string(),
                    input_schema: t.get("inputSchema").cloned().unwrap_or(json!({})),
                });
            }
        }
        *lock(&self.tools) = tools.clone();
        *lock(&self.status) = Status::Connected;
        *lock(&self.restarts) = 0;
        Ok(tools)
    }

    fn spawn(&self) -> Result<(), McpError> {
        self.shutdown();
        let mut cmd = Command::new(expand(&self.spec.command, &self.spec.env));
        cmd.args(self.spec.args.iter().map(|a| expand(a, &self.spec.env)).collect::<Vec<_>>());
        for (k, v) in &self.spec.env {
            cmd.env(k, expand(v, &self.spec.env));
        }
        // 新进程组：退出/停用时能连孙进程一起回收（PLAN §8「含孙进程」）
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| McpError::Spawn(self.spec.name.clone(), e.to_string()))?;
        let stdout = child.stdout.take().ok_or_else(|| McpError::Spawn(self.spec.name.clone(), "无 stdout".into()))?;
        let stderr = child.stderr.take().ok_or_else(|| McpError::Spawn(self.spec.name.clone(), "无 stderr".into()))?;
        let stdin = child.stdin.take().ok_or_else(|| McpError::Spawn(self.spec.name.clone(), "无 stdin".into()))?;

        let (tx, rx) = mpsc::channel::<String>();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if !line.trim().is_empty() && tx.send(line).is_err() {
                    break;
                }
            }
        });
        let tail = self.stderr_tail.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let mut v = lock(&tail);
                if v.len() >= 50 {
                    v.remove(0);
                }
                v.push(line);
            }
        });

        *lock(&self.lines) = Some(rx);
        *lock(&self.stdin) = Some(stdin);
        *lock(&self.child) = Some(child);
        Ok(())
    }

    fn rpc(&self, method: &str, params: Value) -> Result<Value, McpError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let req = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        self.write_line(&req)?;
        let timeout = Duration::from_millis(self.spec.timeout_ms.max(200));
        // 只收这一条请求的响应：跳过不匹配 id 的通知
        loop {
            let line = {
                let guard = lock(&self.lines);
                let Some(rx) = guard.as_ref() else {
                    return Err(McpError::NotConnected(format!("{:?}", self.status())));
                };
                match rx.recv_timeout(timeout) {
                    Ok(l) => l,
                    Err(_) => {
                        self.kill_group();
                        *lock(&self.status) = Status::Failed;
                        return Err(McpError::Timeout(self.spec.timeout_ms));
                    }
                }
            };
            let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
            if v.get("id").and_then(Value::as_i64) != Some(id) {
                continue;
            }
            if let Some(err) = v.get("error") {
                return Err(McpError::Remote(err["message"].as_str().unwrap_or("unknown").to_string()));
            }
            return Ok(v.get("result").cloned().unwrap_or(Value::Null));
        }
    }

    fn notify(&self, method: &str, params: Value) {
        let _ = self.write_line(&json!({ "jsonrpc": "2.0", "method": method, "params": params }));
    }

    fn write_line(&self, v: &Value) -> Result<(), McpError> {
        let mut guard = lock(&self.stdin);
        let Some(si) = guard.as_mut() else {
            return Err(McpError::NotConnected(format!("{:?}", self.status())));
        };
        si.write_all(v.to_string().as_bytes())
            .and_then(|_| si.write_all(b"\n"))
            .and_then(|_| si.flush())
            .map_err(|e| McpError::Protocol(format!("写 stdin 失败：{e}")))
    }

    /// 调工具；输出超阈值时截断并落盘给路径引用（PLAN §8）
    pub fn call_tool(&self, name: &str, args: Value) -> Result<CallResult, McpError> {
        if self.status() != Status::Connected {
            return Err(McpError::NotConnected(format!("{:?}", self.status())));
        }
        let res = self.rpc("tools/call", json!({ "name": name, "arguments": args }))?;
        let mut text = String::new();
        if let Some(arr) = res.get("content").and_then(Value::as_array) {
            for c in arr {
                if let Some(t) = c.as_str() {
                    text.push_str(t);
                } else if let Some(t) = c.get("text").and_then(Value::as_str) {
                    text.push_str(t);
                }
            }
        }
        let is_error = res.get("isError").and_then(Value::as_bool).unwrap_or(false);
        let (text, truncated, spill) = truncate_with_spill(&self.cache_dir, &self.spec.name, text, self.spec.truncate_bytes);
        Ok(CallResult { text, is_error, truncated, spill_path: spill })
    }

    /// 指数退避：1/2/4/8s，超过 MAX_RESTARTS 次不再重启（PLAN §8 / 设置页文案）
    pub fn next_restart(&self) -> Option<Duration> {
        let mut n = lock(&self.restarts);
        if *n >= MAX_RESTARTS {
            return None;
        }
        let secs = 1u64 << (*n).min(3);
        *n += 1;
        Some(Duration::from_secs(secs))
    }

    pub fn restart_count(&self) -> u32 {
        *lock(&self.restarts)
    }

    /// 杀掉整个进程组（含孙进程）。非 unix 退回单进程 kill。
    pub fn kill_group(&self) {
        let mut guard = lock(&self.child);
        let Some(child) = guard.as_mut() else { return };
        #[cfg(unix)]
        {
            let pid = child.id();
            // 进程组号 == 组长 pid（spawn 时 process_group(0)）
            let _ = Command::new("kill").args(["-TERM", &format!("-{pid}")]).output();
        }
        #[cfg(not(unix))]
        let _ = child.kill();
        let _ = child.wait();
        *guard = None;
    }

    /// 停用 / 应用退出时回收（PLAN §8「退出即回收」）
    pub fn shutdown(&self) {
        self.kill_group();
        *lock(&self.stdin) = None;
        *lock(&self.lines) = None;
        if self.spec.enabled {
            *lock(&self.status) = Status::Disabled;
        }
    }
}

/// `{env:VAR}` 占位替换（PLAN §8 鉴权注入）；未设置的变量留空串
pub fn expand(s: &str, _env: &HashMap<String, String>) -> String {
    let mut out = s.to_string();
    while let Some(i) = out.find("{env:") {
        let Some(j) = out[i..].find('}') else { break };
        let var = &out[i + 5..i + j];
        let val = std::env::var(var).unwrap_or_default();
        out.replace_range(i..i + j + 1, &val);
    }
    out
}

/// 超出阈值：保留前段 + 落盘全文 + 给路径引用
fn truncate_with_spill(cache: &PathBuf, server: &str, text: String, cap: u64) -> (String, bool, Option<String>) {
    if (text.len() as u64) <= cap {
        return (text, false, None);
    }
    let _ = std::fs::create_dir_all(cache);
    let path = cache.join(format!("mcp-{server}-{}.txt", std::process::id()));
    let keep = text.chars().take(cap as usize).collect::<String>();
    let full = text.clone();
    if std::fs::write(&path, full).is_ok() {
        let note = format!("\n… 输出已截断（{}/{} 字节），完整内容见 {}", keep.len(), text.len(), path.display());
        (format!("{keep}{note}"), true, Some(path.to_string_lossy().to_string()))
    } else {
        (keep, true, None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn python() -> Option<PathBuf> {
        which("python3").or_else(|| which("python"))
    }

    fn which(bin: &str) -> Option<PathBuf> {
        std::env::var_os("PATH").and_then(|paths| {
            std::env::split_paths(&paths)
                .map(|d| d.join(bin))
                .find(|p| p.is_file())
        })
    }

    /// 假 MCP server：initialize / tools/list / tools/call，还能按需拖时间或派孙进程
    const FAKE: &str = r#"
import json, os, sys, time
def send(o): sys.stdout.write(json.dumps(o)+"\n"); sys.stdout.flush()
for line in sys.stdin:
    try: m = json.loads(line)
    except Exception: continue
    if m.get("id") is None: continue
    p = m.get("params") or {}
    if m["method"] == "initialize":
        send({"jsonrpc":"2.0","id":m["id"],"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"fake"},"authRequired": os.environ.get("FAKE_AUTH")=="1"}})
    elif m["method"] == "tools/list":
        send({"jsonrpc":"2.0","id":m["id"],"result":{"tools":[{"name":"echo","description":"回显","inputSchema":{"type":"object"}},{"name":"boom","description":"必错","inputSchema":{}}]}})
    elif m["method"] == "tools/call":
        if p.get("name") == "boom":
            send({"jsonrpc":"2.0","id":m["id"],"error":{"code":-32000,"message":"boom 工具故意失败"}})
        elif os.environ.get("FAKE_HANG") == "1":
            time.sleep(30)
        elif os.environ.get("FAKE_GRAND") == "1":
            os.system("sleep 120 &")
            send({"jsonrpc":"2.0","id":m["id"],"result":{"content":[{"type":"text","text":"spawned"}]}})
        else:
            big = os.environ.get("FAKE_BIG") == "1"
            txt = ("y"*5000) if big else json.dumps(p.get("arguments") or {})
            send({"jsonrpc":"2.0","id":m["id"],"result":{"content":[{"type":"text","text":txt}]}})
    else:
        send({"jsonrpc":"2.0","id":m["id"],"result":{}})
"#;

    fn fixture() -> (tempfile::TempDir, PathBuf, ServerSpec) {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("fake_mcp.py");
        std::fs::write(&script, FAKE).unwrap();
        let py = python().expect("测试环境需要 python3 才能起假 server");
        let spec = ServerSpec {
            name: "fake".into(),
            transport: Transport::Stdio,
            command: py.to_string_lossy().to_string(),
            args: vec![script.to_string_lossy().to_string()],
            env: HashMap::new(),
            url: String::new(),
            headers: HashMap::new(),
            timeout_ms: 1_500,
            truncate_bytes: 1_000,
            enabled: true,
        };
        (dir, script, spec)
    }

    #[test]
    fn 连接后能发现工具并按_mcp_前缀命名() {
        let (_d, _s, spec) = fixture();
        let c = McpClient::new(spec, _d.path());
        let tools = c.connect().unwrap();
        assert_eq!(c.status(), Status::Connected);
        assert_eq!(tools.iter().map(|t| t.qualified.clone()).collect::<Vec<_>>(), vec!["mcp:fake:echo", "mcp:fake:boom"]);
        c.shutdown();
    }

    #[test]
    fn 调用能拿到结果且远端错误如实上报() {
        let (d, _s, spec) = fixture();
        let c = McpClient::new(spec, d.path());
        c.connect().unwrap();
        let r = c.call_tool("echo", json!({ "q": "hi" })).unwrap();
        assert!(r.text.contains("\"q\": \"hi\"") || r.text.contains("\"q\":\"hi\""), "{}", r.text);
        assert!(!r.is_error);
        let e = c.call_tool("boom", json!({}));
        assert!(matches!(e, Err(McpError::Remote(_))), "{e:?}");
        c.shutdown();
    }

    #[test]
    fn 超时会被熔断并置_failed() {
        let (d, _s, mut spec) = fixture();
        spec.env.insert("FAKE_HANG".into(), "1".into());
        spec.timeout_ms = 400;
        let c = McpClient::new(spec.clone(), d.path());
        c.connect().unwrap();
        let e = c.call_tool("echo", json!({})).unwrap_err();
        assert!(matches!(e, McpError::Timeout(400)), "{e:?}");
        assert_eq!(c.status(), Status::Failed);
        // 超时后进程已被杀，再调直接 NotConnected 而不是永远挂着
        assert!(matches!(c.call_tool("echo", json!({})), Err(McpError::NotConnected(_))));
    }

    #[test]
    fn 退避序列是_1_2_4_8_且上限_5_次() {
        let (d, _s, spec) = fixture();
        let c = McpClient::new(spec, d.path());
        let seq: Vec<u64> = (0..7).filter_map(|_| c.next_restart().map(|d| d.as_secs())).collect();
        assert_eq!(seq, vec![1, 2, 4, 8, 8], "第 6 次起不再重启");
        assert_eq!(c.restart_count(), MAX_RESTARTS);
        assert!(c.next_restart().is_none());
    }

    #[test]
    fn 连接成功会把重启计数清零() {
        let (d, _s, spec) = fixture();
        let c = McpClient::new(spec, d.path());
        assert_eq!(c.next_restart().map(|d| d.as_secs()), Some(1));
        c.connect().unwrap();
        assert_eq!(c.restart_count(), 0);
    }

    #[test]
    fn 输出超阈值截断并落盘给路径() {
        let (d, _s, mut spec) = fixture();
        spec.env.insert("FAKE_BIG".into(), "1".into());
        let c = McpClient::new(spec, d.path());
        c.connect().unwrap();
        let r = c.call_tool("echo", json!({})).unwrap();
        assert!(r.truncated);
        assert!(r.text.chars().count() < 1_200);
        let spill = r.spill_path.expect("应给出落盘路径");
        assert_eq!(std::fs::read_to_string(&spill).unwrap().len(), 5000, "原文要完整落盘");
        assert!(r.text.contains("完整内容见"), "{}", r.text);
    }

    #[test]
    fn 需要鉴权时进_needs_auth_而不是假装连上() {
        let (d, _s, mut spec) = fixture();
        spec.env.insert("FAKE_AUTH".into(), "1".into());
        let c = McpClient::new(spec, d.path());
        assert!(matches!(c.connect(), Err(McpError::Remote(_))));
        assert_eq!(c.status(), Status::NeedsAuth);
    }

    #[test]
    fn 进程组回收能带走孙进程() {
        let Some(py) = python() else { return };
        let (d, _s, mut spec) = fixture();
        spec.command = py.to_string_lossy().to_string();
        spec.env.insert("FAKE_GRAND".into(), "1".into());
        let c = McpClient::new(spec, d.path());
        c.connect().unwrap();
        c.call_tool("echo", json!({})).unwrap();
        let pgid = c.child_pid();
        assert!(pgid > 0);
        // 组里应有一个 sleep 120
        let before = group_has_sleep(pgid);
        c.shutdown();
        std::thread::sleep(Duration::from_millis(500));
        let after = group_has_sleep(pgid);
        println!("pgid={pgid} before={before} after={after}");
        assert!(before, "假 server 应已派生 sleep 120 孙进程，否则这条测试没有意义");
        assert!(!after, "kill -TERM -<pgid> 之后进程组里不该再有 sleep");
    }

    #[cfg(unix)]
    fn group_has_sleep(pgid: u32) -> bool {
        let out = Command::new("ps").args(["-A", "-o", "pid=,pgid=,comm="]).output().map(|o| o.stdout).unwrap_or_default();
        let want = pgid.to_string();
        String::from_utf8_lossy(&out)
            .lines()
            .any(|l| l.split_whitespace().nth(1) == Some(want.as_str()) && l.contains("sleep"))
    }

    #[cfg(not(unix))]
    fn group_has_sleep(_pgid: u32) -> bool {
        false
    }

    #[test]
    fn env_占位符会展开且未设置留空() {
        std::env::set_var("DUO_TEST_TOKEN", "secret-1");
        assert_eq!(expand("Bearer {env:DUO_TEST_TOKEN}", &HashMap::new()), "Bearer secret-1");
        assert_eq!(expand("{env:DUO_TEST_MISSING_X}/x", &HashMap::new()), "/x");
        assert_eq!(expand("no placeholder", &HashMap::new()), "no placeholder");
    }

    #[test]
    fn 未实现的传输明确报错而不是静默() {
        let (d, _s, mut spec) = fixture();
        spec.transport = Transport::Http;
        let c = McpClient::new(spec, d.path());
        assert!(matches!(c.connect(), Err(McpError::UnsupportedTransport(_))));
        assert_eq!(c.status(), Status::Failed);
    }

    #[test]
    fn 起不来的命令报_spawn_错误() {
        let (d, _s, mut spec) = fixture();
        spec.command = "/nonexistent/mcp-binary".into();
        let c = McpClient::new(spec, d.path());
        assert!(matches!(c.connect(), Err(McpError::Spawn(..))));
    }
}
