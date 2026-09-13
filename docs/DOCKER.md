# Docker 部署指南

Writide `v0.2.0` 提供 `linux/amd64` 和 `linux/arm64` 镜像。前者适用于常见 x86-64 电脑、NAS 和服务器，后者适用于 64 位 ARMv8/AArch64；32 位 ARMv7 不支持。本指南面向单用户、可信设备和可信网络测试；它不是多用户云服务方案。

## 先判断你的设备

在 Linux、NAS 或家庭服务器终端执行：

```bash
uname -m
docker version
docker compose version
```

`x86_64` 或 `amd64` 对应 `linux/amd64`，`aarch64` 或 `arm64` 对应 `linux/arm64`。如果没有 Docker，请按设备系统使用 [Docker Engine 官方安装说明](https://docs.docker.com/engine/install/)；Windows/macOS 通常安装 [Docker Desktop](https://docs.docker.com/desktop/)，Linux 还需要 [Compose 插件](https://docs.docker.com/compose/install/)。不要从不明脚本安装 Docker。

## 方法一：直接拉取，推荐

GitHub Actions 已构建并启动检查公开镜像。先取得 Compose 配置：

```bash
git clone --branch v0.2.0 https://github.com/shiranzby/Writide.git
cd Writide
docker compose pull
docker compose up -d --no-build
docker compose ps
docker compose logs --tail=100
```

浏览器打开 `http://Docker设备地址:5173/`。默认账号为 `admin`，默认密码为 `password`；登录后立即打开“设置 → 访问安全”，修改为至少 8 个字符的新密码。新密码只以认证摘要保存在 `/data/.writide-access.json`，不会保存明文。

简单局域网部署不需要 `.env`。需要限制监听地址、固定反向代理域名或预设初始密码时，复制 `.env.example` 为 `.env` 后修改。显式设置的 `WRITIDE_ORIGIN` 必须是浏览器实际访问的完整来源；留空时服务按每次请求的 Host/Origin 做同源检查。

不使用 Compose 时，可先检查镜像能否直接拉取：

```bash
docker pull ghcr.io/shiranzby/writide:0.2.0
```

### GHCR 无法访问时离线加载

从 [v0.2.0 Releases](https://github.com/shiranzby/Writide/releases/tag/v0.2.0) 下载与设备匹配的镜像和 `.sha256` 文件：x86-64 选择 `linux-amd64`，ARMv8 选择 `linux-arm64`。

x86-64/amd64 设备执行：

```bash
sha256sum -c Writide-v0.2.0-linux-amd64.tar.gz.sha256
gzip -dc Writide-v0.2.0-linux-amd64.tar.gz | docker load
docker compose up -d --no-build
```

ARMv8/arm64 设备执行：

```bash
sha256sum -c Writide-v0.2.0-linux-arm64.tar.gz.sha256
gzip -dc Writide-v0.2.0-linux-arm64.tar.gz | docker load
docker compose up -d --no-build
```

离线归档中的镜像带有同一个 GHCR 版本标签，因此无需修改 `.env`。

## 方法二：从源码构建

适用于 ARM64、AMD64 或 Docker Desktop。首次构建需要联网，低性能设备可能较慢：

```bash
git clone --branch v0.2.0 https://github.com/shiranzby/Writide.git
cd Writide
cp .env.example .env
```

按上文修改 `.env`，然后：

```bash
docker compose build
docker compose up -d
docker compose ps
```

`compose.yaml` 不强制架构，Docker 默认按宿主机原生架构构建。源码构建会在容器构建阶段安装依赖并编译前端，宿主机无需安装 Node.js。需要交叉构建时再明确使用 `docker buildx --platform`，避免日常部署误用模拟。

高级用户可在较强电脑上构建并导出：

```bash
docker buildx build --platform linux/amd64 --load -t writide:0.2.0-amd64 .
docker buildx build --platform linux/arm64 --load -t writide:0.2.0-arm64 .
```

## 数据保存在哪里

Compose 命名卷 `writide-data` 挂载为容器内 `/data`，其中包含：

- `/data/Workspace`：服务端本地工作区文档
- `/data/image-cache`：WebDAV 图片缓存
- `/data/.writide-webdav-credentials.enc`：选择保存时生成的WebDAV凭据密文
- `/data/.writide-webdav-credentials.enc.key`：仅服务端读取的随机加密密钥
- 工作区和服务状态元数据

远端 WebDAV 原文仍在远端；图片缓存不是原件备份。访问页面的手机或电脑不会自动得到完整离线副本，缓存主要位于运行容器的设备。

查看数据卷：

```bash
docker volume inspect writide_writide-data
```

项目目录名不同会改变卷名前缀，以 `docker compose config --volumes` 的结果为准。

## 停止、重启与升级

先确认页面显示保存成功：

```bash
docker compose stop
docker compose start
docker compose restart
```

升级前备份整个数据卷。通用做法是先停止容器，再由你的 NAS/Docker 管理界面备份该卷。`docker compose down` 默认保留命名卷；不要执行 `docker compose down -v`，后者会删除卷中的文档和缓存。

更新源码构建版本：

```bash
git fetch --tags
git checkout v0.2.0
docker compose build --no-cache
docker compose up -d
```

## 局域网、域名与 HTTPS

- 仅本机访问：`WRITIDE_BIND_IP=127.0.0.1`，`WRITIDE_ORIGIN=http://127.0.0.1:5173`。
- 局域网访问：默认绑定 `0.0.0.0`，`WRITIDE_ORIGIN` 可留空并自动执行同源检查；也可显式填写浏览器实际地址。
- 域名访问：`WRITIDE_ORIGIN` 填浏览器最终 HTTPS 地址，例如 `https://notes.example.com`。反向代理必须保留 `Host`、`Authorization` 和 `Origin`。

Basic 认证在 HTTP 下只编码、不加密。不要把 5173 端口直接映射到公网。远程访问应由 HTTPS 反向代理、VPN、访问控制网关或等效方案保护。Writide 当前没有多用户隔离，所有通过认证的设备共享服务端工作区和 WebDAV 会话。

浏览器目录选择器、剪贴板和部分加密 API 需要安全上下文；通过普通局域网 HTTP 访问时可能受限。基础 WebDAV 阅读编辑仍可测试，完整浏览器能力建议使用 HTTPS。

## 资源与权限

- 容器使用 Node 22 Alpine、非 root `node` 用户、只读根文件系统和 `/tmp` 临时卷。
- `mem_limit: 512m` 是上限，不是实测占用保证。页面渲染主要消耗客户端浏览器内存，服务端还会承担文件扫描、WebDAV 传输和图片缓存。
- 图片磁盘缓存默认上限 1 GiB，可在应用设置中调小。
- 默认命名卷由 Docker 管理权限。改为宿主机目录挂载时，确保 UID/GID 1000 可读写，不要使用 `chmod 777`，也不要挂载宿主机根目录。
- 容器可勾选“保存密码”和“自动登录与重连”。WebDAV密码使用AES-256-GCM加密，密文和随机256位密钥以0600权限保存在 `/data`，容器重建后继续有效。密钥与密文位于同一数据卷，能避免明文落盘，但无法抵抗整个卷被攻击者完整复制；卷备份应按密码文件保护。

## 常见问题

### 页面打不开

```bash
docker compose ps
docker compose logs --tail=200
curl -i http://127.0.0.1:5173/api/health
```

检查端口占用、防火墙、`WRITIDE_BIND_IP` 和访问地址。健康检查不需要账号密码。

### 返回 Origin not allowed

显式配置时，浏览器地址与 `WRITIDE_ORIGIN` 必须完全一致。留空时会兼容反向代理内部Host差异，同时拒绝浏览器标记为cross-site的请求。代理最好转发 `Host`、`X-Forwarded-Host`、`Authorization` 和 `Origin`。修改 `.env` 后执行 `docker compose up -d --force-recreate`。

### 一直要求账号密码

首次部署使用 `admin/password`，之后使用应用内设置的新密码。自定义密码至少 8 个字符。应用内密码优先于 `.env` 初始密码；忘记后可在停止容器并备份数据卷后删除 `/data/.writide-access.json`，重启即回到 `.env` 密码或默认 `password`。反向代理必须转发 `Authorization`。

### Permission denied

先执行 `docker compose config --volumes` 与 `docker volume inspect` 确认实际卷。宿主机目录挂载应由 UID 1000 写入；不要通过全局放开权限掩盖路径错误。

### 镜像架构不匹配

先确认 `uname -m`，再检查 Docker 自动选择的镜像架构：

```bash
docker image inspect ghcr.io/shiranzby/writide:0.2.0 --format '{{.Architecture}} {{.Os}} {{.Size}}'
```

32 位 ARMv7 不能运行当前镜像。amd64与arm64都已发布；如果 Docker 选择错误，先检查宿主系统、Docker Engine 架构和代理缓存，不要默认开启跨架构模拟。

## 交给 AI 帮助部署

可以把下面整段连同本文件交给你信任的 AI。不要在对话中发送真实 WebDAV 密码、Writide 访问密码、私人域名后台密钥或完整日志中的正文内容。

```text
请帮助我部署 Writide v0.2.0。先只做只读检查，不删除现有容器、镜像或数据卷。
设备系统是：[填写，例如 Debian 12 / 群晖 / 飞牛 / Windows Docker Desktop]
CPU 架构是：[填写 uname -m 输出]
访问方式是：[仅本机 / 局域网IP / 已有HTTPS域名]
Writide目录是：[填写绝对路径]

请按仓库 docs/DOCKER.md：
1. 检查 Docker Engine、Docker Compose v2、CPU架构、端口5173和目录权限；
2. amd64或arm64设备优先拉取 `ghcr.io/shiranzby/writide:0.2.0`，GHCR不可达时再使用匹配架构的Release离线归档；
3. 默认用admin/password首次登录并立即在设置中改密码；需要高级配置时再创建.env，不要要求我把真实密码发给你；
4. 启动后检查docker compose ps、日志和/api/health；
5. 明确告诉我浏览器访问地址、数据卷位置、停止和备份命令；
6. 遇到错误先解释原因和可恢复方案，不执行docker compose down -v、删除卷、chmod 777或清空目录。
```

## 发布验证边界

仓库工作流分别构建amd64和arm64镜像，逐个启动容器并检查 `/api/health`；两个架构都成功后才发布统一的版本与latest多架构清单，并把各自离线归档附加到Release。云端通过不等于已经覆盖你的NAS内核、反向代理、磁盘权限、真实WebDAV或长文负载；这些仍需在目标设备复验。
