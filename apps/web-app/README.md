# mobileCodexHelper Local Deployment Notes

整合仓库中请先在根目录执行 `pnpm build`，再应用本目录的 overrides。
共享内核、独立服务与许可证边界见 [整合说明](../../docs/MONOREPO.md)。

## 一键启动

在项目根目录双击 `start-mobile-codex-oneclick.cmd` 即可启动整套服务。脚本会自动优先使用 Codex 自带 Python 运行时，调用 `mobile_codex_control.py --action start --json`，并输出当前状态。

也可以在 PowerShell 中运行：

```powershell
.\start-mobile-codex-oneclick.cmd
```

启动成功后可访问：

- 本地控制台：`http://127.0.0.1:3001`
- 本地 nginx 代理：`http://127.0.0.1:8080`
- 星空组网地址：`http://192.168.188.2:8080`

这份 README 是当前这台电脑上 `mobileCodexHelper` 的本地部署总入口，给后续继续工作的会话快速接手用。

## 会话架构

网页端只使用一种会话：最新版 Codex CLI 会话。新建通过 Codex app server 执行，续聊通过原生 `codex queue` 进入共享队列，归档通过 `thread/archive` 完成。所有会话与 Codex App 共用同一份历史和项目归属，不再区分 App 会话与后端会话，也不依赖桌面窗口自动化。

## 当前状态

- 部署目录：`C:\software\mobileCodexHelper`
- 上游源码目录：`C:\software\mobileCodexHelper\vendor\claudecodeui-1.25.2`
- 本地控制台地址：`http://127.0.0.1:3001`
- 本地 nginx 代理：`http://127.0.0.1:8080`
- 当前星空组网地址：`http://192.168.188.2:8080`
- 远程访问方式：`星空组网 -> nginx(8080) -> app(3001)`
- 已验证通过：
  - 本地服务启动正常
  - nginx 代理正常
  - nginx 仅在回环地址和星空组网 IP 上监听
  - 星空组网入口健康检查正常
  - Android 浏览器首次登录审批流程已跑通

## 目录说明

- `mobile_codex_control.py`
  Windows 桌面控制台，支持 GUI、JSON 状态输出和若干命令行动作。
- `scripts/`
  启停服务、应用 overrides、环境检查、星空组网防火墙配置等脚本。
- `vendor/claudecodeui-1.25.2/`
  上游 `siteboon/claudecodeui v1.25.2` 源码、依赖和构建产物。
- `deploy/`
  nginx 配置模板。
- `docs/`
  项目文档总目录。
- `docs/reference/`
  原仓库根目录里的参考文档，已从根目录迁入这里：
  - `README.md`
  - `README.en.md`
  - `CONTRIBUTING*.md`
  - `SECURITY*.md`
  - `NOTICE*.md`
- `.runtime/`
  当前运行时生成的 nginx 工作目录。
- `tmp/logs/`
  当前部署日志。

## 本机依赖路径

- Python 运行时：
  `C:\Users\ps5000\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe`
- Node.js：
  `C:\Users\ps5000\AppData\Local\Microsoft\WinGet\Packages\OpenJS.NodeJS.22_Microsoft.Winget.Source_8wekyb3d8bbwe\node-v22.22.2-win-x64\node.exe`
- nginx：
  `C:\Users\ps5000\AppData\Local\Microsoft\WinGet\Packages\nginxinc.nginx_Microsoft.Winget.Source_8wekyb3d8bbwe\nginx-1.29.8\nginx.exe`
- 星空组网接口：`StarVPN`，本机地址 `192.168.188.2`

## 依赖环境说明

当前这套部署依赖的本机环境如下：

- Python
  - 实际使用版本：`Python 3.12.x`
  - 用途：运行 `mobile_codex_control.py`
  - 当前使用方式：直接调用 Codex 自带运行时，不依赖系统 Python
  - 实际路径：`C:\Users\ps5000\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe`
- Node.js
  - 实际安装版本：`Node.js 22.22.2`
  - 用途：运行上游 `claudecodeui` 后端、安装 npm 依赖、构建前端
  - 安装来源：`winget`
  - 实际路径：`C:\Users\ps5000\AppData\Local\Microsoft\WinGet\Packages\OpenJS.NodeJS.22_Microsoft.Winget.Source_8wekyb3d8bbwe\node-v22.22.2-win-x64\node.exe`
- Codex CLI / app server
  - 当前要求版本：`0.158.0`
  - 用途：统一创建、续聊和归档 Codex 会话
  - 启动脚本会自动选择 Codex App 捆绑目录中的最新 CLI
- nginx
  - 实际安装版本：`nginx 1.29.8`
  - 用途：监听 `127.0.0.1:8080`，给 `127.0.0.1:3001` 做本机反向代理，并提供额外安全头和登录限流
  - 安装来源：`winget`
  - 实际路径：`C:\Users\ps5000\AppData\Local\Microsoft\WinGet\Packages\nginxinc.nginx_Microsoft.Winget.Source_8wekyb3d8bbwe\nginx-1.29.8\nginx.exe`
- 星空组网
  - 用途：让手机和电脑加入同一个私有组网
  - nginx 只绑定配置的组网 IPv4，不直接暴露 Node 服务

## 环境变量说明

相关环境变量已经设置过：

- `MOBILE_CODEX_NODE`
- `MOBILE_CODEX_NGINX`
- `MOBILE_CODEX_PRIVATE_IP`
- `MOBILE_CODEX_PYTHON`

这些值现在也同步写在仓库根目录的本地 `.env` 里。
脚本和 `mobile_codex_control.py` 会优先读这份本地配置；它已被 `.gitignore` 忽略，不会进入仓库。

含义如下：

- `MOBILE_CODEX_NODE`
  指向实际使用的 `node.exe`
- `MOBILE_CODEX_CLI`
  可选。指向新版 `codex.exe`；未设置时自动选择 Codex Desktop 捆绑目录中最新的 CLI，避免误用 PATH 里的旧 npm 版本
- `MOBILE_CODEX_NGINX`
  指向实际使用的 `nginx.exe`
- `MOBILE_CODEX_PRIVATE_IP`
  私有组网网卡的本机 IPv4；当前为 `192.168.188.2`
- `MOBILE_CODEX_PYTHON`
  可选。指向控制台辅助脚本使用的 `Python 3.11+`
- `MOBILE_CODEX_UPSTREAM_DIR`
  可选。默认不需要；如果以后更换上游源码目录，可以用它覆盖默认 `vendor\claudecodeui-1.25.2`
- `MOBILE_CODEX_ASCII_ALIAS`
  可选。用于 Windows 非 ASCII 路径兼容；当前运行时默认会落到 `C:\mobileCodexHelper_ascii`
- `MOBILE_CODEX_TURN_TIMEOUT_MS`
  可选。队列消息的回答等待时间（新会话和续聊共用），默认 30 分钟
- `MOBILE_CODEX_QUEUE_TIMEOUT_MS`
  可选。原生队列投递超时时间（新会话和续聊共用），默认 30 秒

服务启动脚本还会在运行时临时设置：

- `NODE_ENV=production`
- `HOST=127.0.0.1`
- `PORT=3001`
- `CODEX_ONLY_HARDENED_MODE=true`
- `VITE_CODEX_ONLY_HARDENED_MODE=true`

这意味着当前部署是“仅 Codex、收敛能力、默认本机监听”的模式。

## 常用命令

建议直接用绝对路径调用 Python，最稳。

### 查看状态

```powershell
C:\Users\ps5000\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe C:\software\mobileCodexHelper\mobile_codex_control.py --json
```

### 启动整套服务

```powershell
C:\Users\ps5000\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe C:\software\mobileCodexHelper\mobile_codex_control.py --action start
```

### 停止整套服务

```powershell
C:\Users\ps5000\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe C:\software\mobileCodexHelper\mobile_codex_control.py --action stop
```

### 验证 Codex 重连链路

```powershell
powershell -ExecutionPolicy Bypass -File C:\software\mobileCodexHelper\scripts\smoke-test-codex-reconnect.ps1
```

### 运行单元测试

```powershell
powershell -ExecutionPolicy Bypass -File C:\software\mobileCodexHelper\scripts\run-unit-tests.ps1
```

当前覆盖统一 CLI 会话的新建、续聊和归档流程。实时测试直接向本地服务发送网页等价命令，并在 `D:\dorit\mytest` 下创建、续聊后归档临时 CLI 会话。

### 打开桌面控制台 GUI

```powershell
C:\Users\ps5000\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe C:\software\mobileCodexHelper\mobile_codex_control.py
```

### 手动重新构建前端

```powershell
cd C:\software\mobileCodexHelper\vendor\claudecodeui-1.25.2
C:\Users\ps5000\AppData\Local\Microsoft\WinGet\Packages\OpenJS.NodeJS.22_Microsoft.Winget.Source_8wekyb3d8bbwe\node-v22.22.2-win-x64\npm.cmd run build
```

## 登录与远程访问

### 本地首次使用

1. 打开 `http://127.0.0.1:3001`
2. 完成账号注册
3. 之后可以在桌面控制台查看状态

### 手机访问

1. 手机和电脑加入同一个星空组网
2. 打开 `http://192.168.188.2:8080`
3. 新设备第一次登录时，电脑端批准即可

### 已验证过的设备流程

- 已审批设备：
  - 本机浏览器
  - 一台 Android 浏览器

## 配置要点

- 真正应用服务监听在 `127.0.0.1:3001`
- `127.0.0.1:8080` 是本机 nginx 代理层
- `192.168.188.2:8080` 是星空组网入口；不会把 `3001` 直接暴露出去
- `mobile_codex_control.py --json` 是最方便的状态接口

## 常见排障

### 本地页面打不开

先看：

- `C:\software\mobileCodexHelper\tmp\logs\mobile-codex-app.stdout.log`
- `C:\software\mobileCodexHelper\tmp\logs\mobile-codex-app.stderr.log`

### CLI 消息没有进入会话

先检查服务日志中的 Codex CLI 错误，并确认 `MOBILE_CODEX_CLI` 指向同时支持 `app-server` 和 `queue` 的新版 `codex.exe`。新会话由 app server 创建；已有会话通过原生 `codex queue` 提交消息，不会与 Codex App 争抢 writer lock，全程不要求 Codex 桌面窗口处于前台。

最后一条“发送中”消息是否已真正发到 Codex，由后端 `pending-delivery` 检查接口读取完整 Codex JSONL 历史判断；前端不再用当前页面渲染出的消息列表自行确认。如果发送超过 1 分钟仍未同步到 Codex 历史，后端会返回 `failed`，前端显示“发送失败”。

点击“重发”会把最后一条 pending 消息的状态重新改为“发送中”，并刷新本地 pending 时间戳；后端的 1 分钟失败判断会从这次重发时间重新计算。

输入框左侧状态按钮会按链路展示：发送未确认时显示“发送中”，发送失败时显示“发送失败”；没有未确认发送且 Codex 仍在处理时显示“回复中”，空闲时显示完成状态。侧边栏会复用同一套状态：所有已加载的普通会话项都会显示徽标，只有一个会话的项目会把状态显示在项目行上，多会话项目行会显示项目内已加载会话的汇总状态。为了避免必须先打开会话才刷新，前端顶层会定期检查已加载会话的处理状态，侧边栏徽标也会在“发送中”时主动向后端确认最后一条 pending 是否已进入 Codex 历史。

### 手机打不开远程地址

先确认：

1. 手机和电脑是否在同一个星空组网
2. `192.168.188.2` 是否仍是电脑的 StarVPN 地址
3. `python mobile_codex_control.py --json` 是否显示“组网入口可访问”
4. 首次迁移时，以管理员身份运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\configure-starvpn-firewall.ps1
```

### 文档入口

- 部署说明：`docs/DEPLOYMENT.zh-CN.md`
- 架构说明：`docs/ARCHITECTURE.zh-CN.md`
- 原项目 README：`docs/reference/README.md`
- 原项目英文 README：`docs/reference/README.en.md`
- 安全说明：`docs/reference/SECURITY.zh-CN.md`

## 给后续新会话的提示

如果后面重新开一个 Codex 会话，建议先让它做这几步：

1. 先阅读 `C:\software\mobileCodexHelper\README.md`
2. 再阅读 `C:\software\mobileCodexHelper\mobile_codex_control.py`
3. 如需排障，再看 `C:\software\mobileCodexHelper\tmp\logs\`
4. 如需改前端，再看 `C:\software\mobileCodexHelper\vendor\claudecodeui-1.25.2\`

一句话说明当前环境：

> 项目已经部署在 `C:\software\mobileCodexHelper`，本地和星空组网访问均已配置，继续在这个目录上维护即可。
