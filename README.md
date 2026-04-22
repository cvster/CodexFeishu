# mobileCodexHelper Local Deployment Notes

这份 README 是当前这台电脑上 `mobileCodexHelper` 的本地部署总入口，给后续继续工作的会话快速接手用。

## 当前状态

- 部署目录：`C:\software\mobileCodexHelper`
- 上游源码目录：`C:\software\mobileCodexHelper\vendor\claudecodeui-1.25.2`
- 本地控制台地址：`http://127.0.0.1:3001`
- 本地 nginx 代理：`http://127.0.0.1:8080`
- 当前 Tailscale 远程地址：`https://ps5000.tail995824.ts.net`
- 远程访问方式：`Tailscale Serve -> nginx(8080) -> app(3001)`
- 已验证通过：
  - 本地服务启动正常
  - nginx 代理正常
  - Tailscale 已登录
  - Tailscale Serve 已启用
  - Android 浏览器首次登录审批流程已跑通

## 目录说明

- `mobile_codex_control.py`
  Windows 桌面控制台，支持 GUI、JSON 状态输出和若干命令行动作。
- `scripts/`
  启停服务、应用 overrides、环境检查、Tailscale 检查等脚本。
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
- Tailscale：
  `C:\Program Files\Tailscale\tailscale.exe`

相关环境变量已经设置过：

- `MOBILE_CODEX_NODE`
- `MOBILE_CODEX_NGINX`
- `MOBILE_CODEX_TAILSCALE`

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

1. 手机先登录同一个 Tailscale 网络
2. 打开 `https://ps5000.tail995824.ts.net`
3. 新设备第一次登录时，电脑端批准即可

### 已验证过的设备流程

- 已审批设备：
  - 本机浏览器
  - 一台 Android 浏览器

## 配置要点

- 真正应用服务监听在 `127.0.0.1:3001`
- `127.0.0.1:8080` 是本机 nginx 代理层
- Tailscale Serve 发布的是 `8080`，不是直接暴露 `3001`
- `mobile_codex_control.py --json` 是最方便的状态接口

## 常见排障

### 本地页面打不开

先看：

- `C:\software\mobileCodexHelper\tmp\logs\mobile-codex-app.stdout.log`
- `C:\software\mobileCodexHelper\tmp\logs\mobile-codex-app.stderr.log`

### 手机打不开远程地址

先确认：

1. 手机和电脑是否在同一个 Tailscale 网络
2. `tailscale status --json` 是否显示 `BackendState = Running`
3. `tailscale serve status` 是否仍然指向 `http://127.0.0.1:8080`

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

> 项目已经部署在 `C:\software\mobileCodexHelper`，本地和 Tailscale 远程访问都已打通，继续在这个目录上维护即可。
