# mobileCodexHelper

[中文](README.md) | [English](README.en.md)

把你电脑上本地运行的 Codex 会话，变成一个可以在手机上访问和控制的私有网页面板。

这个项目适合下面这种需求：
- 你平时在电脑上跑 Codex
- 你想在手机上随时查看项目、会话、消息
- 你想从手机继续发消息，让电脑上的 Codex 接着执行
- 你希望默认是私有访问，并且新手机第一次登录要经过电脑批准

安全上的考虑：
- 仅允许你本人账号登录
- 首次新设备登录需电脑端授权
- 支持设备白名单，陌生设备不能直接进入
- 手机只发消息控制，不开放电脑桌面
- 远程访问建议走 Tailscale 等加密通道，降低暴露风险


如果你不熟悉这类项目，也没关系。只要你有codex，部署方案：在你电脑codex新起一个线程，复制本项目链接地址：https://github.com/StarsTom/mobileCodexHelper，
然后分析依赖并安装调试运行。

如果觉得还有点用，请帮忙star一下，谢谢啦~

## 界面预览

下面这张图是 Windows 桌面控制工具的公开 README 预览图：

![移动 Codex 控制台预览](../assets/mobile-codex-control-console.png)

## 它能做什么

- 在手机浏览器中查看 Codex 项目和会话
- 在手机上发送消息，继续控制电脑上的 Codex
- 首次登录新设备时，必须由电脑端批准
- 在 Windows 桌面工具中查看：
  - 本地服务状态
  - 手机访问开关状态
  - 已批准设备白名单
  - 待审批设备列表

## 它不能做什么

- 不适合多人协作
- 不建议把 Node 服务直接暴露到公网
- 默认不是远程桌面，也不是完整 IDE
- 重点是“手机查看和聊天控制”，不是开放所有高风险能力

## 整体工作方式

推荐架构如下：

```text
手机浏览器
   ↓
Tailscale 私网 HTTPS
   ↓
本机 nginx 代理
   ↓
本机网页控制服务
   ↓
电脑上的 Codex 会话
```

## 你需要准备什么

请先在 Windows 电脑上准备：

### 必装

- Python 3.11 或更高
- Node.js 22 LTS
- Git
- nginx for Windows
- 一个可正常使用的 Codex 本地环境

### 强烈推荐

- Tailscale

原因很简单：

- 这是最容易做成“只有你自己能访问”的远程方案
- 比直接公网暴露安全得多

## 更省事的使用方式

如果你是普通使用者，不想自己手动执行很多命令，推荐直接使用发布页里的便携版：

- 解压整个发布目录
- 双击 `MobileCodexControl.exe`
- 正常情况下，不需要你自己再准备额外的程序源码或压缩包

首次打开后，桌面工具会自动弹出“首次初始化向导”。  
你只需要：

1. 确认 `node.exe`、`nginx.exe`、`tailscale.exe` 路径
2. 点击“`一键初始化并启动`”

向导会自动帮你完成：

- 保存本机路径配置
- 识别便携包中已经内置的运行环境
- 启动本地服务

只有在排查问题或维护发布包时，才可能需要打开“故障处理工具”并手动选择程序目录或压缩包。

## 最快部署路线

如果你不想一开始看太多说明，可以直接按这个顺序做：

1. 安装 Python 3.11+、Node.js 22、nginx、Tailscale
2. 从发布页下载便携版，完整解压到一个固定目录
3. 双击 `MobileCodexControl.exe`
4. 在初始化向导里确认 `node.exe`、`nginx.exe`、`tailscale.exe` 路径
5. 点击“`一键初始化并启动`”
6. 在电脑浏览器打开 `http://127.0.0.1:3001`，完成第一次注册
7. 在桌面工具里点击“开启手机访问”
8. 让手机和电脑登录同一个 Tailscale 网络
9. 用手机打开桌面工具里显示的“手机访问地址”
10. 首次登录新设备时，在电脑端批准这台设备

做到这里，你通常已经可以从手机继续控制电脑上的 Codex 了。

## 首次设备批准

这是本项目最重要的安全机制之一。

当一个新手机或新 WebView 第一次登录时：

1. 手机端会提示“等待电脑端批准”
2. 电脑端桌面控制工具会出现待审批设备
3. 你核对设备名、平台、UA、IP 后点击“批准所选”
4. 手机端自动继续登录

这样做的好处是：

- 即使账号密码泄露，未知设备也不能直接登录
- 你可以控制哪些手机被加入白名单

## 可选：自己从源码构建

如果你想自己维护、二次开发，或者重新生成便携发布目录，再看源码部署路线：

- 中文：`../DEPLOYMENT.zh-CN.md`
- English: `../DEPLOYMENT.md`

## 部署成功的判断标准

如果下面这些都满足，说明部署基本成功：

- 电脑端 `http://127.0.0.1:3001` 能打开
- 桌面控制工具里 PC 应用服务和 nginx 都是正常
- 手机能打开私有 HTTPS 地址
- 手机首次登录时，电脑端能看到待审批设备
- 你批准后，手机能进入项目和会话列表
- 手机发送消息后，电脑上的 Codex 会继续执行

## 最容易失败的 3 个点

如果你第一次部署就遇到问题，通常优先排查这 3 个地方：

### 1. 程序目录不完整或位置被改动

先确认这两件事：

- 你解压的是整个便携目录，而不是只拿出了其中的 `MobileCodexControl.exe`
- 程序目录里没有误删 `vendor/claudecodeui-1.25.2`

如果你是自己从源码构建的维护者，再额外确认：

- 使用的是 `claudecodeui v1.25.2`
- 目录名是 `vendor/claudecodeui-1.25.2`

如果你想做源码覆盖自检，可以运行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/smoke-test-override-flow.ps1 -UpstreamZip <你的程序源码压缩包路径>
```

### 2. 本机依赖路径没有被脚本找到

最常见的是：

- `node.exe`
- `nginx.exe`
- `tailscale.exe`

先运行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/check-mobile-codex-runtime.ps1
```

只要里面有空值，就先不要继续下一步。

### 3. 手机封装壳不兼容

如果手机浏览器能登录，但封装成 App 的 WebView 不行，先默认怀疑是壳兼容问题，不要先怀疑账号密码。

优先建议：

- 先用手机浏览器打通全流程
- 再测试封装 App
- 确认壳支持 `localStorage`、Cookie、`Authorization` 请求头和 WebSocket

## 常用命令

### 启动整套服务

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-mobile-codex-stack.ps1
```

### 停止整套服务

```powershell
powershell -ExecutionPolicy Bypass -File scripts/stop-mobile-codex-stack.ps1
```

### 检查 Tailscale 状态

```powershell
powershell -ExecutionPolicy Bypass -File scripts/check-tailscale-status.ps1
```

### 维护者：打包桌面工具

```powershell
scripts\package-mobile-codex-control.cmd
```

### 维护者：生成便携发布目录

```powershell
scripts\package-mobile-codex-helper.cmd
```

说明：

- 当前推荐发布形态就是“带内置运行环境的便携目录 + `MobileCodexControl.exe`”
- 不再要求额外制作安装包

### 维护者：源码覆盖自测

```powershell
powershell -ExecutionPolicy Bypass -File scripts/smoke-test-override-flow.ps1 -UpstreamZip <你的程序源码压缩包路径>
```

## 常见问题

### 1. 手机能打开页面，但登录后没反应

优先检查：

- 桌面工具里是否出现待审批设备
- 手机是不是第一次登录新设备
- 电脑端服务是否还在运行

### 2. 手机浏览器能登录，封装 App 登录失败

本项目已经针对 WebView 做了兼容处理，但不同壳的实现质量差异很大。

建议依次检查：

- 壳是否允许 `localStorage`
- 壳是否允许 `Authorization` 请求头
- 壳是否允许 WebSocket
- 壳是否拦截 Cookie 或跨域行为

如果浏览器可以、壳不可以，通常是壳自身 WebView 能力不足，而不是账号密码错误。

### 3. 出现 502

优先检查这些日志：

- `tmp/logs/mobile-codex-app.stdout.log`
- `tmp/logs/mobile-codex-app.stderr.log`
- nginx 日志目录

### 4. 为什么不直接公网暴露？

因为这个项目控制的是你电脑上的本地 Codex，会话权限很高。  
推荐私网、反向代理、设备白名单三层一起用，不建议直接裸露到公网。

## 推荐阅读

- 部署说明：[`../DEPLOYMENT.zh-CN.md`](../DEPLOYMENT.zh-CN.md)
- 架构说明：[`../ARCHITECTURE.zh-CN.md`](../ARCHITECTURE.zh-CN.md)
- 安全策略：[`SECURITY.zh-CN.md`](SECURITY.zh-CN.md)
- 开源发布检查清单：[`../OPEN_SOURCE_RELEASE_CHECKLIST.zh-CN.md`](../OPEN_SOURCE_RELEASE_CHECKLIST.zh-CN.md)

## 上游与许可证

本项目基于上游 `siteboon/claudecodeui` 工作，请保留：

- 上游归属说明
- 本仓库中的许可证
- 对上游改动的说明

## 发布前建议

如果你打算把你自己的改动再公开发布，至少先做这三件事：

1. 运行 `scripts/check-open-source-tree.ps1`
2. 运行 `scripts/smoke-test-override-flow.ps1`
3. 再通读一次 [`SECURITY.zh-CN.md`](SECURITY.zh-CN.md)
