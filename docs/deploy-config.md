# 正式环境部署配置

## 服务器信息

| 项目 | 值 |
|------|-----|
| SSH 目标 | `root@101.32.167.34` |
| 远程目录 | `/opt/ozon-sjsq-cloud` |
| SSH 私钥 | `C:\Users\董宜新\.ssh\ozon_sjsq_tencent_deploy_ed25519` |
| 线上运行目录 | `/opt/ozon-sjsq-cloud/server` |
| systemd 服务名 | `ozon-sjsq-cloud` |

## 部署脚本

- **项目通用上传脚本**: `deploy-cloud-server.ps1`（需传入 `-SshTarget` 参数）
  - 默认远程目录: `/opt/ozon-sjsq-cloud`
  - 上传时会排除 `server/.env`，避免覆盖线上配置
- **部署辅助脚本**: `C:\Users\董宜新\.codex\skills\ozon-sjsq-deploy\scripts\deploy-ozon-sjsq.ps1`

## 配置文件

| 环境 | 路径 |
|------|------|
| 线上 `.env` | `/opt/ozon-sjsq-cloud/server/.env` |
| 本地开发 `.env` | `server/.env` |

> `.env` 文件含密码、令牌等敏感配置，不应提交到版本控制或打印内容。

## systemd 服务

服务单元定义: `deploy/cloud-server/ozon-sjsq-cloud.service`

```
WorkingDirectory=/opt/ozon-sjsq-cloud/server
ExecStart=node dist/src/index.js
```

## 相关文档

- `deploy/cloud-server/README.md`
- `docs/aliyun-deploy-runbook.md`
