# Windows 一键打包脚本说明

## 使用方法

双击项目根目录下的：

```text
build-windows-exe.bat
```

脚本会自动：

1. 切换到项目根目录。
2. 检查 Node.js 和 npm。
3. 如果没有 `node_modules`，自动执行 `npm install`。
4. 执行 `npm run tauri:build:windows`。
5. 打包成功后打开安装包目录。

注意：脚本窗口里的提示是英文，这是为了避免 Windows 批处理在不同系统编码下把中文提示解析成乱码命令。

## 打包结果位置

默认 EXE 安装包会生成在：

```text
src-tauri\target\release\bundle\nsis\
```

脚本完成后会自动打开这个目录，并在窗口里打印最新 EXE 文件路径。

## 常见失败原因

- 没有安装 Node.js。
- 没有安装 Rust 或 Tauri Windows 打包依赖。
- 网络异常，依赖下载失败。
- 代码存在编译错误。

失败时不要直接关窗口，先看窗口上方的错误信息。

如果只是想检查脚本能不能找到 Node.js 和 npm，可以在项目目录中运行：

```bat
build-windows-exe.bat --check
```

这个命令只检查环境，不会真正打包。
