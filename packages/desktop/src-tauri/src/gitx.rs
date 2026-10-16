//! 用户仓库通道（PLAN §7.1）：只走系统 `git` CLI，不编译 libgit2。
//!
//! 边界：本模块只提供「能跑通且解析得动」的 git 能力，**不含审批**。
//! `commit` / `push` 属 PLAN §6.6 的 REQUIRE_APPROVAL 工具，审批发生在宿主命令层（hub），
//! 这里被调用即视为已获授权；缺失 git 时上层降级为文件快照（checkpoint 模块）。
use crate::ipc::{GitFile, GitSnapshot};
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, thiserror::Error)]
pub enum GitError {
    #[error("系统 git 不可用：{0}；请安装 git 后重试（缺失时 Revert 降级为文件快照）")]
    NotInstalled(String),
    #[error("git {} 失败（exit {}）：{}", .cmd, .code, .stderr)]
    Failed { cmd: String, code: i32, stderr: String },
    #[error("{0} 不是 git 仓库")]
    NotARepo(String),
}

pub struct Git {
    workdir: PathBuf,
}

impl Git {
    pub fn new(workdir: impl Into<PathBuf>) -> Self {
        Self { workdir: workdir.into() }
    }

    pub fn workdir(&self) -> &Path {
        &self.workdir
    }

    /// git 是否可用（宿主启动时探测，决定 gitx / checkpoint 走哪条路）
    pub fn installed() -> bool {
        Command::new("git").arg("--version").output().is_ok()
    }

    /// 统一入口：`-C <workdir>` + 关引号转义（中文路径要能读）+ 禁分页与颜色
    fn run(&self, args: &[&str]) -> Result<String, GitError> {
        let out = Command::new("git")
            .arg("-C")
            .arg(&self.workdir)
            .arg("-c")
            .arg("core.quotepath=false")
            .arg("-c")
            .arg("color.ui=never")
            .args(args)
            .output();
        let out = match out {
            Ok(o) => o,
            Err(e) => return Err(GitError::NotInstalled(e.to_string())),
        };
        if !out.status.success() {
            return Err(GitError::Failed {
                cmd: args.join(" "),
                code: out.status.code().unwrap_or(-1),
                stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
            });
        }
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    }

    /// 与 `run` 同，但接受额外的退出码（`--no-index` 有差异时 git 返回 1）
    fn run_allow(&self, args: &[&str], ok: &[i32]) -> Result<String, GitError> {
        let out = Command::new("git")
            .arg("-C")
            .arg(&self.workdir)
            .arg("-c")
            .arg("core.quotepath=false")
            .args(args)
            .output();
        let out = match out {
            Ok(o) => o,
            Err(e) => return Err(GitError::NotInstalled(e.to_string())),
        };
        let code = out.status.code().unwrap_or(-1);
        if !out.status.success() && !ok.contains(&code) {
            return Err(GitError::Failed { cmd: args.join(" "), code, stderr: String::from_utf8_lossy(&out.stderr).trim().to_string() });
        }
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    }

    pub fn is_repo(&self) -> bool {
        self.run(&["rev-parse", "--is-inside-work-tree"])
            .map(|s| s.trim() == "true")
            .unwrap_or(false)
    }

    fn ensure_repo(&self) -> Result<(), GitError> {
        if self.is_repo() {
            Ok(())
        } else {
            Err(GitError::NotARepo(self.workdir.display().to_string()))
        }
    }

    pub fn branch(&self) -> Result<String, GitError> {
        Ok(self.run(&["rev-parse", "--abbrev-ref", "HEAD"])?.trim().to_string())
    }

    /// ahead/behind 相对上游；没有上游时返回 (0,0)——面板显示 ↑0 ↓0 而不是报错
    pub fn ahead_behind(&self) -> Result<(u32, u32), GitError> {
        let up = self.run(&["rev-parse", "--abbrev-ref", "@{upstream}"]);
        let Ok(up) = up else { return Ok((0, 0)) };
        let up = up.trim();
        if up.is_empty() {
            return Ok((0, 0));
        }
        let head = self.branch()?;
        // --left-right --count <up>...<head> → 左=behind 右=ahead
        let out = self.run(&["rev-list", "--left-right", "--count", &format!("{up}...{head}")])?;
        let mut it = out.split_whitespace();
        let behind = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        let ahead = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        Ok((ahead, behind))
    }

    /// `status --porcelain=v2 -z -b`：记录以 NUL 分隔，分支信息在开头的 `#` header 块里
    pub fn status(&self) -> Result<GitSnapshot, GitError> {
        self.ensure_repo()?;
        let raw = self.run(&["status", "--porcelain=v2", "-z", "-b", "--untracked-files=all"])?;
        let mut branch = String::from("HEAD");
        let mut ahead = 0u32;
        let mut behind = 0u32;
        let mut files: Vec<GitFile> = Vec::new();
        for rec in raw.split('\0').filter(|r| !r.is_empty()) {
            if let Some(h) = rec.strip_prefix("# ") {
                for line in h.split('\n').map(|l| l.trim()) {
                    let line = line.strip_prefix("# ").unwrap_or(line);
                    if let Some(b) = line.strip_prefix("branch.head ") {
                        if b != "(detached)" && b != "(initial)" {
                            branch = b.to_string();
                        }
                    } else if let Some(ab) = line.strip_prefix("branch.ab ") {
                        let mut it = ab.split_whitespace();
                        ahead = it.next().and_then(|s| s.strip_prefix('+').and_then(|x| x.parse().ok())).unwrap_or(0);
                        behind = it.next().and_then(|s| s.strip_prefix('-').and_then(|x| x.parse().ok())).unwrap_or(0);
                    }
                }
                continue;
            }
            if let Some(f) = parse_record(rec) {
                files.push(f);
            }
        }
        // +N / −N：tracked 走 numstat；untracked 数行（有上限，不读超大文件）
        for f in &mut files {
            if f.status == "??" {
                f.added = count_lines(&self.workdir.join(&f.path));
            }
        }
        // 新仓库还没有任何提交时 HEAD 不可解析，跳过 numstat（状态字符仍然正确）
        let has_head = self.has_head();
        if has_head {
            for (path, added, deleted) in self.numstat(&["diff", "--numstat", "-z", "HEAD"])? {
                if let Some(f) = files.iter_mut().find(|f| f.path == path) {
                    f.added = added;
                    f.deleted = deleted;
                } else {
                    files.push(GitFile { path, status: "M".into(), added, deleted });
                }
            }
        }
        files.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(GitSnapshot { branch, ahead, behind, files })
    }

    /// numstat -z：`add\tdel\tpath\0`（重命名多一段 orig，跳过即可）
    fn numstat(&self, argv: &[&str]) -> Result<Vec<(String, u32, u32)>, GitError> {
        let raw = self.run(argv)?;
        let mut out = Vec::new();
        for field in raw.split('\0').filter(|s| !s.is_empty()) {
            let mut cols = field.split('\t');
            let (Some(a), Some(d), Some(p)) = (cols.next(), cols.next(), cols.next()) else { continue };
            if a == "-" {
                continue; // 二进制
            }
            out.push((p.to_string(), a.parse().unwrap_or(0), d.parse().unwrap_or(0)));
        }
        Ok(out)
    }

    /// 工作区 diff（默认未暂存；staged=true 看 index vs HEAD）。
    ///
    /// 新仓库（HEAD 还不可解析）时 `git diff HEAD` 会直接 fatal，而未跟踪文件也不会出现在
    /// 普通 diff 里 —— 变更审查面板却必须能看新文件的 diff。所以这里：
    /// 已入 index 的与空树比（git 惯用常量），未跟踪的逐文件与 /dev/null 比。
    pub fn diff(&self, path: Option<&str>, staged: bool) -> Result<String, GitError> {
        self.ensure_repo()?;
        const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
        if self.has_head() {
            let mut args: Vec<&str> = vec!["diff", "--no-color", "--unified=3"];
            args.push(if staged { "--cached" } else { "HEAD" });
            if let Some(p) = path {
                args.push("--");
                args.push(p);
            }
            return self.run(&args);
        }
        let mut out = String::new();
        if staged || path.is_none() {
            out.push_str(&self.run(&["diff", "--no-color", "--unified=3", "--cached", EMPTY_TREE])?);
        }
        if !staged {
            for f in self.status()?.files.iter().filter(|f| f.status == "??") {
                if path.is_some_and(|p| p != f.path) {
                    continue;
                }
                out.push_str(&self.run_allow(&["diff", "--no-color", "--unified=3", "--no-index", "/dev/null", &f.path], &[0, 1])?);
            }
        }
        Ok(out)
    }

    pub fn stage(&self, paths: &[String]) -> Result<(), GitError> {
        if paths.is_empty() {
            return Ok(());
        }
        let mut args = vec!["add", "--"];
        args.extend(paths.iter().map(|s| s.as_str()));
        self.run(&args)?;
        Ok(())
    }

    pub fn stage_all(&self) -> Result<(), GitError> {
        self.run(&["add", "-A"])?;
        Ok(())
    }

    pub fn unstage(&self, paths: &[String]) -> Result<(), GitError> {
        if paths.is_empty() {
            return Ok(());
        }
        let mut args = vec!["restore", "--staged", "--"];
        args.extend(paths.iter().map(|s| s.as_str()));
        self.run(&args)?;
        Ok(())
    }

    /// 还原单文件到 HEAD（面板「还原」按钮；未提交改动会丢，上层已弹确认）
    pub fn restore(&self, paths: &[String]) -> Result<(), GitError> {
        let mut args = vec!["checkout", "HEAD", "--"];
        args.extend(paths.iter().map(|s| s.as_str()));
        self.run(&args)?;
        Ok(())
    }

    /// 提交；返回 commit oid。调用方必须已经过审批（PLAN §6.6）。
    /// 无变更时 git 以 exit 1 + "nothing to commit" 退出，这不是失败：直接回当前 HEAD。
    pub fn commit(&self, message: &str) -> Result<String, GitError> {
        if let Err(e) = self.run(&["commit", "-m", message]) {
            if matches!(&e, GitError::Failed { stderr, .. } if stderr.contains("nothing to commit")) {
                return self.rev_parse("HEAD");
            }
            return Err(e);
        }
        self.rev_parse("HEAD")
    }

    pub fn push(&self) -> Result<(), GitError> {
        self.run(&["push"])?;
        Ok(())
    }

    /// 有没有可解析的 HEAD（新仓库 / 只有 unborn branch 时为 false）
    pub fn has_head(&self) -> bool {
        self.run(&["rev-parse", "--verify", "--quiet", "HEAD"]).map(|s| !s.trim().is_empty()).unwrap_or(false)
    }

    pub fn rev_parse(&self, rev: &str) -> Result<String, GitError> {
        Ok(self.run(&["rev-parse", rev])?.trim().to_string())
    }

    /// 最近 n 条提交的一行摘要（AI 提交信息时作为风格上下文，也供面板展示）
    pub fn log_oneline(&self, n: u32) -> Result<Vec<String>, GitError> {
        let out = self.run(&["log", "--oneline", "--max-count", &n.to_string()])?;
        Ok(out.lines().map(str::to_string).collect())
    }

    /// 按 diff 生成提交信息草稿（PLAN §7.2「AI 提交信息」的小模型接入点）。
    /// 这里给确定性模板：type/scope 取首个变更路径，主题行 ≤72 字符，正文列文件。
    /// 接上 provider 后把这段换成一次小模型调用即可，签名不变。
    pub fn generate_commit_message(&self) -> Result<String, GitError> {
        let snap = self.status()?;
        if snap.files.is_empty() {
            return Ok("chore: no changes".into());
        }
        let has_new = snap.files.iter().any(|f| f.status == "??");
        let has_del = snap.files.iter().any(|f| f.status == "D");
        let kind = if has_del && !has_new {
            "refactor"
        } else if has_new {
            "feat"
        } else {
            "fix"
        };
        let base = snap.files[0].path.rsplit('/').next().unwrap_or("files");
        let first = base.split('.').next().unwrap_or("files");
        let mut subject = format!("{kind}({first}): ");
        let parts: Vec<String> = snap
            .files
            .iter()
            .take(3)
            .map(|f| format!("{} {}", f.path.rsplit('/').next().unwrap_or(&f.path), if f.status == "??" { "新增" } else { "改动" }))
            .collect();
        subject.push_str(&parts.join("、"));
        if subject.chars().count() > 72 {
            subject.truncate(subject.char_indices().nth(69).map(|(i, _)| i).unwrap_or(subject.len()));
            subject.push_str("...");
        }
        let body: Vec<String> = snap.files.iter().map(|f| format!("- {} ({})", f.path, f.status)).collect();
        Ok(format!("{subject}\n\n{}", body.join("\n")))
    }
}

/// porcelain v2 记录 → 前端用的单字符状态（M / A / D / ?? / U）。
///
/// 各 git 版本的定长前缀不一样：本机 git 2.39 是
/// `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`（path 前 8 段），
/// 新版多了 `<cW> <Xlen> <Ylen>`（path 前 11 段），`2` 还多一个 `<score>`。
/// 所以先按最短格式定位 path，再看该位置是不是 40 位 oid / 纯数字，是就继续吃掉。
/// 路径含空格时用 join(" ") 还原。
fn parse_record(rec: &str) -> Option<GitFile> {
    let t: Vec<&str> = rec.split(' ').collect();
    let kind = *t.first()?;
    let (xy, mut idx) = match kind {
        "?" | "!" => ("??".to_string(), 1),
        "1" => (t.get(1)?.to_string(), 8),
        "2" => (t.get(1)?.to_string(), 9),
        "u" => (t.get(1)?.to_string(), 10),
        _ => return None,
    };
    if t.len() <= idx {
        return None;
    }
    if kind != "?" && kind != "!" {
        if t.get(idx).is_some_and(|s| s.len() == 40) {
            idx += 1; // 新版 cW
        }
        while t.get(idx).is_some_and(|s| !s.is_empty() && s.len() <= 6 && s.bytes().all(|b| b.is_ascii_digit())) {
            idx += 1; // Xlen / Ylen
        }
    }
    if idx >= t.len() {
        return None;
    }
    let path = t[idx..].join(" ");
    if path.is_empty() {
        return None;
    }
    let status = match kind {
        "?" => "??".to_string(),
        "!" => "!!".to_string(),
        "u" => "U".to_string(),
        _ => {
            let b = xy.as_bytes();
            let pick = |c: u8| match c {
                b'A' | b'R' | b'C' => Some('A'),
                b'M' | b'T' => Some('M'),
                b'D' => Some('D'),
                _ => None,
            };
            let x = b.first().copied().unwrap_or(b'.');
            let y = b.get(1).copied().unwrap_or(b'.');
            pick(x).or_else(|| pick(y)).map(|c| c.to_string()).unwrap_or(xy)
        }
    };
    Some(GitFile { path, status, added: 0, deleted: 0 })
}

fn count_lines(p: &Path) -> u32 {
    let Ok(meta) = std::fs::metadata(p) else { return 0 };
    if meta.len() > 2_000_000 {
        return 0; // 巨文件不数行，面板显示 +0 也比卡住好
    }
    match std::fs::read(p) {
        Ok(b) if b.is_empty() => 0,
        Ok(b) => b.iter().filter(|&&c| c == b'\n').count() as u32 + if b.last() == Some(&b'\n') { 0 } else { 1 },
        Err(_) => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command as C;

    fn sh(dir: &Path, args: &[&str]) {
        let ok = C::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        assert!(ok, "git {args:?} 失败");
    }

    /// 真起一个临时仓库：git 能力只能真跑才算验证过
    fn repo() -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        sh(d.path(), &["init", "-q", "-b", "main"]);
        sh(d.path(), &["config", "user.email", "t@duo.local"]);
        sh(d.path(), &["config", "user.name", "duo test"]);
        std::fs::write(d.path().join("a.txt"), "1\n2\n3\n").unwrap();
        sh(d.path(), &["add", "a.txt"]);
        sh(d.path(), &["commit", "-qm", "chore: init"]);
        d
    }

    #[test]
    fn 探测到系统_git_且能读分支() {
        assert!(Git::installed(), "测试环境需要 git");
        let d = repo();
        let g = Git::new(d.path());
        assert!(g.is_repo());
        assert_eq!(g.branch().unwrap(), "main");
    }

    #[test]
    fn 未跟踪与修改文件都能解析出状态与行数() {
        let d = repo();
        std::fs::write(d.path().join("a.txt"), "1\n2\n3\n4\n").unwrap();
        std::fs::write(d.path().join("new.rs"), "fn main() {}\n").unwrap();
        let snap = Git::new(d.path()).status().unwrap();
        let a = snap.files.iter().find(|f| f.path == "a.txt").expect("a.txt 应在变更列表");
        assert_eq!(a.status, "M");
        assert_eq!((a.added, a.deleted), (1, 0));
        let n = snap.files.iter().find(|f| f.path == "new.rs").expect("new.rs 应未跟踪");
        assert_eq!(n.status, "??");
        assert_eq!(n.added, 1);
        assert_eq!(snap.ahead, 0);
    }

    #[test]
    fn 暂存取消暂存与提交返回_oid() {
        let d = repo();
        let g = Git::new(d.path());
        std::fs::write(d.path().join("b.txt"), "x\n").unwrap();
        g.stage(&["b.txt".into()]).unwrap();
        assert!(g.status().unwrap().files.iter().any(|f| f.path == "b.txt" && f.status == "A"));
        g.unstage(&["b.txt".into()]).unwrap();
        assert!(g.status().unwrap().files.iter().any(|f| f.path == "b.txt" && f.status == "??"));
        g.stage_all().unwrap();
        let oid = g.commit("feat(b): 加 b.txt").unwrap();
        assert_eq!(oid.len(), 40, "commit 应回全 oid");
        assert!(g.status().unwrap().files.is_empty());
    }

    #[test]
    fn 中文路径不被转义成八进制() {
        let d = repo();
        let g = Git::new(d.path());
        std::fs::write(d.path().join("会话截图.png"), "not a real png\n").unwrap();
        let paths: Vec<String> = g.status().unwrap().files.into_iter().map(|f| f.path).collect();
        assert!(paths.iter().any(|p| p == "会话截图.png"), "实际：{paths:?}");
    }

    #[test]
    fn 非仓库目录给出可降级错误() {
        let d = tempfile::tempdir().unwrap();
        let g = Git::new(d.path());
        assert!(!g.is_repo());
        assert!(matches!(g.status(), Err(GitError::NotARepo(_))));
    }

    #[test]
    fn diff_与提交信息草稿都能出内容() {
        let d = repo();
        let g = Git::new(d.path());
        std::fs::write(d.path().join("a.txt"), "1\n2\n3\n4\n5\n").unwrap();
        let diff = g.diff(None, false).unwrap();
        assert!(diff.contains("+++ b/a.txt") && diff.contains("+5"), "{diff}");
        let msg = g.generate_commit_message().unwrap();
        assert!(msg.starts_with("fix(a): "), "{msg}");
        assert!(!msg.starts_with('\n'));
        assert!(msg.lines().next().unwrap().chars().count() <= 72);
    }

    #[test]
    fn 重命名记录解析成新增且路径正确() {
        let d = repo();
        let g = Git::new(d.path());
        std::fs::write(d.path().join("old.txt"), "1\n2\n3\n").unwrap();
        g.stage_all().unwrap();
        g.commit("chore: add old.txt").unwrap();
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(d.path())
            .args(["mv", "old.txt", "renamed.txt"])
            .output()
            .unwrap();
        assert!(out.status.success());
        let files = g.status().unwrap().files;
        let r = files.iter().find(|f| f.path == "renamed.txt").expect("重命名后应看到新路径");
        assert_eq!(r.status, "A", "XY=R. → 归到 A；实际 {files:?}");
    }

    #[test]
    fn 上游缺失时_ahead_behind_归零而不是报错() {
        let d = repo();
        let g = Git::new(d.path());
        assert_eq!(g.ahead_behind().unwrap(), (0, 0));
    }
}
