//! checkpoint 通道（PLAN §7.2 第二条通道）：独立 shadow 仓库做逐消息 Revert / Redo。
//!
//! 关键约束（都被下面的测试钉住）：
//! - 只用自己的 `GIT_DIR` + `GIT_WORK_TREE`，**不碰用户仓库的 HEAD / index / reflog / stash**；
//! - 快照走 `write-tree` + `commit-tree` + `update-ref refs/duo/ckpt`，不产生 branch、不动用户提交图；
//! - 恢复按文件粒度 `checkout <oid> -- <paths>`，Redo 就是走到链上下一个快照。
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

/// 快照 ref 名（PLAN §7.2）
pub const CKPT_REF: &str = "refs/duo/ckpt";

#[derive(Debug, thiserror::Error)]
pub enum CheckpointError {
    #[error("系统 git 不可用：{0}")]
    NotInstalled(String),
    #[error("checkpoint git 操作失败（{0}，exit {1}）：{2}")]
    Failed(String, i32, String),
    #[error("快照 {0} 不存在")]
    UnknownOid(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub oid: String,
    /// 该快照相对上一个快照变更的文件（供确认弹窗与 file_snapshots.files）
    pub files: Vec<String>,
    pub at: i64,
    pub label: String,
}

pub struct Checkpoints {
    workdir: PathBuf,
    gitdir: PathBuf,
}

impl Checkpoints {
    /// gitdir = `<root>/<repo-hash>`；root 一般是 `~/.local/share/duo-desktop/ckpt`
    pub fn for_repo(workdir: &Path, root: &Path) -> Self {
        Self { workdir: workdir.to_path_buf(), gitdir: root.join(repo_hash(workdir)) }
    }

    pub fn gitdir(&self) -> &Path {
        &self.gitdir
    }

    fn git(&self, args: &[&str]) -> Result<String, CheckpointError> {
        let out = Command::new("git")
            .env("GIT_DIR", &self.gitdir)
            .env("GIT_WORK_TREE", &self.workdir)
            .arg("-c")
            .arg("core.quotepath=false")
            .arg("-c")
            .arg("commit.gpgsign=false")
            .args(args)
            .output();
        let out = match out {
            Ok(o) => o,
            Err(e) => return Err(CheckpointError::NotInstalled(e.to_string())),
        };
        if !out.status.success() {
            return Err(CheckpointError::Failed(
                args.join(" "),
                out.status.code().unwrap_or(-1),
                String::from_utf8_lossy(&out.stderr).trim().to_string(),
            ));
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    /// 建 shadow 仓库；已存在则幂等。身份写进 shadow config，避免依赖全局配置。
    pub fn init(&self) -> Result<(), CheckpointError> {
        std::fs::create_dir_all(&self.gitdir).map_err(|e| CheckpointError::NotInstalled(e.to_string()))?;
        if self.gitdir.join("HEAD").exists() {
            return Ok(());
        }
        self.git(&["init", "-q"])?;
        self.git(&["config", "user.email", "ckpt@duo.local"])?;
        self.git(&["config", "user.name", "duo checkpoint"])?;
        // 快照不该被用户仓库的 exclude 影响，但要继续忽略 .gitignore（体积），故只显式关掉全局 exclude
        self.git(&["config", "core.excludesFile", "/dev/null"])?;
        Ok(())
    }

    fn head_oid(&self) -> Option<String> {
        self.git(&["rev-parse", "--verify", "--quiet", CKPT_REF]).ok().filter(|s| !s.is_empty())
    }

    /// 打一次快照（写类工具执行前调用）。返回 oid + 相对上一快照的变更文件。
    pub fn snapshot(&self, label: &str) -> Result<Snapshot, CheckpointError> {
        self.init()?;
        let prev = self.head_oid();
        self.git(&["add", "-A"])?;
        let tree = self.git(&["write-tree"])?;
        let mut cmd: Vec<String> = vec!["commit-tree".into(), tree, "-m".into(), label.into()];
        if let Some(p) = &prev {
            cmd.push("-p".into());
            cmd.push(p.clone());
        }
        let argv: Vec<&str> = cmd.iter().map(|s| s.as_str()).collect();
        let oid = self.git(&argv)?;
        self.git(&["update-ref", CKPT_REF, &oid])?;
        let files = self.files_in(&oid, prev.as_deref())?;
        Ok(Snapshot { oid, files, at: now_ms(), label: label.to_string() })
    }

    /// 该快照变更了哪些文件；没有父快照（基线）时用 --root 列全量。
    pub fn files_in(&self, oid: &str, parent: Option<&str>) -> Result<Vec<String>, CheckpointError> {
        let range = parent.map(|p| format!("{p}..{oid}"));
        let mut argv: Vec<&str> = vec!["diff-tree", "--no-commit-id", "--name-only", "-r", "-z"];
        if parent.is_none() {
            argv.push("--root");
        }
        argv.push(range.as_deref().unwrap_or(oid));
        let out = self.git(&argv)?;
        Ok(out.split('\0').filter(|s| !s.is_empty()).map(str::to_string).collect())
    }

    /// 快照链（新 → 旧）
    pub fn list(&self) -> Result<Vec<String>, CheckpointError> {
        let Some(head) = self.head_oid() else { return Ok(Vec::new()) };
        let out = self.git(&["rev-list", &head])?;
        Ok(out.lines().map(str::to_string).collect())
    }

    /// 回滚到某快照（按文件粒度）。paths 为空表示整棵树。
    pub fn restore(&self, oid: &str, paths: &[String]) -> Result<usize, CheckpointError> {
        if self.head_oid().is_none() || !self.has(oid)? {
            return Err(CheckpointError::UnknownOid(oid.to_string()));
        }
        if paths.is_empty() {
            self.git(&["checkout", oid, "--", "."])?;
            Ok(self.files_in(oid, None)?.len().max(1))
        } else {
            let mut argv = vec!["checkout", oid, "--"];
            argv.extend(paths.iter().map(|s| s.as_str()));
            self.git(&argv)?;
            Ok(paths.len())
        }
    }

    /// Redo：链上 `oid` 的下一个快照（即它之后打的那个）
    pub fn redo_target(&self, oid: &str) -> Result<Option<String>, CheckpointError> {
        let chain = self.list()?;
        let pos = chain.iter().position(|o| o == oid);
        match pos {
            Some(i) if i > 0 => Ok(chain.get(i - 1).cloned()),
            _ => Ok(None),
        }
    }

    pub fn has(&self, oid: &str) -> Result<bool, CheckpointError> {
        Ok(self.git(&["cat-file", "-t", oid]).map(|t| t == "commit").unwrap_or(false))
    }

    /// 保留最近 keep 个快照，返回被丢弃的 oid。
    ///
    /// git 的父子链是往**旧**方向走的，光把 ref 往前挪并不能让老快照不可达；
    /// 所以这里把保留段从最旧开始重建一条新链（commit-tree 换父），旧 oid 就此断开，
    /// 对象由 [`gc`] 回收。keep=0 等价于清空 ref。
    pub fn prune(&self, keep: usize) -> Result<Vec<String>, CheckpointError> {
        let chain = self.list()?;
        if chain.len() <= keep {
            return Ok(Vec::new());
        }
        let dropped = chain[keep..].to_vec();
        let mut new_parent: Option<String> = None;
        for oid in chain[..keep].iter().rev() {
            let tree = self.git(&["rev-parse", &format!("{oid}^{{tree}}")])?;
            let msg = self.git(&["log", "-1", "--format=%s", oid])?;
            let mut cmd = vec!["commit-tree".to_string(), tree, "-m".to_string(), msg];
            if let Some(p) = &new_parent {
                cmd.push("-p".into());
                cmd.push(p.clone());
            }
            let argv: Vec<&str> = cmd.iter().map(|x| x.as_str()).collect();
            new_parent = Some(self.git(&argv)?);
        }
        match new_parent {
            Some(h) => self.git(&["update-ref", CKPT_REF, &h])?,
            None => self.git(&["update-ref", "-d", CKPT_REF])?,
        };
        Ok(dropped)
    }

    /// 真正回收对象（宿主空闲时跑，不在回滚路径上做）
    pub fn gc(&self) -> Result<(), CheckpointError> {
        self.git(&["gc", "--prune=now", "--quiet"])?;
        Ok(())
    }

    /// 用户仓库有没有被我们碰过——诊断页与测试都用得上
    pub fn user_repo_untouched(&self, before_head: &str, before_reflog_lines: usize) -> Result<bool, CheckpointError> {
        let head = Command::new("git")
            .arg("-C")
            .arg(&self.workdir)
            .args(["rev-parse", "--verify", "HEAD"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();
        let reflog = Command::new("git")
            .arg("-C")
            .arg(&self.workdir)
            .args(["reflog", "show", "--all", "--oneline"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).lines().count())
            .unwrap_or(0);
        Ok(head == before_head && reflog == before_reflog_lines)
    }
}

/// FNV-1a 64：跨进程稳定的目录指纹（std 的 Hasher 带随机种子，不能当目录名）
fn repo_hash(p: &Path) -> String {
    let s = p.to_string_lossy();
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100_0000_01b3);
    }
    format!("{h:016x}")
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command as C;

    fn sh(dir: &Path, args: &[&str]) {
        assert!(C::new("git").arg("-C").arg(dir).args(args).output().map(|o| o.status.success()).unwrap_or(false), "git {args:?}");
    }

    fn fixture() -> (tempfile::TempDir, tempfile::TempDir, tempfile::TempDir) {
        let wd = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let origin = tempfile::tempdir().unwrap();
        sh(wd.path(), &["init", "-q", "-b", "main"]);
        sh(wd.path(), &["config", "user.email", "t@duo.local"]);
        sh(wd.path(), &["config", "user.name", "t"]);
        std::fs::write(wd.path().join("a.txt"), "v1\n").unwrap();
        sh(wd.path(), &["add", "-A"]);
        sh(wd.path(), &["commit", "-qm", "init"]);
        // 一个真实 origin + upstream，方便断言 reflog 增长
        sh(origin.path(), &["init", "-q", "--bare"]);
        (wd, root, origin)
    }

    fn user_state(wd: &Path) -> (String, usize) {
        let head = C::new("git").arg("-C").arg(wd).args(["rev-parse", "HEAD"]).output().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
        let reflog = C::new("git").arg("-C").arg(wd).args(["reflog", "show", "--all", "--oneline"]).output().map(|o| String::from_utf8_lossy(&o.stdout).lines().count()).unwrap_or(0);
        (head, reflog)
    }

    #[test]
    fn 快照能建链并列出() {
        let (wd, root, _) = fixture();
        let ck = Checkpoints::for_repo(wd.path(), root.path());
        let s1 = ck.snapshot("Turn 1 前").unwrap();
        std::fs::write(wd.path().join("b.txt"), "new\n").unwrap();
        let s2 = ck.snapshot("Turn 2 前").unwrap();
        assert_eq!(s2.files, vec!["b.txt".to_string()], "第二个快照应只含 b.txt，实际 {:?}", s2.files);
        let chain = ck.list().unwrap();
        assert_eq!(chain.len(), 2);
        assert_eq!(chain[0], s2.oid, "list 应新→旧");
        assert_eq!(ck.redo_target(&s1.oid).unwrap().as_deref(), Some(s2.oid.as_str()));
        assert_eq!(ck.redo_target(&s2.oid).unwrap(), None);
    }

    #[test]
    fn 按文件粒度回滚且用户仓库_head_reflog_不变() {
        let (wd, root, _) = fixture();
        let ck = Checkpoints::for_repo(wd.path(), root.path());
        let before = user_state(wd.path());
        let snap = ck.snapshot("基线").unwrap();
        std::fs::write(wd.path().join("a.txt"), "被 agent 改坏了\n").unwrap();
        std::fs::write(wd.path().join("keep.txt"), "别动我\n").unwrap();
        let n = ck.restore(&snap.oid, &["a.txt".to_string()]).unwrap();
        assert_eq!(n, 1);
        assert_eq!(std::fs::read_to_string(wd.path().join("a.txt")).unwrap(), "v1\n", "a.txt 应回到快照内容");
        assert!(wd.path().join("keep.txt").exists(), "未列入 paths 的文件不该被删");
        let after = user_state(wd.path());
        assert_eq!(after.0, before.0, "用户 HEAD 不能动");
        assert_eq!(after.1, before.1, "用户 reflog 不能多条目");
        assert!(ck.user_repo_untouched(&before.0, before.1).unwrap());
        assert!(!wd.path().join(".git").join("refs").join("duo").exists(), "ckpt ref 只能长在 shadow 仓库里");
    }

    #[test]
    fn 未知_oid_回滚报错而不是静默() {
        let (wd, root, _) = fixture();
        let ck = Checkpoints::for_repo(wd.path(), root.path());
        ck.init().unwrap();
        let e = ck.restore("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", &["a.txt".into()]).unwrap_err();
        assert!(matches!(e, CheckpointError::UnknownOid(_)), "{e:?}");
    }

    #[test]
    fn 保留策略只砍链尾并能回收对象() {
        let (wd, root, _) = fixture();
        let ck = Checkpoints::for_repo(wd.path(), root.path());
        let mut oids = Vec::new();
        for i in 0..5 {
            std::fs::write(wd.path().join(format!("f{i}.txt")), format!("x{i}\n")).unwrap();
            oids.push(ck.snapshot(&format!("s{i}")).unwrap().oid);
        }
        assert_eq!(ck.list().unwrap().len(), 5);
        let dropped = ck.prune(2).unwrap();
        assert_eq!(dropped.len(), 3);
        assert_eq!(dropped[0], oids[2], "先丢最老的");
        let kept = ck.list().unwrap();
        assert_eq!(kept.len(), 2, "链长应真的缩到 keep");
        // 重建后 oid 变了，但内容必须等价：最新快照仍能看到 f4.txt
        assert!(ck.files_in(&kept[0], None).unwrap().contains(&"f4.txt".to_string()), "重建链后内容应等价");
        ck.gc().unwrap();
        assert!(!ck.has(&dropped[0]).unwrap(), "gc 后老快照对象应已不可用");
    }

    #[test]
    fn 同一项目复用同一_shadow_目录且幂等() {
        let (wd, root, _) = fixture();
        let a = Checkpoints::for_repo(wd.path(), root.path());
        a.init().unwrap();
        a.init().unwrap();
        let b = Checkpoints::for_repo(wd.path(), root.path());
        assert_eq!(a.gitdir(), b.gitdir());
        assert_ne!(Checkpoints::for_repo(Path::new("/tmp/other"), root.path()).gitdir(), a.gitdir());
    }

    /// 性能尖刺（PLAN §7.2 [v2.1]）：连续快照的 git 冷启动开销。
    /// 默认 ignore，跑法：`cargo test -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn 压测_1200_文件连续_20_次快照墙钟() {
        let (wd, root, _) = fixture();
        let big = tempfile::tempdir().unwrap();
        sh(big.path(), &["init", "-q", "-b", "main"]);
        for d in 0..12 {
            std::fs::create_dir_all(big.path().join(format!("d{d}"))).unwrap();
            for f in 0..100 {
                std::fs::write(big.path().join(format!("d{d}/f{f}.txt")), "line\nline2\n").unwrap();
            }
        }
        sh(big.path(), &["add", "-A"]);
        let ck = Checkpoints::for_repo(big.path(), root.path());
        let t0 = std::time::Instant::now();
        for i in 0..20 {
            std::fs::write(big.path().join("d0/f0.txt"), format!("改一次 {i}\n")).unwrap();
            ck.snapshot(&format!("s{i}")).unwrap();
        }
        let secs = t0.elapsed().as_secs_f64();
        println!("1200 文件 × 20 次快照：{secs:.2}s（平均 {:.0}ms/次）", secs * 1000.0 / 20.0);
        assert!(secs < 60.0, "超过 60s 说明需要去抖/合并（PLAN §7.2）");
        let _ = wd;
    }
}
