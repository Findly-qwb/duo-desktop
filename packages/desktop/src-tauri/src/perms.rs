//! 权限引擎（PLAN §6.6）——Duo 相对 rpi 的核心增量。
//! rpi 提供工具执行缝，本模块决定「能不能执行、要不要人批」。
//!
//! 分层解析取最严格者生效：global → project → session → agent/mode
//! 每条规则可带 matcher（path glob / command 前缀 glob / host），并支持例外列表覆盖默认。

use std::collections::HashMap;
use std::time::Duration;

use globset::{Glob, GlobSet, GlobSetBuilder};
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

use crate::ipc::ConfirmKind;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Policy {
    Auto,
    RequireApproval,
    Deny,
}

/// 审批超时：30 分钟无响应自动 deny，避免任务永久挂起（PLAN §3.3）
pub const APPROVAL_TIMEOUT: Duration = Duration::from_secs(30 * 60);

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Matcher {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Exception {
    pub matcher: Matcher,
    pub policy: Policy,
}

#[derive(Debug, Clone)]
pub struct Rule {
    pub scope: Scope,
    /// project → 项目路径；session → 会话 id；global / agent 留空
    pub scope_ref: String,
    pub tool: String,
    pub policy: Policy,
    pub matcher: Option<Matcher>,
    pub exceptions: Vec<Exception>,
    set: Option<GlobSet>,
}

impl Rule {
    /// 宿主命令层（hub）从 DB 重建规则用的构造器；`set` 是 put 时编译的匹配缓存
    pub fn build(scope: Scope, scope_ref: String, tool: String, policy: Policy, matcher: Option<Matcher>, exceptions: Vec<Exception>) -> Self {
        Self { scope, scope_ref, tool, policy, matcher, exceptions, set: None }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    Global,
    Project,
    Session,
    Agent,
}

/// 一次工具调用的判定输入
#[derive(Debug, Clone)]
pub struct Call<'a> {
    pub tool: &'a str,
    pub path: Option<&'a str>,
    pub command: Option<&'a str>,
    pub host: Option<&'a str>,
    /// project 路径或 session id，用于 project / session 层规则定位
    pub scope_ref: Option<&'a str>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind", content = "matched_rule")]
pub enum Decision {
    Auto,
    /// 需要人工审批；带上命中的规则说明，供审批卡展示「为什么被拦」
    Ask { matched_rule: String },
    Deny { matched_rule: String },
}

#[derive(Debug, Clone, Copy)]
pub struct ModePolicy {
    pub write: Policy,
    pub shell: Policy,
}

/// 模式默认策略（PLAN §6.6）
pub fn mode_policy(mode: &str) -> ModePolicy {
    match mode {
        "ask" => ModePolicy { write: Policy::Deny, shell: Policy::Deny },
        "plan" => ModePolicy { write: Policy::Deny, shell: Policy::Auto },
        _ => ModePolicy { write: Policy::RequireApproval, shell: Policy::RequireApproval },
    }
}

const WRITE_TOOLS: [&str; 3] = ["write", "edit", "apply_patch"];
const SHELL_TOOLS: [&str; 2] = ["bash", "powershell"];

pub fn is_write(tool: &str) -> bool {
    WRITE_TOOLS.contains(&tool)
}
pub fn is_shell(tool: &str) -> bool {
    SHELL_TOOLS.contains(&tool)
}

#[derive(Default)]
pub struct PermissionEngine {
    /// (scope, scope_ref, tool) -> Rule
    rules: HashMap<(Scope, String, String), Rule>,
}

impl PermissionEngine {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn put(&mut self, rule: Rule) {
        let key = (rule.scope, rule.scope_ref.clone(), rule.tool.clone());
        self.rules.insert(key, with_compiled_matcher(rule));
    }

    pub fn remove(&mut self, scope: Scope, scope_ref: &str, tool: &str) {
        self.rules.remove(&(scope, scope_ref.to_string(), tool.to_string()));
    }

    /// 判定顺序：
    /// 1) 收集所有命中层的候选策略（含模式默认）
    /// 2) 逐条查例外列表：命中例外即覆盖该条默认
    /// 3) 取最严格者生效
    pub fn decide(&self, mode: &str, call: &Call) -> Decision {
        let mut layers: Vec<(Policy, String)> = Vec::new();

        // 模式默认：写类 / shell 类工具
        let mp = mode_policy(mode);
        if is_write(call.tool) {
            layers.push((mp.write, format!("mode={mode} write 默认")));
        } else if is_shell(call.tool) {
            layers.push((mp.shell, format!("mode={mode} shell 默认")));
        }

        for scope in [Scope::Global, Scope::Project, Scope::Session, Scope::Agent] {
            for ((s, scope_ref, tool), rule) in &self.rules {
                if *s != scope || !tool_matches(tool, call.tool) {
                    continue;
                }
                // global / agent 层不限定作用域对象；project / session 层必须对上号
                if matches!(s, Scope::Project | Scope::Session) && !scope_ref.is_empty() && Some(scope_ref.as_str()) != call.scope_ref {
                    continue;
                }
                let _ = scope_ref;
                if let Some(g) = &rule.matcher {
                    if !matcher_hits(g, call) {
                        continue;
                    }
                }
                // 例外优先：命中例外即覆盖本条默认
                let mut effective = rule.policy;
                let mut note = format!("{:?} {} = {:?}", scope, rule.tool, rule.policy);
                for ex in &rule.exceptions {
                    if matcher_hits(&ex.matcher, call) {
                        effective = ex.policy;
                        note = format!("{:?} {} 例外 = {:?}", scope, rule.tool, ex.policy);
                        break;
                    }
                }
                layers.push((effective, note));
            }
        }

        if layers.is_empty() {
            return Decision::Auto;
        }
        let (worst, note) = layers.into_iter().max_by_key(|(p, _)| *p).expect("非空");
        match worst {
            Policy::Auto => Decision::Auto,
            Policy::RequireApproval => Decision::Ask { matched_rule: note },
            Policy::Deny => Decision::Deny { matched_rule: note },
        }
    }
}

fn with_compiled_matcher(mut rule: Rule) -> Rule {
    if let Some(m) = &rule.matcher {
        let mut builder = GlobSetBuilder::new();
        let mut any = false;
        for pat in [&m.path, &m.command, &m.host].into_iter().flatten() {
            if let Ok(g) = Glob::new(pat) {
                builder.add(g);
                any = true;
            }
        }
        rule.set = any.then(|| builder.build()).transpose().ok().flatten();
    }
    rule
}

/// `mcp:*` 之类的通配工具名
fn tool_matches(declared: &str, actual: &str) -> bool {
    match declared.strip_suffix('*') {
        Some(prefix) => actual.starts_with(prefix),
        None => declared == actual,
    }
}

fn matcher_hits(m: &Matcher, call: &Call) -> bool {
    let one = |pat: &Option<String>, val: Option<&str>| match (pat, val) {
        (Some(p), Some(v)) => Glob::new(p).map(|g| g.compile_matcher().is_match(v)).unwrap_or(false),
        (Some(_), None) => false,
        (None, _) => true,
    };
    // 三个维度都为 None 时视为不限制；任一给出且不匹配即不命中
    let given = m.path.is_some() || m.command.is_some() || m.host.is_some();
    if !given {
        return true;
    }
    one(&m.path, call.path) && one(&m.command, call.command) && one(&m.host, call.host)
}

/// punycode / 同形域名检测（PLAN §6.6 安全默认：审批卡高亮提示）
pub fn suspicious_host(raw: &str) -> bool {
    let host = url_host(raw).unwrap_or_else(|| raw.to_string());
    let lower = host.to_ascii_lowercase();
    lower.contains("xn--") || host.bytes().any(|b| !b.is_ascii())
}

fn url_host(raw: &str) -> Option<String> {
    let after = raw.split_once("://").map(|(_, r)| r).unwrap_or(raw);
    after.split(['/', '?', '#']).next().map(|s| s.to_string())
}

/// 审批挂起：oneshot + 超时自动 deny（PLAN §6.2 第 5 步）
pub async fn await_approval(rx: oneshot::Receiver<ApprovalReply>) -> ApprovalReply {
    match tokio::time::timeout(APPROVAL_TIMEOUT, rx).await {
        Ok(Ok(reply)) => reply,
        // 超时或前端已消失：一律按 deny 处理，绝不默认放行
        Ok(Err(_)) | Err(_) => ApprovalReply { decision: Decision::Deny { matched_rule: "审批超时（30min）自动拒绝".into() }, modified_args: None },
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalReply {
    pub decision: Decision,
    /// 改参数后执行（PLAN §5.3 审批卡契约）
    #[serde(default)]
    pub modified_args: Option<serde_json::Value>,
}

pub fn kind_of(tool: &str, args: &serde_json::Value) -> ConfirmKind {
    if is_shell(tool) || args.get("command").is_some() {
        ConfirmKind::Command
    } else if args.get("patch").is_some() || args.get("diff").is_some() {
        ConfirmKind::Diff
    } else {
        ConfirmKind::Paths
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(scope: Scope, tool: &str, policy: Policy, matcher: Option<Matcher>, exceptions: Vec<Exception>) -> Rule {
        Rule { scope, scope_ref: String::new(), tool: tool.into(), policy, matcher, exceptions, set: None }
    }

    fn call<'a>(tool: &'a str, path: Option<&'a str>, command: Option<&'a str>) -> Call<'a> {
        Call { tool, path, command, host: None, scope_ref: None }
    }

    #[test]
    fn code_模式下写类工具默认需审批() {
        let e = PermissionEngine::new();
        let d = e.decide("code", &call("edit", Some("a.ts"), None));
        assert!(matches!(d, Decision::Ask { .. }));
    }

    #[test]
    fn ask_模式写与_shell_全拒() {
        let e = PermissionEngine::new();
        let w = e.decide("ask", &call("write", Some("a.ts"), None));
        assert_eq!(w, Decision::Deny { matched_rule: "mode=ask write 默认".into() });
        let b = e.decide("ask", &call("bash", None, Some("ls")));
        assert_eq!(b, Decision::Deny { matched_rule: "mode=ask shell 默认".into() });
    }

    #[test]
    fn 取最严格者生效() {
        let mut e = PermissionEngine::new();
        e.put(rule(Scope::Global, "bash", Policy::Auto, None, vec![]));
        e.put(rule(Scope::Project, "bash", Policy::RequireApproval, None, vec![]));
        let d = e.decide("code", &call("bash", None, Some("echo hi")));
        assert!(matches!(d, Decision::Ask { .. }), "global auto 应被 project require_approval 压过");
    }

    #[test]
    fn 例外列表覆盖工具默认() {
        let mut e = PermissionEngine::new();
        e.put(rule(
            Scope::Global,
            "bash",
            Policy::Auto,
            None,
            vec![Exception { matcher: Matcher { command: Some("rm -rf *".into()), ..Default::default() }, policy: Policy::Deny }],
        ));
        // Code 模式下 mode 层会把 shell 抬到 require_approval（取最严格者），
        // 故例外链要在 mode 不更严的 plan 模式下验证。
        let d = e.decide("plan", &call("bash", None, Some("rm -rf /tmp/x")));
        assert!(matches!(d, Decision::Deny { .. }), "bash auto + 例外 rm -rf 必须 deny");
        let ok = e.decide("plan", &call("bash", None, Some("bun test")));
        assert_eq!(ok, Decision::Auto);
    }

    #[test]
    fn path_glob_matcher() {
        let mut e = PermissionEngine::new();
        e.put(rule(
            Scope::Global,
            "read",
            Policy::Auto,
            Some(Matcher { path: Some("**/.env".into()), ..Default::default() }),
            vec![Exception { matcher: Matcher { path: Some("**/.env".into()), ..Default::default() }, policy: Policy::Deny }],
        ));
        let d = e.decide("code", &call("read", Some("app/.env"), None));
        assert!(matches!(d, Decision::Deny { .. }), "敏感文件即使 auto 也拒绝");
    }

    #[test]
    fn project_层不串台到其他项目() {
        let mut e = PermissionEngine::new();
        let mut r = rule(Scope::Project, "bash", Policy::Deny, None, vec![]);
        r.scope_ref = "/work/a".into();
        e.put(r);
        assert!(matches!(e.decide("code", &Call { tool: "bash", path: None, command: Some("ls"), host: None, scope_ref: Some("/work/a") }), Decision::Deny { .. }));
        // 另一个项目只吃 Code 模式默认（require_approval），不吃 /work/a 的 deny
        assert!(matches!(e.decide("code", &Call { tool: "bash", path: None, command: Some("ls"), host: None, scope_ref: Some("/work/b") }), Decision::Ask { .. }));
    }

    #[test]
    fn mcp_通配工具名() {
        assert!(tool_matches("mcp:*", "mcp:context7:query-docs"));
        assert!(!tool_matches("mcp:*", "read"));
    }

    #[test]
    fn 同形域名可识别() {
        assert!(suspicious_host("https://xn--80ak6aa92e.com/login"));
        assert!(suspicious_host("https://аpple.com"));
        assert!(!suspicious_host("https://apple.com"));
    }

    #[tokio::test]
    async fn 审批超时自动拒绝() {
        let (_tx, rx) = oneshot::channel();
        drop(_tx);
        let reply = await_approval(rx).await;
        assert!(matches!(reply.decision, Decision::Deny { .. }));
    }
}
