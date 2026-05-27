# Meetuu 云盘

基于 Express + Vue 3 + 阿里云 OSS 的私有文件管理与分享系统。

## 功能

- 文件上传（支持大文件分片上传）
- 文件提取码分享
- 文件过期自动清理
- OSS 内网代理转发
- 会话认证 + CSRF 防护 + 限流

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | Vue 3 + Vite |
| 后端 | Express 4 |
| 存储 | 阿里云 OSS（sql.js 本地数据库） |
| 部署 | PM2 + Nginx（阿里云 SWAS） |

## 环境变量

| 变量名 | 说明 | 必填 |
|--------|------|------|
| `OSS_ACCESS_KEY_ID` | OSS AccessKey ID | ✅ |
| `OSS_ACCESS_KEY_SECRET` | OSS AccessKey Secret | ✅ |
| `OSS_BUCKET_NAME` | OSS Bucket 名称 | ✅ |
| `OSS_REGION` | OSS Region（如 `oss-cn-chengdu`） | ✅ |
| `OSS_ENDPOINT` | OSS Endpoint（如 `oss-cn-chengdu-internal.aliyuncs.com`） | ✅ |
| `CLOUD_DISK_SESSION_SECRET` | Session 签名密钥 | ✅ |
| `CLOUD_DISK_INITIAL_PASSWORD` | 初始密码（首次启动自动生成） | 可选 |
| `CLOUD_DISK_ALLOWED_HOSTS` | 允许的 Host，逗号分隔 | ✅ |
| `PORT` | 监听端口（默认 `3100`） | 可选 |

## 快速开始

```bash
# 安装依赖
npm install

# 构建前端
npm run build

# 启动（开发）
node server.js

# PM2 部署
pm2 start server.js --name cloud-disk
```

## License

Private
