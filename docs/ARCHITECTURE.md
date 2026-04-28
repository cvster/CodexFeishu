# Architecture

[中文](ARCHITECTURE.zh-CN.md) | [English](ARCHITECTURE.md)

This document is not for the fastest possible deployment path.
If you already have the stack running and want to understand *why* this setup is recommended, this is the right place.

## One-line summary

The core idea is:

do not expose Codex directly to the public internet,
run it locally on your own PC, and provide a small, private web control surface so the phone is used mainly for viewing and chat-based control.

## Why not expose the app directly

Because this project ultimately controls local Codex sessions on your PC, which is usually a high-trust environment.

If the exposure model is too loose, risks go up quickly:

- credential stuffing can reach the login page directly
- internet scans can discover the service
- too many high-risk endpoints may remain reachable
- a stolen password could let an unknown device log in immediately

So the goal is not “least effort at any cost”.
The goal is “personal use with a safer and more controlled deployment model”.

## Recommended structure

Recommended runtime shape:

```text
Phone browser
   ↓
Tailscale private HTTPS
   ↓
Local nginx
   ↓
Local claudecodeui with this project's patches
   ↓
Local Codex sessions
```

## What each layer does

### 1. Phone browser

The phone is mainly for:

- viewing projects
- viewing sessions
- sending follow-up prompts

It is not intended to be a full admin console or a remote desktop replacement.

### 2. Tailscale private network

This limits access to your own device network first.

Benefits:

- far less public exposure
- easier phone-to-PC access
- a good fit for long-term personal use

### 3. nginx

This is the proxy layer in front of the app. It is responsible for:

- providing a single entrypoint
- forwarding traffic to the local app
- adding security headers
- rate limiting login attempts
- letting the Node app remain on localhost

### 4. claudecodeui plus this project's patches

This layer provides:

- the web UI
- project, session, and message APIs
- mobile-friendly interaction behavior
- hardened-mode restrictions
- trusted-device and first-approval logic

### 5. Local Codex sessions

This is where the real work happens.
The phone is not running Codex directly. It is controlling the Codex sessions and projects that already exist on the PC.

## Pending messages on mobile

When the phone sends a message to desktop Codex, the UI first shows a local pending user message. After the desktop Codex session syncs the same user message back, the UI marks it as sent.

The current implementation intentionally keeps this boundary lightweight:

- each session persistently tracks only the latest pending message
- the composer still allows another message while the latest one is pending
- the `删除` button on the latest pending message only removes the local pending bubble and local pending record
- that button does not cancel a message that has already entered the desktop automation queue

### How “sent” is confirmed

The frontend does not treat the HTTP / WebSocket request result as final delivery, and it no longer decides delivery by matching only the currently rendered message list.
The backend owns the final decision: it reads the complete Codex JSONL history and confirms that the same user-visible message has appeared there.

The frontend sends the latest pending message content and timestamp to the backend pending-delivery endpoint. The backend normalizes content, applies the timestamp window, and returns `sending`, `sent`, or `failed`. If the pending message is still absent from the complete Codex history after 60 seconds, the backend marks it `failed`; the frontend only consumes that result.

The composer status button separates delivery from answer generation: `sending` shows "sending", `failed` shows a failed delivery state, Codex processing with no unconfirmed delivery or with the latest pending message confirmed as `sent` shows "replying", and an idle session shows the completed state. The sidebar reuses the same status model for all loaded session rows; single-session projects show the status directly on the project row, and multi-session project rows show an aggregate status for loaded sessions. To keep background sessions fresh, the app shell periodically requests `session-status` for loaded sessions, and sidebar status badges directly call the backend pending-delivery check while a message is still `sending`.

The latest message page may still include the latest user-visible input, but that is now for display quality only, not the source of truth for delivery.

This still tracks only the latest pending message per session by design. Older sends may already be in the desktop automation queue, and the UI should not imply that they can be cancelled or independently managed.

## Phone-to-desktop send path

Sending from the phone does not create a new Codex session and does not call Codex CLI directly.
It controls the already-open Codex desktop app:

```text
Phone web UI
   ↓ WebSocket / HTTP
Local claudecodeui backend
   ↓ desktop bridge queue
Codex desktop automation worker
   ↓ UIA / Win32 control
Existing local Codex App project and session
```

Design boundaries:

- the phone only asks to send text into an existing Codex session
- the backend resolves project, session, and Codex history metadata
- desktop automation opens the right session, writes the composer text, and submits it
- the actual assistant response still comes from the Codex desktop app session
- the phone sees final state by syncing Codex history again

### Why desktop window control is used

The goal is to update the real Codex App session, not to maintain a parallel web-only session.
That is why the phone should not just write messages into the web database and should not create a separate session.

Benefits:

- the Codex App sees the same user message
- phone and PC converge on the same Codex history
- no dependency on undocumented internal desktop APIs

Tradeoffs:

- the PC must be on an interactive desktop
- Codex App must be running and discoverable by window automation
- screensavers, lock screens, or broken window state can block sending

### Worker and one-shot automation

The backend prefers a persistent desktop automation worker because it avoids reinitializing UIA on every send.

The worker must:

- emit `ready` within the startup timeout
- return each request within the request timeout

If worker startup fails, the backend can safely fall back to one-shot automation because no real send action has happened yet.
If `send-message` has already started and then fails, the backend does not retry automatically, because retrying could duplicate the user message.

### Worker cleanup

On Windows, PowerShell starts Python, and Python loads the UI automation layer.
Killing only the PowerShell shell can leave Python children behind, eventually causing “frontend sent, backend received, but Codex did nothing”.

Current design:

- worker startup timeout terminates the whole process tree
- worker request timeout also terminates the whole process tree
- Windows uses `taskkill /T /F`
- the next send can create a clean worker

### Codex window connection

Desktop automation no longer uses a global UIA window search to find Codex.
It now:

1. finds the Codex main window with Win32 `FindWindow("Chrome_WidgetWin_1", "Codex")`
2. connects pywinauto UIA by that window handle
3. continues with mixed UIA / Win32 control for navigation and sending

This avoids machines where `Desktop(backend="uia").window(...)` can hang during global UIA discovery.

## Project and session sync

The frontend project list should not be only a stale web-side cache.
In Codex-only mode, the backend rebuilds project / session indexes from Codex history and desktop metadata, and filters local projects that no longer exist.

Design rules:

- normal local projects whose paths no longer exist are hidden
- archived projects are hidden
- project labels show the folder name, not the full path
- projects with one session can open that session directly
- single-session projects do not need expansion; thinking state and session label can appear on the project row

### Projectless sessions

Some Codex history sessions do not map to a local project.
They should not be forced into a fake filesystem path, and they should not disappear entirely.

They are grouped under a virtual project:

- internal project name: `__codex_projectless__`
- internal path: `codex://projectless`
- display name: `无项目会话`

The virtual project skips local path existence checks.
When sending from a projectless session, the frontend prefers the session `cwd` as the desktop bridge project path, then falls back to the virtual project metadata.

## Why first-time device approval matters

This is one of the most valuable security boundaries in the whole project.

Without it:

- anyone with the account password might log in from an unknown device immediately

With it:

- a new device must wait for desktop approval
- the PC owner can inspect device name, platform, user agent, and IP
- only approved devices enter the trusted-device whitelist

For a personal remote control panel, this matters a lot.

## Why there is both cookie auth and fallback transport

Different phone environments behave differently.

### In normal browsers

The best path is usually:

- same-origin cookie session

### In WebView or wrapper apps

Some wrappers behave poorly around:

- cookies
- WebSocket
- request headers
- local storage

So the project keeps compatibility fallbacks:

- device-bound bearer fallback for HTTP
- token fallback for WebSocket handshake

The important point is:

- those fallbacks exist for compatibility, not to weaken the trust model
- new devices still require approval before they become trusted

## Why hardened mode stays enabled by default

Because the goal is remote phone control, not full remote exposure of every capability.

A more restricted default is better for both personal use and open-source publishing:

- smaller attack surface
- less chance of accidentally exposing dangerous features
- easier to explain to new users what the project is actually for

## Recommended usage model

The intended model is:

- one owner
- the PC is the execution machine
- the phone is the remote viewing and chat-control device
- access happens through a private network
- new devices are approved from the desktop tool

## What is not recommended

This default architecture is not a great fit for:

- multi-user sharing
- direct public exposure
- turning it into a general remote execution service
- re-enabling broader high-risk interfaces without a fresh audit

## The four things worth remembering

If you skip everything else, remember these four points:

1. keep the app local, do not expose it directly
2. let the phone connect through a private entrypoint
3. require desktop approval for a new device
4. keep the phone focused on viewing and chat control, not broad high-risk power
