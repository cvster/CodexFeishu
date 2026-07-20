# mobileCodexHelper Local Deployment Notes

## 一键启动

在项目根目录双击 `start-mobile-codex-oneclick.cmd` 即可启动整套服务。脚本会自动优先使用 Codex 自带 Python 运行时，调用 `mobile_codex_control.py --action start --json`，并输出当前状态。

也可以在 PowerShell 中运行：

```powershell
.\start-mobile-codex-oneclick.cmd
```

启动成功后可访问：

- 本地控制台：`http://127.0.0.1:3001`
- 本地 nginx 代理：`http://127.0.0.1:8080`
- Tailscale 远程地址：`https://ps5000.tail995824.ts.net`

这份 README 是当前这台电脑上 `mobileCodexHelper` 的本地部署总入口，给后续继续工作的会话快速接手用。

## 项目来源与会话类型

本项目 fork 自同名项目，并在原项目基础上增加了 `app 会话` 和 `后端会话` 两种会话类型的区别。

原项目存在一个问题：向 Codex app 中的会话发消息时，Codex app 窗口不会同步更新，只能在网页端看到更新，容易导致 app 上显示的会话内容不完整。本项目针对这类 `app 会话` 增加了通过操作 Codex app 窗口发送消息的方式，让消息真正进入 Codex app 中的对应会话，避免 app 侧显示不完整。

如果是在网页上新建的 `后端会话`，则仍然通过后端发消息；这类会话不会显示在 Codex app 中。

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
- Codex SDK
  - 桥接后端要求版本：`0.144.3`
  - 用途：支持 `gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna` 等新版模型
  - 启动脚本会校验已安装版本，并在 vendor 目录仍是旧版时自动升级
- nginx
  - 实际安装版本：`nginx 1.29.8`
  - 用途：监听 `127.0.0.1:8080`，给 `127.0.0.1:3001` 做本机反向代理，并提供额外安全头和登录限流
  - 安装来源：`winget`
  - 实际路径：`C:\Users\ps5000\AppData\Local\Microsoft\WinGet\Packages\nginxinc.nginx_Microsoft.Winget.Source_8wekyb3d8bbwe\nginx-1.29.8\nginx.exe`
- Tailscale
  - 实际安装版本：`1.96.3`
  - 用途：让手机和电脑加入同一个 tailnet，并通过 `tailscale serve` 发布私网 HTTPS 地址
  - 安装来源：`winget`
  - 实际路径：`C:\Program Files\Tailscale\tailscale.exe`

## 环境变量说明

相关环境变量已经设置过：

- `MOBILE_CODEX_NODE`
- `MOBILE_CODEX_NGINX`
- `MOBILE_CODEX_TAILSCALE`
 - `MOBILE_CODEX_PYTHON`

这些值现在也同步写在仓库根目录的本地 `.env` 里。
脚本和 `mobile_codex_control.py` 会优先读这份本地配置；它已被 `.gitignore` 忽略，不会进入仓库。

含义如下：

- `MOBILE_CODEX_NODE`
  指向实际使用的 `node.exe`
- `MOBILE_CODEX_NGINX`
  指向实际使用的 `nginx.exe`
- `MOBILE_CODEX_TAILSCALE`
  指向实际使用的 `tailscale.exe`
- `MOBILE_CODEX_PYTHON`
  可选。指向 `Python 3.11+`，桌面自动化脚本会优先使用它；未设置时默认回退到 Codex 自带 `Python 3.12`
- `MOBILE_CODEX_UPSTREAM_DIR`
  可选。默认不需要；如果以后更换上游源码目录，可以用它覆盖默认 `vendor\claudecodeui-1.25.2`
- `MOBILE_CODEX_ASCII_ALIAS`
  可选。用于 Windows 非 ASCII 路径兼容；当前运行时默认会落到 `C:\mobileCodexHelper_ascii`
- `MOBILE_CODEX_APP_MESSAGE_RELAY_SESSION_ID`
  已有 App 会话发送消息时使用的后端转发会话 ID；必填。App 会话的新建和归档不经过该会话
- `MOBILE_CODEX_APP_MESSAGE_RELAY_MODEL`
  可选。转发会话模型，默认 `gpt-5.6-luna`
- `MOBILE_CODEX_APP_MESSAGE_RELAY_REASONING_EFFORT`
  可选。转发会话推理程度，默认 `low`
- `MOBILE_CODEX_APP_MESSAGE_RELAY_CWD`
  可选。转发会话的工作目录，默认为本仓库根目录
- `MOBILE_CODEX_APP_MESSAGE_RELAY_TIMEOUT_MS`
  可选。转发超时时间，默认 `120000`

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

当前覆盖后端会话和 Codex App 会话收到命令后的新建、发送与归档流程。测试跳过网页操作，直接向本地服务发送网页等价命令；后续 SDK、桌面自动化和归档均真实执行，并在 `D:\dorit\mytest` 下创建后归档临时会话。

### 查看 Codex 桌面窗口状态

```powershell
powershell -ExecutionPolicy Bypass -File C:\software\mobileCodexHelper\scripts\run-codex-desktop-automation.ps1 dump-state --json
```

### 查看 Codex 桌面项目列表

```powershell
powershell -ExecutionPolicy Bypass -File C:\software\mobileCodexHelper\scripts\run-codex-desktop-automation.ps1 list-projects --json
```

### 验证桌面自动化 worker

```powershell
powershell -ExecutionPolicy Bypass -File C:\software\mobileCodexHelper\scripts\run-codex-desktop-automation.ps1 worker
```

正常时会立即输出：

```json
{"event":"ready"}
```

### 打开 Codex 桌面里的指定会话

```powershell
powershell -ExecutionPolicy Bypass -File C:\software\mobileCodexHelper\scripts\run-codex-desktop-automation.ps1 open-session --project future_research --session 策略6 --json
```

第一次运行桌面自动化脚本时，会自动在 `tmp\desktop-automation-venv` 里安装 `pywinauto`。

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

### 手机发消息后 Codex 桌面没动作

先判断是哪一层卡住：

1. 看 `tmp\logs\mobile-codex-app.stdout.log` 是否有 `[mobile-codex][bridge-request]`
2. 如果有，说明前端消息已经到后端
3. 再看 `tmp\logs\mobile-codex-app.stderr.log` 是否有 `[Codex Desktop Worker]` 或 `[Codex Desktop Bridge]` 错误
4. 运行 `list-projects --json`，确认桌面自动化能读到 Codex 左侧项目
5. 运行 `worker`，确认能立即输出 `{"event":"ready"}`

当前设计里，桌面自动化会先用 Win32 找到标题为 `Codex`、类名为 `Chrome_WidgetWin_1` 的主窗口，再用 UIA 按窗口句柄连接。这样比 UIA 全局搜索稳定。

发送消息时，桌面自动化会先临时禁用 Windows 屏保、唤醒显示器并尝试关闭当前屏保；发送动作结束后会恢复原来的屏保启用状态。这样既能降低屏保壁纸挡住 Codex 的概率，也不会永久改掉用户的系统设置。

如果 worker ready 超时或请求超时，后端会清理整棵 PowerShell / Python 进程树，避免残留 worker 越堆越多。worker 启动阶段失败时，发送会安全回退到 one-shot；但如果 `send-message` 已经开始执行，失败后不会自动重试，避免重复发送。

最后一条“发送中”消息是否已真正发到 Codex，由后端 `pending-delivery` 检查接口读取完整 Codex JSONL 历史判断；前端不再用当前页面渲染出的消息列表自行确认。如果发送超过 1 分钟仍未同步到 Codex 历史，后端会返回 `failed`，前端显示“发送失败”。

点击“重发”会把最后一条 pending 消息的状态重新改为“发送中”，并刷新本地 pending 时间戳；后端的 1 分钟失败判断会从这次重发时间重新计算。

输入框左侧状态按钮会按链路展示：发送未确认时显示“发送中”，发送失败时显示“发送失败”；没有未确认发送且 Codex 仍在处理时显示“回复中”，空闲时显示完成状态。侧边栏会复用同一套状态：所有已加载的普通会话项都会显示徽标，只有一个会话的项目会把状态显示在项目行上，多会话项目行会显示项目内已加载会话的汇总状态。为了避免必须先打开会话才刷新，前端顶层会定期检查已加载会话的处理状态，侧边栏徽标也会在“发送中”时主动向后端确认最后一条 pending 是否已进入 Codex 历史。

### 清理残留桌面自动化进程

正常情况下不需要手动清理。若排障时确认有异常残留，可以只清理本项目的 worker 进程：

```powershell
$current = $PID
$workers = Get-CimInstance Win32_Process | Where-Object {
  $_.ProcessId -ne $current -and (
    ($_.Name -in @('powershell.exe','pwsh.exe') -and $_.CommandLine -like '*run-codex-desktop-automation.ps1 worker*') -or
    ($_.Name -eq 'python.exe' -and $_.CommandLine -like '*codex_desktop_automation.py worker*')
  )
}
$workers | Select-Object ProcessId,Name,CommandLine
$workers | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

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
