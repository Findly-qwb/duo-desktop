//! 文件系统服务（PLAN §6.8，Duo 独有：rpi 不提供）
//!
//! - 后台扫描 + `.gitignore` / 全局 ignore / `.git/info/exclude` 解析
//! - 深度与文件数上限、进度回调（对应 `scan_progress` 事件）
//! - 目录树懒加载、预览与「加入上下文」的注入预算（单文件 256KB / 8K tokens，超限截断并落盘给路径引用）
use serde::{Deserialize, Serialize};
use globset::{Glob, GlobMatcher};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

/// 默认上限与 PLAN §6.8 / 设置页文案保持一致
#[derive(Debug, Clone)]
pub struct ScanLimits {
    pub max_files: usize,
    pub max_depth: u32,
    pub ignore_patterns: Vec<String>,
}

impl Default for ScanLimits {
    fn default() -> Self {
        Self { max_files: 50_000, max_depth: 12, ignore_patterns: Vec::new() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    pub is_dir: bool,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    pub project: String,
    pub files: Vec<FileEntry>,
    pub scanned: usize,
    pub total: usize,
    /// 命中上限即停止（UI 要提示「超出即停止并提示」）
    pub truncated: bool,
    pub phase: ScanPhase,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ScanPhase {
    Walking,
    Filtering,
    Done,
    Stopped,
}

#[derive(Debug, thiserror::Error)]
pub enum FsError {
    #[error("读不了 {0}：{1}")]
    Io(String, String),
    #[error("路径越出工作区，已拒绝：{0}")]
    OutsideWorkspace(String),
    #[error("看起来是二进制文件：{0}")]
    Binary(String),
}

/// gitignore 的一个可用子集：注释、`!` 取反、目录尾斜杠、前导 `/` 锚定、`**`。
/// 完整 gitignore 语义（negation 优先级、父目录被忽略后不再看子规则等）在边界上会不一致，
/// 这里按「后出现的规则覆盖先前」实现，够用且可预测。
#[derive(Default)]
pub struct Ignore {
    rules: Vec<(GlobMatcher, bool, bool)>, // (matcher, 是否取反, 是否只匹配目录)
}

impl Ignore {
    pub fn new() -> Self {
        Self::default()
    }

    /// 根目录 .gitignore
    pub fn add_gitignore(&mut self, text: &str) {
        self.add_scoped("", text);
    }

    /// 解析位于 `dir`（相对工作区，"" 表示根）的 .gitignore：规则只在该子树内生效。
    pub fn add_scoped(&mut self, dir: &str, text: &str) {
        let base = {
            let d = dir.trim_end_matches('/');
            if d.is_empty() { String::new() } else { format!("{d}/") }
        };
        for line in text.lines() {
            let mut pat = line.trim_end();
            if pat.is_empty() || pat.starts_with('#') {
                continue;
            }
            let neg = pat.starts_with('!');
            if neg {
                pat = &pat[1..];
            }
            let dir_only = pat.ends_with('/');
            pat = pat.trim_end_matches('/');
            if pat.is_empty() {
                continue;
            }
            let anchored = pat.contains('/');
            let pat = pat.trim_start_matches('/');
            // 带 / 或含 ** 的模式按字面锚定；裸文件名在任意层级生效
            let mut globs: Vec<String> = if anchored || pat.contains("**") {
                vec![format!("{base}{pat}")]
            } else {
                vec![format!("{base}{pat}"), format!("{base}**/{pat}")]
            };
            if !base.is_empty() && !anchored {
                globs.push(format!("**/{base}{pat}"));
            }
            for g in globs {
                for cand in [g.clone(), format!("{g}/**")] {
                    if let Ok(glob) = Glob::new(&cand) {
                        self.rules.push((glob.compile_matcher(), neg, dir_only));
                    }
                }
            }
        }
    }

    pub fn is_ignored(&self, rel: &str, is_dir: bool) -> bool {
        let mut hit = false;
        for (m, neg, dir_only) in &self.rules {
            if *dir_only && !is_dir && !m.is_match(rel) {
                continue;
            }
            if m.is_match(rel) {
                hit = !*neg;
            }
        }
        hit
    }

    pub fn rule_count(&self) -> usize {
        self.rules.len()
    }
}

pub struct Fs {
    root: PathBuf,
}

impl Fs {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// 绝对路径 → 相对工作区路径；越界直接拒（工具与前端都走这里）
    fn rel(&self, p: &Path) -> Result<String, FsError> {
        let canon = if p.is_absolute() { p.to_path_buf() } else { self.root.join(p) };
        let rootc = std::fs::canonicalize(&self.root).unwrap_or_else(|_| self.root.clone());
        let pc = std::fs::canonicalize(&canon).unwrap_or_else(|_| canon.clone());
        match pc.strip_prefix(&rootc) {
            Ok(r) => Ok(r.to_string_lossy().replace('\\', "/")),
            Err(_) => Err(FsError::OutsideWorkspace(p.to_string_lossy().to_string())),
        }
    }

    /// 读 .gitignore 链：全局 core.excludesFile → 仓库 .git/info/exclude → 各级 .gitignore
    pub fn load_ignore(&self, extra: &[String]) -> Ignore {
        let mut ig = Ignore::new();
        if let Ok(out) = std::process::Command::new("git")
            .arg("-C")
            .arg(&self.root)
            .args(["config", "--get", "core.excludesFile"])
            .output()
        {
            let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !p.is_empty() {
                if let Ok(t) = std::fs::read_to_string(shellexpand(&p)) {
                    ig.add_gitignore(&t);
                }
            }
        }
        if let Ok(t) = std::fs::read_to_string(self.root.join(".git/info/exclude")) {
            ig.add_gitignore(&t);
        }
        // 各级 .gitignore 由 scan 在下降时按目录作用域加载（见 add_scoped）
        ig.add_gitignore(&extra.join("\n"));
        ig
    }

    /// 全量扫描。`on_progress` 每 500 个条目回调一次（宿主据此发 scan_progress）。
    pub fn scan(&self, limits: &ScanLimits, on_progress: &mut dyn FnMut(&ScanReport)) -> Result<ScanReport, FsError> {
        let mut ig = self.load_ignore(&limits.ignore_patterns);
        // 扫描器自身永远忽略 .git 与常见垃圾目录（gitignore 通常不管 .git）
        ig.add_gitignore(".git/\n.duo/cache/\n");
        let mut files: Vec<FileEntry> = Vec::new();
        let mut scanned = 0usize;
        let mut truncated = false;
        let mut stack: Vec<(PathBuf, u32, String)> = vec![(self.root.clone(), 0, String::new())];
        while let Some((dir, depth, rel_dir)) = stack.pop() {
            if depth > limits.max_depth {
                continue;
            }
            // 进入新目录先看它有没有 .gitignore（规则只作用于该子树）
            if let Ok(t) = std::fs::read_to_string(dir.join(".gitignore")) {
                ig.add_scoped(&rel_dir, &t);
            }
            let Ok(rd) = std::fs::read_dir(&dir) else { continue };
            for entry in rd.flatten() {
                let path = entry.path();
                let rel = match self.rel(&path) {
                    Ok(r) => r,
                    Err(_) => continue,
                };
                let is_dir = path.is_dir();
                scanned += 1;
                if ig.is_ignored(&rel, is_dir) {
                    continue;
                }
                if files.len() >= limits.max_files {
                    truncated = true;
                    on_progress(&self.report(&files, scanned, truncated, ScanPhase::Stopped));
                    return Ok(self.report(&files, scanned, truncated, ScanPhase::Stopped));
                }
                if is_dir {
                    stack.push((path.clone(), depth + 1, rel.clone()));
                    files.push(FileEntry { path: rel, is_dir: true, bytes: 0 });
                } else {
                    let bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);
                    files.push(FileEntry { path: rel, is_dir: false, bytes });
                }
                if scanned.is_multiple_of(500) {
                    on_progress(&self.report(&files, scanned, false, ScanPhase::Walking));
                }
            }
        }
        let total = files.len();
        let rep = self.report(&files, scanned, truncated, ScanPhase::Done);
        let mut rep = rep;
        rep.total = total;
        on_progress(&rep);
        Ok(rep)
    }

    fn report(&self, files: &[FileEntry], scanned: usize, truncated: bool, phase: ScanPhase) -> ScanReport {
        ScanReport {
            project: self.root.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
            files: files.to_vec(),
            scanned,
            total: files.len(),
            truncated,
            phase,
        }
    }

    /// 目录树懒加载：只列一层，目录在前（右栏文件树点开一个问一个）
    pub fn tree(&self, dir: &str) -> Result<Vec<FileEntry>, FsError> {
        let abs = self.root.join(dir);
        let _ = self.rel(&abs)?;
        let rd = std::fs::read_dir(&abs).map_err(|e| FsError::Io(dir.into(), e.to_string()))?;
        let mut out: Vec<FileEntry> = Vec::new();
        for e in rd.flatten() {
            let rel = self.rel(&e.path())?;
            let is_dir = e.path().is_dir();
            out.push(FileEntry { path: rel, is_dir, bytes: if is_dir { 0 } else { e.metadata().map(|m| m.len()).unwrap_or(0) } });
        }
        out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.path.cmp(&b.path)));
        Ok(out)
    }

    /// 文件名搜索（命令面板 ⌘P 那条），大小写不敏感
    pub fn search(&self, index: &[FileEntry], query: &str, limit: usize) -> Vec<String> {
        let q = query.to_lowercase();
        index
            .iter()
            .filter(|f| !f.is_dir && (q.is_empty() || f.path.to_lowercase().contains(&q)))
            .map(|f| f.path.clone())
            .take(limit)
            .collect()
    }

    /// 预览 / 注入用：单文件字节上限 + token 预算，超限截断并给落盘引用
    pub fn preview(&self, path: &str, max_bytes: u64, cache_dir: &Path) -> Result<Preview, FsError> {
        let rel = self.rel(&self.root.join(path))?;
        let abs = self.root.join(&rel);
        let bytes = std::fs::read(&abs).map_err(|e| FsError::Io(rel.clone(), e.to_string()))?;
        let is_bin = bytes.iter().take(8000).any(|&b| b == 0);
        if is_bin {
            return Err(FsError::Binary(rel));
        }
        let full = String::from_utf8_lossy(&bytes).to_string();
        let tokens = estimate_tokens(&full);
        if (bytes.len() as u64) <= max_bytes {
            return Ok(Preview { path: rel, text: full, truncated: false, spill_path: None, tokens });
        }
        // 截断 + 原文落盘，给路径引用（PLAN：避免污染上下文）
        std::fs::create_dir_all(cache_dir).map_err(|e| FsError::Io(cache_dir.display().to_string(), e.to_string()))?;
        let cut = full.chars().take(max_bytes as usize).collect::<String>();
        let spill = cache_dir.join(format!("{}.{}", sanitize(&rel), "txt"));
        std::fs::write(&spill, &full).map_err(|e| FsError::Io(spill.display().to_string(), e.to_string()))?;
        Ok(Preview {
            path: rel,
            text: cut,
            truncated: true,
            spill_path: Some(spill.to_string_lossy().to_string()),
            tokens,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub path: String,
    pub text: String,
    pub truncated: bool,
    pub spill_path: Option<String>,
    pub tokens: u32,
}

/// 粗略 token 估算（PLAN §6.3：本地按字符/近似 tokenizer 统计，仅估算）：
/// CJK 约 1 字 1 token，其余按 4 字符 1 token。
pub fn estimate_tokens(s: &str) -> u32 {
    let mut cjk = 0u32;
    let mut other = 0u32;
    for c in s.chars() {
        if ('\u{3400}'..='\u{9fff}').contains(&c) {
            cjk += 1;
        } else {
            other += 1;
        }
    }
    cjk + other / 4
}

fn sanitize(p: &str) -> String {
    p.chars().map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect()
}

/// `~/x` 展开（core.excludesFile 常带 ~）
fn shellexpand(p: &str) -> PathBuf {
    if let Some(rest) = p.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(p)
}

/// 去重后的文件列表（扫描里目录/文件混排，DB 落库前给上层用）
pub fn unique_paths(entries: &[FileEntry]) -> Vec<String> {
    let set: BTreeSet<String> = entries.iter().map(|e| e.path.clone()).collect();
    set.into_iter().collect()
}

#[cfg(test)]
mod tests {

    use super::*;
    use std::process::Command as C;

    fn tree_fixture() -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        let w = d.path();
        std::fs::create_dir_all(w.join("src")).unwrap();
        std::fs::create_dir_all(w.join("dist")).unwrap();
        std::fs::create_dir_all(w.join("node_modules/pkg")).unwrap();
        std::fs::write(w.join(".gitignore"), "dist/\nnode_modules/\n*.log\n!keep.log\n").unwrap();
        std::fs::write(w.join("src/main.rs"), "fn main() {}\n").unwrap();
        std::fs::write(w.join("src/app.css"), ".a{}\n").unwrap();
        std::fs::write(w.join("dist/bundle.js"), "x".repeat(50)).unwrap();
        std::fs::write(w.join("node_modules/pkg/index.js"), "y".repeat(10)).unwrap();
        std::fs::write(w.join("debug.log"), "boom\n").unwrap();
        std::fs::write(w.join("keep.log"), "keep\n").unwrap();
        C::new("git").arg("-C").arg(w).args(["init", "-q"]).output().ok();
        d
    }

    #[test]
    fn gitignore_生效且取反规则能翻回来() {
        let d = tree_fixture();
        let fs = Fs::new(d.path());
        let rep = fs.scan(&ScanLimits::default(), &mut |_| {}).unwrap();
        let paths: Vec<String> = rep.files.into_iter().filter(|f| !f.is_dir).map(|f| f.path).collect();
        assert!(paths.contains(&"src/main.rs".to_string()), "{paths:?}");
        assert!(paths.contains(&"keep.log".to_string()), "!keep.log 应翻回未忽略");
        assert!(!paths.iter().any(|p| p.starts_with("dist/")), "dist/ 该被忽略");
        assert!(!paths.iter().any(|p| p.starts_with("node_modules/")), "node_modules 该被忽略");
        assert!(!paths.contains(&"debug.log".to_string()), "*.log 该被忽略");
    }

    #[test]
    fn 扫描进度会回调并且上限能熔断() {
        let d = tree_fixture();
        let fs = Fs::new(d.path());
        let mut calls = 0;
        fs.scan(&ScanLimits::default(), &mut |_| calls += 1).unwrap();
        assert!(calls >= 1, "至少要有一次 done 回调");
        let rep = fs.scan(&ScanLimits { max_files: 1, ..Default::default() }, &mut |_| {}).unwrap();
        assert!(rep.truncated, "命中 max_files 应标记 truncated");
        assert_eq!(rep.phase, ScanPhase::Stopped);
    }

    #[test]
    fn 深度上限能挡住深层目录() {
        let d = tempfile::tempdir().unwrap();
        let deep = d.path().join("a/b/c/d/e");
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(deep.join("x.txt"), "1\n").unwrap();
        let fs = Fs::new(d.path());
        let shallow = fs.scan(&ScanLimits { max_depth: 2, ..Default::default() }, &mut |_| {}).unwrap();
        assert!(!shallow.files.iter().any(|f| f.path.ends_with("x.txt")), "深度 2 不该看到 x.txt");
        let full = fs.scan(&ScanLimits { max_depth: 12, ..Default::default() }, &mut |_| {}).unwrap();
        assert!(full.files.iter().any(|f| f.path.ends_with("x.txt")));
    }

    #[test]
    fn 子目录的_gitignore_只管自己子树() {
        let d = tempfile::tempdir().unwrap();
        let w = d.path();
        std::fs::create_dir_all(w.join("assets")).unwrap();
        std::fs::write(w.join(".gitignore"), "").unwrap();
        std::fs::write(w.join("assets/.gitignore"), "*.png\n").unwrap();
        std::fs::write(w.join("assets/logo.png"), "x\n").unwrap();
        std::fs::write(w.join("top.png"), "y\n").unwrap();
        let fs = Fs::new(w);
        let rep = fs.scan(&ScanLimits::default(), &mut |_| {}).unwrap();
        let paths: Vec<String> = rep.files.iter().filter(|f| !f.is_dir).map(|f| f.path.clone()).collect();
        assert!(!paths.contains(&"assets/logo.png".to_string()), "assets 内的 png 应被它自己的 .gitignore 挡掉：{paths:?}");
        assert!(paths.contains(&"top.png".to_string()), "规则不该外溢到根目录：{paths:?}");
    }

    #[test]
    fn 目录树只列一层且目录在前() {
        let d = tree_fixture();
        let fs = Fs::new(d.path());
        let t = fs.tree(".").unwrap();
        assert!(t.iter().any(|e| e.path == "src" && e.is_dir), "{:?}", t);
        assert!(!t.iter().any(|e| e.path.ends_with("main.rs")), "不该出现孙子条目");
        let first_dir = t.iter().position(|e| e.is_dir).unwrap();
        let last_file = t.iter().rposition(|e| !e.is_dir).unwrap();
        assert!(first_dir < last_file, "目录应排在文件前");
    }

    #[test]
    fn 越出工作区的路径被拒绝() {
        let d = tree_fixture();
        let fs = Fs::new(d.path());
        assert!(matches!(fs.tree("../"), Err(FsError::OutsideWorkspace(_))) || fs.rel(Path::new("..")).is_err());
        let outside = fs.root().join("..").join("etc");
        assert!(matches!(fs.rel(&outside), Err(FsError::OutsideWorkspace(_))));
    }

    #[test]
    fn 预览超限会截断并落盘给引用() {
        let d = tree_fixture();
        let cache = tempfile::tempdir().unwrap();
        let fs = Fs::new(d.path());
        std::fs::write(d.path().join("big.txt"), "z".repeat(500)).unwrap();
        let small = fs.preview("src/main.rs", 4096, cache.path()).unwrap();
        assert!(!small.truncated);
        let big = fs.preview("big.txt", 100, cache.path()).unwrap();
        assert!(big.truncated);
        assert_eq!(big.text.chars().count(), 100);
        let spill = big.spill_path.clone().expect("应给出落盘路径");
        assert_eq!(std::fs::read_to_string(&spill).unwrap().len(), 500, "原文应完整落盘");
        assert!(fs.preview("dist/bundle.js", 4096, cache.path()).is_ok(), "显式读取不受 ignore 限制");
    }

    #[test]
    fn 二进制文件不返回文本() {
        let d = tree_fixture();
        let fs = Fs::new(d.path());
        std::fs::write(d.path().join("bin.dat"), [0u8, 1, 2, 0, 3]).unwrap();
        assert!(matches!(fs.preview("bin.dat", 4096, d.path()), Err(FsError::Binary(_))));
    }

    #[test]
    fn token_估算对中英混排有区分度() {
        assert_eq!(estimate_tokens(""), 0);
        assert!(estimate_tokens("给 SessionStore 加 SQLite 持久化") > 8);
        assert!(estimate_tokens(&"a".repeat(400)) < estimate_tokens(&"中".repeat(400)));
    }

    #[test]
    fn 搜索大小写不敏感并受上限约束() {
        let d = tree_fixture();
        let fs = Fs::new(d.path());
        let rep = fs.scan(&ScanLimits::default(), &mut |_| {}).unwrap();
        assert_eq!(fs.search(&rep.files, "MAIN", 10), vec!["src/main.rs".to_string()]);
        assert_eq!(fs.search(&rep.files, "", 1).len(), 1);
        assert!(fs.search(&rep.files, "不存在的名字", 10).is_empty());
    }
}
