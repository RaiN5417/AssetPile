# AssetPile｜材栈 构建与推送发布交接文档 (Release & Handoff)

本文档记录了 AssetPile｜材栈 的本地构建、代码检查、版本发布与自动化推送的标准操作流程（SOP）。

---

## 1. 架构与技术栈速览

- **前端架构**：React 18 + TypeScript + Vite + 原生 CSS（位于 `apps/desktop/`）
- **桌面端核心**：Tauri 2.x + Rust 多 crate 工作区（位于 `apps/desktop/src-tauri/` 与 `crates/`）
- **CI / CD 流水线**：GitHub Actions（位于 `.github/workflows/`）

---

## 2. 本地开发与构建

### 2.1 依赖准备
- **Rust**（stable，包含 `rustfmt` 与 `clippy`）
- **Node.js 22.13+**（pnpm 11 需要）
- **Tauri Windows 前置环境**（WebView2 Runtime、MSVC C++ Build Tools）

### 2.2 启动本地开发
```bash
# 安装依赖
pnpm install --dir apps/desktop

# 启动前端 Vite 开发服务器（支持热更新）与 Tauri 调试窗口
pnpm --dir apps/desktop tauri dev
```

### 2.3 本地代码自检（提交 PR 或发布前必跑）
```bash
# 1. Rust 格式化检查
cargo fmt --all -- --check

# 2. Rust Clippy 静态检查
cargo clippy --workspace --all-targets -- -D warnings

# 3. Rust 单元与集成测试
cargo test --workspace

# 4. 前端代码检查与生产打包
pnpm --dir apps/desktop lint
pnpm --dir apps/desktop typecheck
pnpm --dir apps/desktop build
```

---

## 3. GitHub 自动化发布流程（CI/CD Release）

仓库已配置好 [`.github/workflows/release.yml`](.github/workflows/release.yml)。当推送匹配 `v*.*.*` 格式的 Git Tag 时，GitHub Actions 会全自动执行：
1. 编译 Windows NSIS 安装包（`AssetPile｜材栈_*_x64-setup.exe`）；
2. 打包便携绿色版压缩包（`AssetPile-*-x64-portable.zip`，内嵌 `data/` 隔离数据目录）；
3. 计算并输出 SHA256 校验文件（`SHA256SUMS.txt`）；
4. 自动创建并发布 GitHub Release，将上述产物上传供用户直接下载。

### 3.1 发布步骤（SOP）

#### 步骤 1：确认并同步版本号
以下四个配置文件必须保持版本号一致：
- [`Cargo.toml`](Cargo.toml)（`[workspace.package]` 下的 `version`）
- [`Cargo.lock`](Cargo.lock)（对应的 7 个内部 crate 版本）
- [`apps/desktop/package.json`](apps/desktop/package.json)（`version` 字段）
- [`apps/desktop/src-tauri/tauri.conf.json`](apps/desktop/src-tauri/tauri.conf.json)（`version` 字段）

#### 步骤 2：提交代码并打 Tag
```bash
# 提交变更
git add .
git commit -m "chore: release v0.2.5"

# 推送 main 分支
git push origin main

# 创建对应版本的轻量或注释 Tag
git tag v0.2.5

# 推送 Tag 到远程（触发 release.yml 流水线）
git push origin v0.2.5
```

#### 步骤 3：监控发布状态
推送后访问 GitHub 仓库的 **Actions** 标签页，查看 `Release` 任务运行日志；完成后前往 **Releases** 页面即可看到新鲜生成的安装包和绿色版压缩包。

---

## 4. Microsoft Store (MSIX) 商店包构建

如果需要为微软合作伙伴中心（Partner Center）生成提交专用的 `.msixbundle` 商店包：

```bash
cd apps/desktop
pnpm run tauri:windows:build
```

- **输出路径**：`target/msix/AssetPile｜材栈_<version>.0.msixbundle`
- **详细说明与 Partner Center 注意事项**：详见 [`docs/microsoft-store.md`](docs/microsoft-store.md)。

---

## 5. 关键文件与职责索引

| 路径 | 职责说明 |
|---|---|
| `.github/workflows/ci.yml` | 自动化持续集成：PR 和 main 分支提交时的代码质量与编译检查 |
| `.github/workflows/release.yml` | 自动化发布流水线：Tag 触发构建安装包、便携包并发布 GitHub Release |
| `apps/desktop/scripts/build-msix.mjs` | Windows MSIX 打包脚本包装器，处理工作区路径与 Windows 字符兼容 |
| `docs/microsoft-store.md` | 微软应用商店提交流程、凭据配置与排坑记录 |
| `apps/desktop/src/theme/context.tsx` | 主题提供者与状态管理（系统跟随、纯白、暖白、深色） |
| `apps/desktop/src/styles.css` | 核心设计变量、响应式断点与界面样式规范 |
