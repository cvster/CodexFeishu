# mobileCodexHelper

[中文](README.md) | [English](README.en.md)

Turn the Codex sessions running on your computer into a private, phone-friendly web control panel.

This project is built for a simple use case:

- Codex runs locally on your PC
- you want to view projects, sessions, and messages from your phone
- you want to send follow-up prompts from your phone and let Codex continue on the PC
- you want private-by-default access, with first-time device approval from the desktop

If you are not familiar with this kind of setup, that is fine. This README is written as a practical deployment guide.

## Interface preview

The screenshot below shows the Windows desktop control tool:

![Mobile Codex control console preview](../assets/mobile-codex-control-console.png)

## What it does

- view Codex projects and sessions from a phone browser
- send messages from the phone to continue controlling Codex on the PC
- require desktop approval before a new device can log in
- provide a Windows desktop tool to monitor:
  - local service health
  - remote publish state
  - trusted device whitelist
  - pending approval requests

## What it is not

- not a multi-user SaaS system
- not intended for exposing the Node app directly to the public internet
- not a full remote desktop or full remote IDE
- focused on “phone view + chat control”, not every high-risk capability

## Recommended architecture

```text
Phone browser
   ↓
Tailscale private HTTPS
   ↓
Local nginx reverse proxy
   ↓
Local claudecodeui with this project's patches
   ↓
Codex sessions on your PC
```

## Prerequisites

Prepare the following on your Windows PC:

### Required

- Python 3.11+
- Node.js 22 LTS
- Git
- nginx for Windows
- a working local Codex environment

### Strongly recommended

- Tailscale

Why:

- it is the easiest way to make this “private access for yourself only”
- much safer than direct public exposure

## Fastest path to deployment

If you do not want to read everything first, follow this shortest path:

### On the PC

1. Install Python 3.11+, Node.js 22, nginx, and Tailscale
2. Put upstream `claudecodeui v1.25.2` into `vendor/claudecodeui-1.25.2`
3. Run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/apply-upstream-overrides.ps1
cd vendor/claudecodeui-1.25.2
npm install
cd ..\..
powershell -ExecutionPolicy Bypass -File scripts/start-mobile-codex-stack.ps1
python mobile_codex_control.py
```

4. Open this in a desktop browser:

```text
http://127.0.0.1:3001
```

5. Complete the first registration

### On the phone

1. Install and log into Tailscale
2. On the PC, run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/enable-mobile-codex-remote.ps1
```

3. Open the private HTTPS address shown by Tailscale
4. Log in with the account you just created
5. If the phone waits for approval, approve the device in the desktop tool

At that point, you can usually continue controlling Codex from the phone.

## Step 1: Download this project

Put this repository in a working directory, for example:

```text
D:\mobileCodexHelper
```

## Step 2: Download upstream claudecodeui

This project is not a full replacement for upstream. It is a hardened and phone-control layer on top of upstream.

Download upstream `siteboon/claudecodeui` `v1.25.2` into:

```text
vendor/claudecodeui-1.25.2
```

Expected layout:

```text
mobileCodexHelper/
├─ vendor/
│  └─ claudecodeui-1.25.2/
├─ upstream-overrides/
├─ scripts/
├─ deploy/
└─ mobile_codex_control.py
```

## Step 3: Apply this project's override layer

Run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/apply-upstream-overrides.ps1
```

This copies the files from `upstream-overrides/claudecodeui-1.25.2/` into the upstream checkout.

## Step 4: Install upstream dependencies

Go into the upstream directory:

```powershell
cd vendor/claudecodeui-1.25.2
npm install
```

If you only want to run the project and not package the desktop tool, Python usually does not need extra third-party packages.

If you want to build the Windows desktop tool as an `.exe`, run:

```powershell
pip install -r requirements.txt
```

## Step 5: Check your local environment

Back in the project root, run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/check-mobile-codex-runtime.ps1
```

Important fields to confirm:

- `UpstreamExists = True`
- `Node` is present
- `Nginx` is present
- if you want private remote access, `Tailscale` should also be present

## Step 6: Start the local stack

Run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-mobile-codex-stack.ps1
```

This starts:

1. the local `claudecodeui` service
2. the local nginx reverse proxy

Default ports:

- app: `127.0.0.1:3001`
- proxy: `127.0.0.1:8080`

## Step 7: Launch the desktop control tool

Run either:

```powershell
python mobile_codex_control.py
```

or:

```powershell
scripts\launch-mobile-codex-control.cmd
```

The desktop tool shows:

- PC app service status
- nginx status
- Tailscale login state
- remote publish state
- phone device presence
- pending device approvals

## Step 8: First account registration

Open the local page in a desktop browser:

```text
http://127.0.0.1:3001
```

Complete the first account registration.

Notes:

- this is a single-user system
- the first registered account becomes your main account

## Step 9: Phone access

### Local testing first

First test the login flow from the desktop browser.

### Private remote access through Tailscale

If both your PC and phone are logged into the same Tailscale network, run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/enable-mobile-codex-remote.ps1
```

Then check the remote publish state in the desktop control tool.

Recommended phone clients:

- a normal mobile browser
- or your own WebView / wrapper app

## Step 10: First-time device approval

This is one of the key security features.

When a new phone or new WebView logs in for the first time:

1. the phone page shows “waiting for desktop approval”
2. the desktop tool shows a pending device
3. you verify device name, platform, user agent, and IP
4. you click approve on the PC
5. the phone automatically continues login

Benefits:

- even if account credentials leak, an unknown device still cannot log in directly
- you control which phones enter the trusted-device whitelist

## What success looks like

If all of the following are true, the deployment is basically working:

- `http://127.0.0.1:3001` opens on the PC
- the desktop tool shows both the app service and nginx as healthy
- the phone can open the private HTTPS address
- the desktop tool shows a pending device on first login
- after approval, the phone enters the project and session list
- sending a message from the phone continues the Codex run on the PC

## The 3 most common failure points

If your first deployment fails, start with these three checks:

### 1. Wrong upstream version or folder path

You need:

- upstream version: `v1.25.2`
- folder path: `vendor/claudecodeui-1.25.2`

If you are not sure the override flow really worked, run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/smoke-test-override-flow.ps1 -UpstreamZip <path-to-upstream-zip>
```

### 2. Local dependencies were not discovered correctly

The usual missing executables are:

- `node.exe`
- `nginx.exe`
- `tailscale.exe`

Run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/check-mobile-codex-runtime.ps1
```

If any important field is empty, fix that first.

### 3. Your wrapped phone app is not WebView-compatible enough

If a normal phone browser works but your wrapper app fails, suspect the wrapper first, not the account credentials.

Recommended order:

- validate the full flow in a normal mobile browser first
- test the wrapper app second
- confirm support for `localStorage`, cookies, `Authorization` headers, and WebSocket

## Common commands

### Start everything

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-mobile-codex-stack.ps1
```

### Stop everything

```powershell
powershell -ExecutionPolicy Bypass -File scripts/stop-mobile-codex-stack.ps1
```

### Check Tailscale status

```powershell
powershell -ExecutionPolicy Bypass -File scripts/check-tailscale-status.ps1
```

### Package the desktop tool

```powershell
scripts\package-mobile-codex-control.cmd
```

### Smoke-test the override flow

```powershell
powershell -ExecutionPolicy Bypass -File scripts/smoke-test-override-flow.ps1 -UpstreamZip <path-to-upstream-zip>
```

## Troubleshooting

### 1. The phone can open the page, but nothing happens after login

Check:

- whether the desktop tool shows a pending device
- whether this is the first login for the device
- whether the desktop-side services are still running

### 2. Browser login works, but a wrapped app fails

This project includes WebView compatibility work, but wrapper quality varies a lot.

Check whether the wrapper allows:

- `localStorage`
- `Authorization` headers
- WebSocket
- cookie behavior required by the app

If the browser works but the wrapper app does not, the issue is often the wrapper capability, not the account itself.

### 3. You see 502 errors

Check:

- `tmp/logs/mobile-codex-app.stdout.log`
- `tmp/logs/mobile-codex-app.stderr.log`
- nginx logs

### 4. Why not expose it directly to the public internet?

Because this project controls local Codex sessions on your PC, which is a high-trust environment.  
The intended setup is private network + reverse proxy + device approval, not direct public exposure.

## Recommended reading

- Deployment guide: [`../DEPLOYMENT.md`](../DEPLOYMENT.md)
- Architecture: [`../ARCHITECTURE.md`](../ARCHITECTURE.md)
- Security policy: [`SECURITY.md`](SECURITY.md)
- Open-source release checklist: [`../OPEN_SOURCE_RELEASE_CHECKLIST.md`](../OPEN_SOURCE_RELEASE_CHECKLIST.md)

## Upstream and license

This project builds on upstream `siteboon/claudecodeui`. Please keep:

- upstream attribution
- the included license
- a clear description of local modifications

## Before you publish your own fork

At minimum:

1. run `scripts/check-open-source-tree.ps1`
2. run `scripts/smoke-test-override-flow.ps1`
3. review [`SECURITY.md`](SECURITY.md)
