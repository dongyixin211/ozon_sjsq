# 客户端自动更新发布

1. 同时备份更新私钥和密码文件：`%APPDATA%\com.codex.ozon-sjsq\updater-signing.key`、`%APPDATA%\com.codex.ozon-sjsq\updater-signing.password`。任意一个丢失后，已安装客户端都无法验证新版本。
2. 同步修改 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 中的版本号。
3. 运行 `build-windows-exe.bat`。构建脚本会使用上述私钥生成 NSIS 更新包及 `.sig` 文件。
4. 将 `src-tauri/target/release/bundle/nsis` 中的更新压缩包上传到长期可访问的 HTTPS 地址。
5. 生成更新清单：

```powershell
npm run updater:manifest -- --version 1.2.3 --url https://下载地址/Ozon.SJSQ_1.2.3_x64-setup.nsis.zip --signature src-tauri/target/release/bundle/nsis/Ozon.SJSQ_1.2.3_x64-setup.nsis.zip.sig --notes "更新说明"
```

关键版本追加 `--required`，客户端检测到后会立即下载安装并重启；普通版本允许用户暂缓。

6. 部署服务端后，确认 `/updates/latest.json` 返回新清单。不要把私钥提交到项目或上传到服务器。
