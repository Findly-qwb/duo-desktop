fn main() {
    // 核心（默认）不碰 tauri-build：秒级编译、离线可测；只有 --features shell 才走外壳构建
    #[cfg(feature = "shell")]
    {
        tauri_build::build()
    }
}
