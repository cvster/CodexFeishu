from __future__ import annotations

import argparse
import base64
import ctypes
import json
import os
import re
import sys
import time
import traceback
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable
from ctypes import wintypes

try:
    import win32api
    import win32con
    import win32gui
except ImportError as exc:  # pragma: no cover - exercised through the wrapper
    raise SystemExit(
        "pywinauto is required. Run scripts\\run-codex-desktop-automation.ps1 "
        "to bootstrap the automation environment."
    ) from exc

Application: Any | None = None
Desktop: Any | None = None
UIAWrapper: Any | None = None


SIDEBAR_RIGHT_EDGE = 650
DESKTOP_READOBJECTS = 0x0001
DESKTOP_CREATEWINDOW = 0x0002
DESKTOP_ENUMERATE = 0x0040
DESKTOP_SWITCHDESKTOP = 0x0100
DESKTOP_WRITEOBJECTS = 0x0080
ES_DISPLAY_REQUIRED = 0x00000002
ES_SYSTEM_REQUIRED = 0x00000001
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
INPUT_MOUSE = 0
INPUT_KEYBOARD = 1
KEYEVENTF_KEYUP = 0x0002
MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
MOUSEEVENTF_ABSOLUTE = 0x8000
SPI_GETSCREENSAVERRUNNING = 114
SPI_GETSCREENSAVEACTIVE = 16
SPI_SETSCREENSAVEACTIVE = 17
SM_CXSCREEN = 0
SM_CYSCREEN = 1
WM_CLOSE = 0x0010
WM_SYSCOMMAND = 0x0112
SC_MONITORPOWER = 0xF170
MONITOR_ON = -1
RELATIVE_TIME_SUFFIX_RE = re.compile(
    r"(?:\s*[·•\-–—|])?\s*\d+\s*(?:秒|分钟|小时|天|周|个月|月|年|sec|secs|second|seconds|min|mins|minute|minutes|hour|hours|day|days|week|weeks|month|months|year|years)\s*(?:前|ago)?$",
    re.IGNORECASE,
)


user32 = ctypes.WinDLL("user32", use_last_error=True)
user32.OpenInputDesktop.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
user32.OpenInputDesktop.restype = wintypes.HANDLE
user32.SetThreadDesktop.argtypes = [wintypes.HANDLE]
user32.SetThreadDesktop.restype = wintypes.BOOL
user32.SwitchDesktop.argtypes = [wintypes.HANDLE]
user32.SwitchDesktop.restype = wintypes.BOOL
user32.CloseDesktop.argtypes = [wintypes.HANDLE]
user32.CloseDesktop.restype = wintypes.BOOL
user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
user32.GetWindowThreadProcessId.restype = wintypes.DWORD
user32.SystemParametersInfoW.argtypes = [
    wintypes.UINT,
    wintypes.UINT,
    wintypes.LPVOID,
    wintypes.UINT,
]
user32.SystemParametersInfoW.restype = wintypes.BOOL
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
kernel32.OpenProcess.restype = wintypes.HANDLE
kernel32.QueryFullProcessImageNameW.argtypes = [
    wintypes.HANDLE,
    wintypes.DWORD,
    wintypes.LPWSTR,
    ctypes.POINTER(wintypes.DWORD),
]
kernel32.QueryFullProcessImageNameW.restype = wintypes.BOOL
kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
kernel32.CloseHandle.restype = wintypes.BOOL
kernel32.SetThreadExecutionState.argtypes = [wintypes.DWORD]
kernel32.SetThreadExecutionState.restype = wintypes.DWORD

_ATTACHED_INPUT_DESKTOP_HANDLE: int | None = None


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", wintypes.LONG),
        ("dy", wintypes.LONG),
        ("mouseData", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong)),
    ]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", wintypes.WORD),
        ("wScan", wintypes.WORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong)),
    ]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [
        ("uMsg", wintypes.DWORD),
        ("wParamL", wintypes.WORD),
        ("wParamH", wintypes.WORD),
    ]


class INPUT_UNION(ctypes.Union):
    _fields_ = [
        ("mi", MOUSEINPUT),
        ("ki", KEYBDINPUT),
        ("hi", HARDWAREINPUT),
    ]


class INPUT(ctypes.Structure):
    _fields_ = [
        ("type", wintypes.DWORD),
        ("union", INPUT_UNION),
    ]


user32.SendInput.argtypes = [wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int]
user32.SendInput.restype = wintypes.UINT


def _configure_stdio() -> None:
    for stream_name in ("stdout", "stderr"):
        stream = getattr(sys, stream_name, None)
        if stream and hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")


def _rect_to_list(rect: Any) -> list[int]:
    return [int(rect.left), int(rect.top), int(rect.right), int(rect.bottom)]


def _get_window_process_path(hwnd: int) -> str:
    process_id = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(process_id))
    if not process_id.value:
        return ""

    process_handle = kernel32.OpenProcess(
        PROCESS_QUERY_LIMITED_INFORMATION,
        False,
        process_id.value,
    )
    if not process_handle:
        return ""

    try:
        buffer_size = wintypes.DWORD(32768)
        buffer = ctypes.create_unicode_buffer(buffer_size.value)
        if not kernel32.QueryFullProcessImageNameW(
            process_handle,
            0,
            buffer,
            ctypes.byref(buffer_size),
        ):
            return ""
        return buffer.value
    finally:
        kernel32.CloseHandle(process_handle)


def _find_codex_desktop_window() -> int:
    candidates: list[int] = []

    def visit(hwnd: int, _: Any) -> bool:
        try:
            if not win32gui.IsWindow(hwnd):
                return True
            if win32gui.GetClassName(hwnd) != "Chrome_WidgetWin_1":
                return True

            process_path = _get_window_process_path(hwnd).replace("/", "\\").casefold()
            if "\\windowsapps\\openai.codex_" in process_path:
                candidates.append(int(hwnd))
        except Exception:
            pass
        return True

    win32gui.EnumWindows(visit, None)
    if not candidates:
        return 0

    visible_candidates = [hwnd for hwnd in candidates if win32gui.IsWindowVisible(hwnd)]
    ranked_candidates = visible_candidates or candidates

    def window_area(hwnd: int) -> int:
        try:
            left, top, right, bottom = win32gui.GetWindowRect(hwnd)
            return max(0, right - left) * max(0, bottom - top)
        except Exception:
            return 0

    # Current Codex builds may expose both a small auxiliary window titled
    # "Codex" and the real application window titled "ChatGPT".  The old
    # exact-title shortcut selected the auxiliary window, whose UIA tree is
    # empty.  The main window is consistently the largest visible package
    # window and contains the sidebar/composer accessibility tree.
    return max(ranked_candidates, key=window_area)


def _rect_intersects(container: Any, rect: Any) -> bool:
    return (
        int(rect.right) > int(container.left)
        and int(rect.left) < int(container.right)
        and int(rect.bottom) > int(container.top)
        and int(rect.top) < int(container.bottom)
    )


def _normalize(value: str) -> str:
    return value.strip().casefold()


def _strip_relative_time_suffix(value: str) -> str:
    stripped = RELATIVE_TIME_SUFFIX_RE.sub("", value or "").strip()
    return stripped or (value or "").strip()


def _matching_variants(value: str) -> tuple[str, ...]:
    variants = []
    for candidate in (value or "", _strip_relative_time_suffix(value or "")):
        normalized = _normalize(candidate)
        if normalized and normalized not in variants:
            variants.append(normalized)
    return tuple(variants)


def _decode_text_argument(value: str | None, encoded_value: str | None, label: str) -> str:
    if encoded_value:
        try:
            decoded = base64.b64decode(encoded_value.encode("ascii"), validate=True)
            return decoded.decode("utf-8")
        except Exception as exc:
            raise SystemExit(f"Invalid {label} base64 value: {exc}") from exc

    return value or ""


def _is_screensaver_running() -> bool:
    running = wintypes.BOOL()
    success = user32.SystemParametersInfoW(
        SPI_GETSCREENSAVERRUNNING,
        0,
        ctypes.byref(running),
        0,
    )
    return bool(success and running.value)


def _get_screensaver_active() -> bool | None:
    active = wintypes.BOOL()
    success = user32.SystemParametersInfoW(
        SPI_GETSCREENSAVEACTIVE,
        0,
        ctypes.byref(active),
        0,
    )
    if not success:
        return None
    return bool(active.value)


def _set_screensaver_active(active: bool) -> bool:
    return bool(
        user32.SystemParametersInfoW(
            SPI_SETSCREENSAVEACTIVE,
            1 if active else 0,
            None,
            0,
        )
    )


@contextmanager
def _temporarily_disable_screensaver() -> Iterable[None]:
    previous_active = _get_screensaver_active()
    disabled = False
    if previous_active:
        # Disable only for this desktop automation run, then restore the user's setting.
        disabled = _set_screensaver_active(False)

    try:
        yield
    finally:
        if previous_active and disabled:
            _set_screensaver_active(True)


def _request_display_awake() -> None:
    kernel32.SetThreadExecutionState(ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED)


def _request_monitor_on() -> None:
    try:
        win32gui.PostMessage(
            win32con.HWND_BROADCAST,
            WM_SYSCOMMAND,
            SC_MONITORPOWER,
            MONITOR_ON,
        )
    except Exception:
        pass


def _send_input_events(events: list[INPUT]) -> bool:
    if not events:
        return True

    array_type = INPUT * len(events)
    sent = user32.SendInput(len(events), array_type(*events), ctypes.sizeof(INPUT))
    return sent == len(events)


def _mouse_event_input(dx: int, dy: int, flags: int) -> INPUT:
    event = INPUT()
    event.type = INPUT_MOUSE
    event.union.mi = MOUSEINPUT(dx, dy, 0, flags, 0, None)
    return event


def _keyboard_event_input(vk: int, flags: int = 0) -> INPUT:
    event = INPUT()
    event.type = INPUT_KEYBOARD
    event.union.ki = KEYBDINPUT(vk, 0, flags, 0, None)
    return event


def _screen_point_to_absolute(x: int, y: int) -> tuple[int, int]:
    width = max(1, win32api.GetSystemMetrics(SM_CXSCREEN) - 1)
    height = max(1, win32api.GetSystemMetrics(SM_CYSCREEN) - 1)
    return int(x * 65535 / width), int(y * 65535 / height)


def _input_desktop_is_switchable() -> bool:
    desktop = user32.OpenInputDesktop(
        0,
        False,
        DESKTOP_READOBJECTS | DESKTOP_SWITCHDESKTOP,
    )
    if not desktop:
        return False

    try:
        return bool(user32.SwitchDesktop(desktop))
    finally:
        user32.CloseDesktop(desktop)


def _attach_thread_to_input_desktop() -> bool:
    global _ATTACHED_INPUT_DESKTOP_HANDLE

    if _ATTACHED_INPUT_DESKTOP_HANDLE:
        return True

    desktop = user32.OpenInputDesktop(
        0,
        False,
        DESKTOP_READOBJECTS
        | DESKTOP_WRITEOBJECTS
        | DESKTOP_CREATEWINDOW
        | DESKTOP_ENUMERATE
        | DESKTOP_SWITCHDESKTOP,
    )
    if not desktop:
        return False

    if not user32.SetThreadDesktop(desktop):
        user32.CloseDesktop(desktop)
        return False

    _ATTACHED_INPUT_DESKTOP_HANDLE = int(desktop)
    return True


def _ensure_pywinauto_loaded() -> None:
    global Application, Desktop, UIAWrapper

    if Application is not None and Desktop is not None and UIAWrapper is not None:
        return

    try:
        from pywinauto import Desktop as LoadedDesktop
        from pywinauto.application import Application as LoadedApplication
        from pywinauto.controls.uiawrapper import UIAWrapper as LoadedUIAWrapper
    except ImportError as exc:  # pragma: no cover - exercised through the wrapper
        raise SystemExit(
            "pywinauto is required. Run scripts\\run-codex-desktop-automation.ps1 "
            "to bootstrap the automation environment."
        ) from exc

    Application = LoadedApplication
    Desktop = LoadedDesktop
    UIAWrapper = LoadedUIAWrapper


def _desktop_is_ready_for_automation() -> bool:
    return not _is_screensaver_running() and _input_desktop_is_switchable()


def _send_wake_input() -> None:
    _send_input_events(
        [
            _mouse_event_input(1, 0, MOUSEEVENTF_MOVE),
            _mouse_event_input(-1, 0, MOUSEEVENTF_MOVE),
            _keyboard_event_input(win32con.VK_SHIFT),
            _keyboard_event_input(win32con.VK_SHIFT, KEYEVENTF_KEYUP),
        ]
    )

    try:
        win32api.mouse_event(win32con.MOUSEEVENTF_MOVE, 1, 0, 0, 0)
        win32api.mouse_event(win32con.MOUSEEVENTF_MOVE, -1, 0, 0, 0)
    except Exception:
        pass

    try:
        win32api.keybd_event(win32con.VK_SHIFT, 0, 0, 0)
        win32api.keybd_event(win32con.VK_SHIFT, 0, win32con.KEYEVENTF_KEYUP, 0)
    except Exception:
        pass


def _tap_key(vk: int) -> None:
    _send_input_events(
        [
            _keyboard_event_input(vk),
            _keyboard_event_input(vk, KEYEVENTF_KEYUP),
        ]
    )

    try:
        win32api.keybd_event(vk, 0, 0, 0)
        win32api.keybd_event(vk, 0, win32con.KEYEVENTF_KEYUP, 0)
    except Exception:
        pass


def _tap_key_combo(modifiers: Iterable[int], vk: int) -> None:
    modifier_list = list(modifiers)
    events: list[INPUT] = []
    for modifier in modifier_list:
        events.append(_keyboard_event_input(modifier))
    events.append(_keyboard_event_input(vk))
    events.append(_keyboard_event_input(vk, KEYEVENTF_KEYUP))
    for modifier in reversed(modifier_list):
        events.append(_keyboard_event_input(modifier, KEYEVENTF_KEYUP))
    _send_input_events(events)

    try:
        for modifier in modifier_list:
            win32api.keybd_event(modifier, 0, 0, 0)
        win32api.keybd_event(vk, 0, 0, 0)
        win32api.keybd_event(vk, 0, win32con.KEYEVENTF_KEYUP, 0)
        for modifier in reversed(modifier_list):
            win32api.keybd_event(modifier, 0, win32con.KEYEVENTF_KEYUP, 0)
    except Exception:
        pass


def _close_screensaver_windows() -> None:
    def visit(hwnd: int, _: Any) -> bool:
        try:
            class_name = win32gui.GetClassName(hwnd).casefold()
            title = win32gui.GetWindowText(hwnd).casefold()
        except Exception:
            return True

        haystack = f"{class_name} {title}"
        if "screensaver" in haystack or "screen saver" in haystack:
            try:
                win32gui.PostMessage(hwnd, WM_CLOSE, 0, 0)
            except Exception:
                pass
        return True

    try:
        win32gui.EnumWindows(visit, None)
    except Exception:
        pass


def _send_wake_click() -> None:
    try:
        screen_width = win32api.GetSystemMetrics(0)
        screen_height = win32api.GetSystemMetrics(1)
        if screen_width > 0 and screen_height > 0:
            center_x = int(screen_width / 2)
            center_y = int(screen_height / 2)
            absolute_x, absolute_y = _screen_point_to_absolute(center_x, center_y)
            _send_input_events(
                [
                    _mouse_event_input(
                        absolute_x,
                        absolute_y,
                        MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE,
                    ),
                    _mouse_event_input(0, 0, MOUSEEVENTF_LEFTDOWN),
                    _mouse_event_input(0, 0, MOUSEEVENTF_LEFTUP),
                ]
            )
            win32api.SetCursorPos((center_x, center_y))
            time.sleep(0.05)
        win32api.mouse_event(win32con.MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
        time.sleep(0.05)
        win32api.mouse_event(win32con.MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
    except Exception:
        pass


def _dismiss_screensaver_or_wake(timeout: float = 12.0) -> None:
    _request_monitor_on()
    _request_display_awake()
    _close_screensaver_windows()

    if _desktop_is_ready_for_automation():
        return

    deadline = time.time() + timeout
    while time.time() < deadline:
        screensaver_running = _is_screensaver_running()
        desktop_switchable = _input_desktop_is_switchable()
        _request_monitor_on()
        _close_screensaver_windows()
        _send_wake_input()
        if screensaver_running or not desktop_switchable:
            time.sleep(0.1)
            _send_wake_click()
            time.sleep(0.1)
            _tap_key(win32con.VK_ESCAPE)
            time.sleep(0.1)
            _tap_key(win32con.VK_RETURN)
        time.sleep(0.35)
        _request_display_awake()
        if _desktop_is_ready_for_automation():
            return


def _text_matches(candidate: str, target: str, exact: bool) -> bool:
    candidate_variants = _matching_variants(candidate)
    target_variants = _matching_variants(target)
    if not candidate_variants or not target_variants:
        return False

    if exact:
        return any(candidate_variant == target_variant for candidate_variant in candidate_variants for target_variant in target_variants)

    return any(target_variant in candidate_variant for candidate_variant in candidate_variants for target_variant in target_variants)


def _control_name(control: Any) -> str:
    try:
        return (control.window_text() or "").strip()
    except Exception:
        return ""


def _control_class_name(control: Any) -> str:
    try:
        return (getattr(control.element_info, "class_name", "") or "").strip()
    except Exception:
        return ""


def _looks_like_send_button(control: Any) -> bool:
    haystack = f"{_control_name(control)} {_control_class_name(control)}".casefold()
    if any(token in haystack for token in ("停止", "stop", "cancel", "interrupt")):
        return False

    if any(token in haystack for token in ("发送", "submit", "send")):
        return True

    return "bg-token-foreground" in haystack


def _looks_enabled(control: Any) -> bool:
    haystack = f"{_control_name(control)} {_control_class_name(control)}".casefold()
    return "opacity-50" not in haystack and "disabled=\"true\"" not in haystack


def _looks_like_archive_control(control: Any, *, excluded_text: str = "") -> bool:
    name = _control_name(control)
    normalized_name = _normalize(name)
    if excluded_text and any(normalized_name == variant for variant in _matching_variants(excluded_text)):
        return False

    class_name = _control_class_name(control).casefold()
    haystack = f"{normalized_name} {class_name}"
    if normalized_name in {
        "归档",
        "归档此会话",
        "归档对话",
        "归档任务",
        "archive",
        "archive chat",
        "archive conversation",
        "archive session",
    }:
        return True

    return "archive" in haystack and "unarchive" not in haystack


def _looks_like_archive_confirm_control(control: Any) -> bool:
    normalized_name = _normalize(_control_name(control))
    class_name = _control_class_name(control).casefold()
    if normalized_name in {"确认", "confirm"}:
        return True

    return "confirm" in normalized_name and "red" in class_name


@dataclass
class SessionRef:
    title: str
    rect: list[int]
    item: Any
    button: Any | None

    def to_json(self) -> dict[str, Any]:
        return {"title": self.title, "rect": self.rect}


@dataclass
class ProjectRef:
    title: str
    rect: list[int]
    expanded: bool
    item: Any
    button: Any | None
    new_session_button: Any | None
    sessions: list[SessionRef]

    def to_json(self) -> dict[str, Any]:
        return {
            "title": self.title,
            "rect": self.rect,
            "expanded": self.expanded,
            "has_new_session_button": self.new_session_button is not None,
            "sessions": [session.to_json() for session in self.sessions],
        }


class CodexDesktopAutomation:
    def __init__(
        self,
        sidebar_right_edge: int = SIDEBAR_RIGHT_EDGE,
        click_delay: float = 0.25,
        scroll_delay: float = 0.05,
    ) -> None:
        self.sidebar_right_edge = sidebar_right_edge
        self.click_delay = click_delay
        self.scroll_delay = scroll_delay
        _attach_thread_to_input_desktop()
        _ensure_pywinauto_loaded()
        hwnd = 0
        deadline = time.time() + 10
        while time.time() < deadline:
            hwnd = _find_codex_desktop_window()
            if hwnd and win32gui.IsWindow(hwnd):
                break
            time.sleep(0.1)
        if not hwnd:
            raise RuntimeError("Could not find the Codex desktop window.")

        # Connecting by handle avoids a slow global UIA window search on some machines.
        self.app = Application(backend="uia").connect(handle=hwnd, timeout=10)
        self.window_spec = self.app.window(handle=hwnd)
        self.window = self.window_spec.wrapper_object()

    def _refresh_window_binding(self) -> None:
        hwnd = _find_codex_desktop_window()
        if not hwnd or not win32gui.IsWindow(hwnd):
            raise RuntimeError("Could not refresh the Codex desktop window.")
        self.app = Application(backend="uia").connect(handle=hwnd, timeout=10)
        self.window_spec = self.app.window(handle=hwnd)
        self.window = self.window_spec.wrapper_object()

    def _ensure_interactive_desktop(self) -> None:
        _dismiss_screensaver_or_wake(timeout=4.0)

        if not _input_desktop_is_switchable():
            raise RuntimeError(
                "Windows desktop is not currently interactive. Please dismiss the lock screen or screensaver and try again."
            )

        if _is_screensaver_running():
            raise RuntimeError(
                "Windows screensaver is active. Please return to the normal desktop before sending a message."
            )

    def activate(self) -> None:
        _dismiss_screensaver_or_wake()
        self._ensure_interactive_desktop()
        try:
            win32gui.ShowWindow(self.window.handle, win32con.SW_RESTORE)
        except Exception:
            pass
        try:
            win32gui.SetForegroundWindow(self.window.handle)
        except Exception:
            pass
        try:
            win32gui.BringWindowToTop(self.window.handle)
        except Exception:
            pass
        time.sleep(self.click_delay)

    def _activate_control(self, control: Any, *, label: str) -> None:
        last_error: Exception | None = None

        self.activate()

        for activator in (
            lambda item: getattr(item, "invoke")(),
            lambda item: getattr(item, "select")(),
        ):
            try:
                activator(control)
                time.sleep(self.click_delay)
                return
            except Exception as exc:  # pragma: no cover - depends on control implementation
                last_error = exc

        try:
            self._click_control_by_message(control)
            return
        except Exception as exc:
            last_error = exc

        if last_error is not None:
            raise RuntimeError(f"Failed to activate {label}: {last_error}") from last_error
        raise RuntimeError(f"Failed to activate {label}.")

    def _activate_session_item(self, session: SessionRef) -> None:
        self._activate_control(
            session.button or session.item,
            label=f"session '{session.title}'",
        )

    def snapshot(self) -> dict[str, Any]:
        return {
            "window_handle": hex(self.window.handle),
            "projects": [project.to_json() for project in self._projects_in_view()],
            "main_text_preview": self._main_text_preview(),
        }

    def list_projects(self) -> list[dict[str, Any]]:
        return [project.to_json() for project in self._projects_in_view()]

    def list_sessions(
        self,
        project_name: str,
        project_exact: bool,
        max_scrolls: int,
        expand: bool,
    ) -> list[dict[str, Any]]:
        project = self._find_project(project_name, exact=project_exact, max_scrolls=max_scrolls)
        if expand and not project.expanded:
            project = self.expand_project(project_name, exact=project_exact, max_scrolls=max_scrolls)
        return [session.to_json() for session in project.sessions]

    def expand_project(self, project_name: str, exact: bool, max_scrolls: int) -> ProjectRef:
        project = self._find_project(project_name, exact=exact, max_scrolls=max_scrolls)
        if project.expanded:
            return project

        clickable = project.button or project.item
        self._activate_control(clickable, label=f"project '{project.title}'")
        refreshed = self._wait_for_project_expanded(project_name, exact=exact)
        if refreshed is not None:
            return refreshed

        # Retry once more because the sidebar occasionally ignores the first toggle.
        refreshed = self._find_project(
            project_name,
            exact=exact,
            max_scrolls=3,
            reset_to_top=False,
        )
        self._activate_control(refreshed.button or refreshed.item, label=f"project '{refreshed.title}'")
        refreshed = self._wait_for_project_expanded(project_name, exact=exact)
        if refreshed is None:
            raise RuntimeError(f"Project '{project_name}' did not expand.")
        return refreshed

    def open_session(
        self,
        project_name: str,
        session_name: str,
        *,
        project_exact: bool,
        session_exact: bool,
        max_scrolls: int,
        wait_for_main_change: bool = True,
    ) -> dict[str, Any]:
        project = self.expand_project(project_name, exact=project_exact, max_scrolls=max_scrolls)
        before = tuple(self._main_text_preview())
        seen: set[tuple[str, ...]] = set()

        for _ in range(max_scrolls):
            titles = tuple(session.title for session in project.sessions)
            session = self._best_session_match(project.sessions, session_name, exact=session_exact)
            if session is not None:
                self._activate_session_item(session)
                self._wait_for_main_text_change(before, timeout=4.0 if wait_for_main_change else 1.5)
                return {
                    "selected_project": project.title,
                    "selected_session": session.title,
                    "state": self.snapshot(),
                }

            session_anywhere = self._find_session_anywhere(project, session_name, exact=session_exact)
            if session_anywhere is not None and self._scroll_item_into_view(session_anywhere.item):
                project = self._find_project(project_name, exact=project_exact, max_scrolls=max_scrolls, reset_to_top=False)
                session = self._best_session_match(project.sessions, session_name, exact=session_exact)
                if session is not None:
                    self._activate_session_item(session)
                    self._wait_for_main_text_change(before, timeout=4.0 if wait_for_main_change else 1.5)
                    return {
                        "selected_project": project.title,
                        "selected_session": session.title,
                        "state": self.snapshot(),
                    }

            if titles in seen:
                break
            seen.add(titles)

            self._scroll_sidebar(-3)
            project = self._find_project_in_current_view(project_name, exact=project_exact)
            if project is None:
                break

        raise RuntimeError(
            f"Session '{session_name}' was not found under project '{project_name}'."
        )

    def open_latest_session(
        self,
        project_name: str,
        *,
        project_exact: bool,
        max_scrolls: int,
        wait_for_main_change: bool = True,
    ) -> dict[str, Any]:
        project = self.expand_project(project_name, exact=project_exact, max_scrolls=max_scrolls)
        if not project.sessions:
            raise RuntimeError(f"Project '{project_name}' has no visible sessions to open.")

        before = tuple(self._main_text_preview())
        session = project.sessions[0]
        self._activate_session_item(session)
        self._wait_for_main_text_change(before, timeout=4.0 if wait_for_main_change else 1.5)
        return {
            "selected_project": project.title,
            "selected_session": session.title,
            "selection_mode": "latest",
            "state": self.snapshot(),
        }

    def archive_session(
        self,
        project_name: str,
        session_name: str,
        *,
        project_exact: bool,
        session_exact: bool,
        max_scrolls: int,
    ) -> dict[str, Any]:
        with _temporarily_disable_screensaver():
            _dismiss_screensaver_or_wake()
            self._ensure_interactive_desktop()

            project, session = self._find_session_for_action(
                project_name=project_name,
                session_name=session_name,
                project_exact=project_exact,
                session_exact=session_exact,
                max_scrolls=max_scrolls,
            )
            self._archive_session_item(session)
            self._wait_for_session_removed(
                project_name=project_name,
                session_name=session_name,
                project_exact=project_exact,
                session_exact=session_exact,
                timeout=4.0,
            )
            return {
                "selected_project": project.title,
                "archived_session": session.title,
                "state": self.snapshot(),
            }

    def open_new_session(
        self,
        project_name: str,
        *,
        project_exact: bool,
        max_scrolls: int,
        wait_for_main_change: bool = True,
    ) -> dict[str, Any]:
        project = self._find_project(project_name, exact=project_exact, max_scrolls=max_scrolls)
        before = tuple(self._main_text_preview())
        new_session_button = project.new_session_button or self._find_project_new_session_button(project)
        if new_session_button is None:
            raise RuntimeError(f"Could not find the new conversation button for project '{project_name}'.")

        self._activate_control(new_session_button, label=f"new conversation in project '{project.title}'")
        changed = self._wait_for_main_text_change(before, timeout=4.0 if wait_for_main_change else 1.5)
        if wait_for_main_change and not changed:
            raise RuntimeError(f"Codex did not open a new conversation for project '{project_name}'.")
        return {
            "selected_project": project.title,
            "selected_session": None,
            "selection_mode": "new-session",
            "state": self.snapshot(),
        }

    def send_message(
        self,
        project_name: str,
        message: str,
        *,
        session_name: str | None,
        new_session: bool,
        project_exact: bool,
        session_exact: bool,
        max_scrolls: int,
    ) -> dict[str, Any]:
        with _temporarily_disable_screensaver():
            _dismiss_screensaver_or_wake()
            self._ensure_interactive_desktop()

            if new_session:
                selection = self.open_new_session(
                    project_name,
                    project_exact=project_exact,
                    max_scrolls=max_scrolls,
                    wait_for_main_change=True,
                )
            elif session_name:
                selection = self.open_session(
                    project_name,
                    session_name,
                    project_exact=project_exact,
                    session_exact=session_exact,
                    max_scrolls=max_scrolls,
                    wait_for_main_change=True,
                )
            else:
                selection = self.open_latest_session(
                    project_name,
                    project_exact=project_exact,
                    max_scrolls=max_scrolls,
                    wait_for_main_change=True,
                )

            before = tuple(self._main_text_preview())
            composer = self._wait_for_composer()
            self._set_composer_text_via_messages(composer, message)
            self._submit_composer_message(composer, before)

        return {
            "selected_project": selection["selected_project"],
            "selected_session": selection["selected_session"],
            "selection_mode": selection.get("selection_mode"),
            "submitted_message": message,
            "state": self.snapshot(),
        }

    def _open_codex_deeplink(self, url: str, *, wait_seconds: float = 1.5) -> None:
        self.activate()
        os.startfile(url)
        time.sleep(wait_seconds)
        self.activate()

    def send_message_current(
        self,
        message: str,
        *,
        session_id: str | None,
        new_session: bool,
    ) -> dict[str, Any]:
        with _temporarily_disable_screensaver():
            _dismiss_screensaver_or_wake()
            self._ensure_interactive_desktop()

            if new_session:
                self._open_codex_deeplink("codex://threads/new")
            elif session_id:
                self._open_codex_deeplink(f"codex://threads/{session_id.strip()}")
            else:
                self.activate()

            before = tuple(self._main_text_preview())
            composer = self._wait_for_composer()
            self._set_composer_text_via_messages(composer, message)
            self._submit_composer_message(composer, before)

        return {
            "selected_project": None,
            "selected_session": session_id,
            "selection_mode": "new-session" if new_session else "current",
            "submitted_message": message,
            "state": self.snapshot(),
        }

    def _wait_for_composer(self, timeout: float = 8.0) -> Any:
        deadline = time.time() + timeout
        last_error: Exception | None = None
        while time.time() < deadline:
            try:
                return self._composer()
            except RuntimeError as exc:
                last_error = exc
                time.sleep(0.2)

        if last_error is not None:
            raise last_error
        raise RuntimeError("Could not find the Codex composer input.")

    def _wait_for_main_text_change(self, before: Iterable[str], timeout: float = 4.0) -> bool:
        expected = tuple(before)
        deadline = time.time() + timeout
        while time.time() < deadline:
            current = tuple(self._main_text_preview())
            if current and current != expected:
                return True
            time.sleep(0.2)
        return False

    def _submit_composer_message(self, composer: Any, before: Iterable[str]) -> None:
        send_button = self._wait_for_send_button(composer.rectangle(), enabled=True)
        try:
            invoke = getattr(send_button, "invoke", None)
            if callable(invoke):
                invoke()
                if self._wait_for_submission_started(composer.rectangle(), before, timeout=4.0):
                    return
            self._click_control_by_message(send_button)
            if self._wait_for_submission_started(composer.rectangle(), before, timeout=4.0):
                return
        except Exception:
            pass

        try:
            self._click_control_by_input(send_button)
            if self._wait_for_submission_started(composer.rectangle(), before, timeout=8.0):
                return
        except Exception:
            pass

        self._activate_control(send_button, label="send button")
        if self._wait_for_submission_started(composer.rectangle(), before, timeout=8.0):
            return

        raise RuntimeError("Codex did not show the submitted message after sending.")

    def _main_text_preview(self, limit: int = 20) -> list[str]:
        lines: list[str] = []
        seen: set[str] = set()
        for element in self._iter_descendants(control_type="Text"):
            try:
                if not element.is_visible():
                    continue
                rect = element.rectangle()
                text = element.window_text().strip()
            except Exception:
                continue

            if not text or rect.left < self.sidebar_right_edge:
                continue

            if text in seen:
                continue
            seen.add(text)
            lines.append(text)

            if len(lines) >= limit:
                break
        return lines

    def _projects_in_view(self) -> list[ProjectRef]:
        project_list = self._project_listbox()
        viewport = self._sidebar_viewport_rect(project_list)
        projects: list[ProjectRef] = []
        for item in project_list.children():
            if item.element_info.control_type != "ListItem":
                continue
            if not _rect_intersects(viewport, item.rectangle()):
                continue
            projects.append(self._parse_project(item, viewport))
        return projects

    def _sidebar_viewport_rect(self, project_list: Any) -> Any:
        try:
            parent = project_list.parent()
            if parent is not None:
                return parent.rectangle()
        except Exception:
            pass
        return project_list.rectangle()

    def _parse_project(self, item: Any, viewport: Any | None) -> ProjectRef:
        button = None
        new_session_button = None
        sessions: list[SessionRef] = []
        expanded = False

        for child in item.children():
            control_type = child.element_info.control_type
            if control_type == "Button" and child.is_visible():
                if button is None:
                    button = child
                if self._is_project_new_session_button(child, item.window_text().strip()):
                    new_session_button = child
            elif control_type == "List":
                expanded = True
                for session_item in child.children():
                    if session_item.element_info.control_type != "ListItem":
                        continue
                    if viewport is not None and not _rect_intersects(viewport, session_item.rectangle()):
                        continue
                    session_button = None
                    for session_child in session_item.children():
                        if session_child.element_info.control_type == "Button" and session_child.is_visible():
                            session_button = session_child
                            break
                    sessions.append(
                        SessionRef(
                            title=session_item.window_text().strip(),
                            rect=_rect_to_list(session_item.rectangle()),
                            item=session_item,
                            button=session_button,
                        )
                    )

        if new_session_button is None:
            project_title = item.window_text().strip()
            for control in item.descendants(control_type="Button"):
                try:
                    if control.is_visible() and self._is_project_new_session_button(control, project_title):
                        new_session_button = control
                        break
                except Exception:
                    continue

        return ProjectRef(
            title=item.window_text().strip(),
            rect=_rect_to_list(item.rectangle()),
            expanded=expanded,
            item=item,
            button=button,
            new_session_button=new_session_button,
            sessions=sessions,
        )

    def _is_project_new_session_button(self, control: Any, project_title: str) -> bool:
        name = _control_name(control)
        normalized_name = name.casefold()
        normalized_project = (project_title or "").casefold()
        if ("开始新对话" in name or "新建任务" in name) and (
            not normalized_project or normalized_project in normalized_name
        ):
            return True
        return (
            "new conversation" in normalized_name or "new task" in normalized_name
        ) and (not normalized_project or normalized_project in normalized_name)

    def _find_project_new_session_button(self, project: ProjectRef) -> Any | None:
        project_title = project.title
        for control in project.item.descendants(control_type="Button"):
            try:
                if control.is_visible() and self._is_project_new_session_button(control, project_title):
                    return control
            except Exception:
                continue
        return None

    def _best_session_match(
        self,
        sessions: list[SessionRef],
        target_title: str,
        *,
        exact: bool,
    ) -> SessionRef | None:
        if exact:
            for session in sessions:
                if _text_matches(session.title, target_title, exact=True):
                    return session
            return None

        exact_matches = [session for session in sessions if _text_matches(session.title, target_title, exact=True)]
        if exact_matches:
            return exact_matches[0]

        partial_matches = [session for session in sessions if _text_matches(session.title, target_title, exact=False)]
        if partial_matches:
            return partial_matches[0]

        return None

    def _find_session_for_action(
        self,
        project_name: str,
        session_name: str,
        *,
        project_exact: bool,
        session_exact: bool,
        max_scrolls: int,
    ) -> tuple[ProjectRef, SessionRef]:
        project = self.expand_project(project_name, exact=project_exact, max_scrolls=max_scrolls)
        seen: set[tuple[str, ...]] = set()

        for _ in range(max_scrolls):
            titles = tuple(session.title for session in project.sessions)
            session = self._best_session_match(project.sessions, session_name, exact=session_exact)
            if session is not None:
                return project, session

            session_anywhere = self._find_session_anywhere(project, session_name, exact=session_exact)
            if session_anywhere is not None and self._scroll_item_into_view(session_anywhere.item):
                project = self._find_project(project_name, exact=project_exact, max_scrolls=max_scrolls, reset_to_top=False)
                session = self._best_session_match(project.sessions, session_name, exact=session_exact)
                if session is not None:
                    return project, session

            if titles in seen:
                break
            seen.add(titles)

            self._scroll_sidebar(-3)
            project = self._find_project_in_current_view(project_name, exact=project_exact)
            if project is None:
                break

        raise RuntimeError(
            f"Session '{session_name}' was not found under project '{project_name}'."
        )

    def _archive_session_item(self, session: SessionRef) -> None:
        self.activate()
        self._move_cursor_to_control(session.item)

        confirm_button = self._find_archive_confirm_control_in_session(session)
        if confirm_button is not None:
            self._activate_control(confirm_button, label=f"archive confirmation for session '{session.title}'")
            return

        archive_button = self._find_archive_control_in_session(session)
        if archive_button is not None:
            self._activate_control(archive_button, label=f"archive button for session '{session.title}'")
            self._confirm_archive_if_needed(session)
            return

        more_button = self._find_more_control_in_session(session)
        if more_button is not None:
            self._activate_control(more_button, label=f"session menu for '{session.title}'")
            archive_menu_item = self._wait_for_archive_popup_item(excluded_text=session.title)
            if archive_menu_item is not None:
                self._activate_control(archive_menu_item, label=f"archive menu item for session '{session.title}'")
                self._confirm_archive_if_needed(session)
                return

        self._right_click_control_by_input(session.button or session.item)
        archive_menu_item = self._wait_for_archive_popup_item(excluded_text=session.title)
        if archive_menu_item is None:
            raise RuntimeError(f"Could not find an Archive action for session '{session.title}'.")

        self._activate_control(archive_menu_item, label=f"archive menu item for session '{session.title}'")
        self._confirm_archive_if_needed(session)

    def _find_archive_control_in_session(self, session: SessionRef) -> Any | None:
        for control_type in ("Button", "MenuItem"):
            for control in session.item.descendants(control_type=control_type):
                try:
                    if control.is_visible() and _looks_like_archive_control(control, excluded_text=session.title):
                        return control
                except Exception:
                    continue
        return None

    def _find_archive_confirm_control_in_session(self, session: SessionRef) -> Any | None:
        candidates: list[Any] = []
        for control in session.item.descendants(control_type="Button"):
            try:
                if control.is_visible() and _looks_like_archive_confirm_control(control):
                    candidates.append(control)
            except Exception:
                continue

        if not candidates:
            return None

        candidates.sort(
            key=lambda control: (
                (control.rectangle().right - control.rectangle().left)
                * (control.rectangle().bottom - control.rectangle().top),
            )
        )
        return candidates[0]

    def _confirm_archive_if_needed(self, session: SessionRef, timeout: float = 2.0) -> None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            confirm_button = self._find_archive_confirm_control_in_session(session)
            if confirm_button is not None:
                self._activate_control(confirm_button, label=f"archive confirmation for session '{session.title}'")
                return
            time.sleep(0.15)

    def _find_more_control_in_session(self, session: SessionRef) -> Any | None:
        for control in session.item.descendants(control_type="Button"):
            try:
                if not control.is_visible():
                    continue
                haystack = f"{_control_name(control)} {_control_class_name(control)}".casefold()
                if any(token in haystack for token in ("more", "options", "menu", "更多", "选项", "菜单", "ellipsis")):
                    return control
            except Exception:
                continue
        return None

    def _wait_for_archive_popup_item(self, timeout: float = 2.5, *, excluded_text: str = "") -> Any | None:
        cursor_x, cursor_y = win32gui.GetCursorPos()
        deadline = time.time() + timeout
        while time.time() < deadline:
            for control in self._iter_visible_desktop_controls(("MenuItem", "Button", "Text")):
                try:
                    rect = control.rectangle()
                    center_x = int((rect.left + rect.right) / 2)
                    center_y = int((rect.top + rect.bottom) / 2)
                except Exception:
                    continue
                is_near_context_menu = abs(center_x - cursor_x) <= 500 and abs(center_y - cursor_y) <= 500
                if is_near_context_menu and _looks_like_archive_control(control, excluded_text=excluded_text):
                    return control
            time.sleep(0.15)
        return None

    def _wait_for_session_removed(
        self,
        project_name: str,
        session_name: str,
        *,
        project_exact: bool,
        session_exact: bool,
        timeout: float,
    ) -> None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            project = self._find_project_in_current_view(project_name, exact=project_exact)
            if project is not None:
                session = self._best_session_match(project.sessions, session_name, exact=session_exact)
                if session is None:
                    return
            time.sleep(0.2)
        raise RuntimeError(f"Archive action did not remove session '{session_name}' from the visible list.")

    def _project_listbox(self) -> Any:
        lists = self._visible_sidebar_lists()
        if not lists:
            self._show_sidebar_if_hidden()
            deadline = time.time() + 2.5
            while time.time() < deadline and not lists:
                lists = self._visible_sidebar_lists()
                if lists:
                    break
                time.sleep(0.15)
        if not lists:
            self._refresh_window_binding()
            self.activate()
            self._show_sidebar_if_hidden()
            lists = self._visible_sidebar_lists()
        root_lists = [element for element in lists if not element.window_text().strip()]
        candidates = root_lists or lists
        if not candidates:
            raise RuntimeError("Could not find the Codex sidebar project list.")
        candidates.sort(
            key=lambda element: (
                -sum(1 for child in element.children() if child.element_info.control_type == "ListItem"),
                element.rectangle().top,
                element.rectangle().left,
            )
        )
        return candidates[0]

    def _visible_sidebar_lists(self) -> list[Any]:
        return [
            element
            for element in self._iter_descendants(control_type="List")
            if element.is_visible() and element.rectangle().left < self.sidebar_right_edge
        ]

    def _show_sidebar_if_hidden(self) -> None:
        for element in self._iter_descendants(control_type="Button"):
            try:
                if not element.is_visible():
                    continue
                if _normalize(_control_name(element)) != "显示边栏":
                    continue
                self._activate_control(element, label="show sidebar button")
                time.sleep(max(0.4, self.click_delay))
                return
            except Exception:
                continue

    def _wait_for_project_expanded(self, project_name: str, *, exact: bool, timeout: float = 2.5) -> ProjectRef | None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            refreshed = self._find_project(
                project_name,
                exact=exact,
                max_scrolls=3,
                reset_to_top=False,
            )
            if refreshed.expanded:
                return refreshed
            time.sleep(0.2)
        return None

    def _scroll_item_into_view(self, control: Any) -> bool:
        try:
            control.iface_scroll_item.ScrollIntoView()
            time.sleep(self.scroll_delay)
            return True
        except Exception:
            return False

    def _scroll_sidebar(self, wheel_dist: int) -> None:
        project_list = self._project_listbox()
        try:
            project_list.set_focus()
            key = "{PGUP}" if wheel_dist > 0 else "{PGDN}"
            count = max(1, abs(wheel_dist))
            project_list.type_keys(key * count, pause=0.02, set_foreground=False)
            time.sleep(self.scroll_delay)
            return
        except Exception:
            pass

        rect = project_list.rectangle()
        center = (
            int((rect.left + rect.right) / 2),
            int((rect.top + rect.bottom) / 2),
        )
        self._post_mouse_wheel(center[0], center[1], wheel_dist)
        time.sleep(self.scroll_delay)

    def _reset_sidebar_to_top(self) -> None:
        for _ in range(12):
            self._scroll_sidebar(3)

    def _find_project(
        self,
        project_name: str,
        *,
        exact: bool,
        max_scrolls: int,
        reset_to_top: bool = True,
    ) -> ProjectRef:
        self.activate()
        project = self._find_project_in_current_view(project_name, exact=exact)
        if project is not None:
            return project

        project_anywhere = self._find_project_anywhere(project_name, exact=exact)
        if project_anywhere is not None and self._scroll_item_into_view(project_anywhere.item):
            project = self._find_project_in_current_view(project_name, exact=exact)
            if project is not None:
                return project

        if reset_to_top:
            self._reset_sidebar_to_top()

        seen: set[tuple[str, ...]] = set()
        for _ in range(max_scrolls):
            project = self._find_project_in_current_view(project_name, exact=exact)
            if project is not None:
                return project

            names = tuple(project.title for project in self._projects_in_view())
            if names in seen:
                break
            seen.add(names)
            self._scroll_sidebar(-3)

        raise RuntimeError(f"Project '{project_name}' was not found in the Codex sidebar.")

    def _find_project_in_current_view(self, project_name: str, *, exact: bool) -> ProjectRef | None:
        for project in self._projects_in_view():
            if _text_matches(project.title, project_name, exact=exact):
                return project
        return None

    def _find_project_anywhere(self, project_name: str, *, exact: bool) -> ProjectRef | None:
        project_list = self._project_listbox()
        for item in project_list.children():
            if item.element_info.control_type != "ListItem":
                continue
            project = self._parse_project(item, viewport=None)
            if _text_matches(project.title, project_name, exact=exact):
                return project
        return None

    def _find_session_anywhere(
        self,
        project: ProjectRef,
        session_name: str,
        *,
        exact: bool,
    ) -> SessionRef | None:
        for child in project.item.children():
            if child.element_info.control_type != "List":
                continue
            sessions: list[SessionRef] = []
            for session_item in child.children():
                if session_item.element_info.control_type != "ListItem":
                    continue
                session_button = None
                for session_child in session_item.children():
                    if session_child.element_info.control_type == "Button" and session_child.is_visible():
                        session_button = session_child
                        break
                sessions.append(
                    SessionRef(
                        title=session_item.window_text().strip(),
                        rect=_rect_to_list(session_item.rectangle()),
                        item=session_item,
                        button=session_button,
                    )
                )
            return self._best_session_match(sessions, session_name, exact=exact)
        return None

    def _composer(self) -> Any:
        window_rect = self.window.rectangle()
        window_height = max(1, int(window_rect.bottom - window_rect.top))
        # Existing conversations keep the composer near the bottom, but a fresh
        # Codex desktop conversation centers the composer in the main pane.
        composer_region_top = int(window_rect.bottom - max(760, window_height * 0.60))
        composers = []

        for element in self._iter_descendants():
            try:
                if not element.is_visible():
                    continue
                rect = element.rectangle()
                if rect.left < self.sidebar_right_edge or rect.bottom < composer_region_top:
                    continue
                if rect.width() < 240 or rect.height() < 20 or rect.height() > 320:
                    continue
                control_type = getattr(element.element_info, "control_type", "") or ""
                class_name = getattr(element.element_info, "class_name", "") or ""
                name = _control_name(element)
                haystack = f"{name} {class_name}".casefold()

                score = 0
                if "ProseMirror" in class_name:
                    score += 100
                if control_type in {"Edit", "Document"}:
                    score += 30
                if any(token in haystack for token in ("要求后续变更", "message", "输入", "ask")):
                    score += 20
                if score <= 0:
                    continue
                composers.append((score, element))
            except Exception:
                continue

        if not composers:
            raise RuntimeError(
                "Could not find the Codex composer input "
                f"(window={_rect_to_list(window_rect)}, composer_region_top={composer_region_top})."
            )

        composers.sort(
            key=lambda item: (
                item[0],
                item[1].rectangle().bottom,
                item[1].rectangle().left,
            ),
            reverse=True,
        )
        return composers[0][1]

    def _composer_send_button(self, composer_rect: Any) -> Any:
        candidates = []
        for element in self._iter_descendants(control_type="Button"):
            try:
                if not element.is_visible():
                    continue
                rect = element.rectangle()
                if rect.left < self.sidebar_right_edge:
                    continue
                if rect.top < composer_rect.top + 40:
                    continue
                if rect.left < composer_rect.left:
                    continue
                if rect.width() > 90 or rect.height() > 90:
                    continue
                candidates.append(element)
            except Exception:
                continue

        if not candidates:
            raise RuntimeError("Could not find the Codex composer submit button.")

        candidates.sort(
            key=lambda element: (
                1 if _looks_like_send_button(element) else 0,
                element.rectangle().right,
                element.rectangle().bottom,
            ),
            reverse=True,
        )
        return candidates[0]

    def _wait_for_send_button(self, composer_rect: Any, timeout: float = 1.5, *, enabled: bool = False) -> Any:
        deadline = time.time() + timeout
        fallback = None
        while time.time() < deadline:
            button = self._composer_send_button(composer_rect)
            if _looks_like_send_button(button) and (not enabled or _looks_enabled(button)):
                return button
            fallback = button
            time.sleep(0.1)

        if fallback is not None and (not enabled or _looks_enabled(fallback)):
            return fallback
        button = self._composer_send_button(composer_rect)
        if enabled and not _looks_enabled(button):
            raise RuntimeError("Codex composer submit button is still disabled after entering text.")
        return button

    def _wait_for_submission_started(self, composer_rect: Any, before: Iterable[str], timeout: float = 8.0) -> bool:
        expected = tuple(before)
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                button = self._composer_send_button(composer_rect)
                if _looks_like_send_button(button) and not _looks_enabled(button):
                    return True
            except Exception:
                pass

            current = tuple(self._main_text_preview())
            if current and current != expected:
                return True

            time.sleep(0.2)
        return False

    def _window_client_point(self, screen_x: int, screen_y: int) -> tuple[int, int]:
        left, top, _, _ = win32gui.GetWindowRect(self.window.handle)
        return int(screen_x - left), int(screen_y - top)

    def _make_lparam(self, x: int, y: int) -> int:
        return win32api.MAKELONG(int(x), int(y))

    def _click_control_by_message(self, control: Any) -> None:
        rect = control.rectangle()
        center_x = int((rect.left + rect.right) / 2)
        center_y = int((rect.top + rect.bottom) / 2)
        client_x, client_y = self._window_client_point(center_x, center_y)
        lparam = self._make_lparam(client_x, client_y)
        win32gui.SendMessage(self.window.handle, win32con.WM_MOUSEMOVE, 0, lparam)
        win32gui.SendMessage(self.window.handle, win32con.WM_LBUTTONDOWN, win32con.MK_LBUTTON, lparam)
        win32gui.SendMessage(self.window.handle, win32con.WM_LBUTTONUP, 0, lparam)
        time.sleep(self.click_delay)

    def _click_control_by_input(self, control: Any) -> None:
        self.activate()
        rect = control.rectangle()
        center_x = int((rect.left + rect.right) / 2)
        center_y = int((rect.top + rect.bottom) / 2)
        absolute_x, absolute_y = _screen_point_to_absolute(center_x, center_y)
        win32api.SetCursorPos((center_x, center_y))
        clicked = _send_input_events(
            [
                _mouse_event_input(
                    absolute_x,
                    absolute_y,
                    MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE,
                ),
                _mouse_event_input(0, 0, MOUSEEVENTF_LEFTDOWN),
                _mouse_event_input(0, 0, MOUSEEVENTF_LEFTUP),
            ]
        )
        if not clicked:
            win32api.mouse_event(win32con.MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
            time.sleep(0.05)
            win32api.mouse_event(win32con.MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
        time.sleep(self.click_delay)

    def _move_cursor_to_control(self, control: Any) -> None:
        rect = control.rectangle()
        center_x = int((rect.left + rect.right) / 2)
        center_y = int((rect.top + rect.bottom) / 2)
        absolute_x, absolute_y = _screen_point_to_absolute(center_x, center_y)
        win32api.SetCursorPos((center_x, center_y))
        _send_input_events(
            [
                _mouse_event_input(
                    absolute_x,
                    absolute_y,
                    MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE,
                )
            ]
        )
        time.sleep(self.click_delay)

    def _right_click_control_by_input(self, control: Any) -> None:
        self.activate()
        self._move_cursor_to_control(control)
        clicked = _send_input_events(
            [
                _mouse_event_input(0, 0, MOUSEEVENTF_RIGHTDOWN),
                _mouse_event_input(0, 0, MOUSEEVENTF_RIGHTUP),
            ]
        )
        if not clicked:
            win32api.mouse_event(win32con.MOUSEEVENTF_RIGHTDOWN, 0, 0, 0, 0)
            time.sleep(0.05)
            win32api.mouse_event(win32con.MOUSEEVENTF_RIGHTUP, 0, 0, 0, 0)
        time.sleep(self.click_delay)

    def _post_mouse_wheel(self, screen_x: int, screen_y: int, wheel_dist: int) -> None:
        if wheel_dist == 0:
            return

        wparam = ((wheel_dist * win32con.WHEEL_DELTA) & 0xFFFF) << 16
        lparam = self._make_lparam(screen_x, screen_y)
        win32gui.SendMessage(self.window.handle, win32con.WM_MOUSEWHEEL, wparam, lparam)

    def _post_key(self, vk: int) -> None:
        win32gui.PostMessage(self.window.handle, win32con.WM_KEYDOWN, vk, 0)
        win32gui.PostMessage(self.window.handle, win32con.WM_KEYUP, vk, 0)

    def _render_widget_handle(self) -> int:
        hwnd = win32gui.FindWindowEx(self.window.handle, 0, "Chrome_RenderWidgetHostHWND", None)
        return hwnd or self.window.handle

    def _post_text(self, value: str) -> None:
        target = self._render_widget_handle()
        utf16 = value.encode("utf-16-le")
        for index in range(0, len(utf16), 2):
            code_unit = int.from_bytes(utf16[index : index + 2], "little")
            win32gui.PostMessage(target, win32con.WM_CHAR, code_unit, 0)

    def _send_text_with_window_messages(self, composer: Any, value: str) -> None:
        self._focus_composer(composer)
        self._post_text(value)
        time.sleep(max(0.35, self.click_delay))

    def _clear_composer_text_with_window_messages(self, composer: Any) -> bool:
        self._focus_composer(composer)
        try:
            composer.iface_text.DocumentRange.Select()
        except Exception:
            return False

        target = self._render_widget_handle()
        for vk in (win32con.VK_DELETE, win32con.VK_BACK):
            win32gui.PostMessage(target, win32con.WM_KEYDOWN, vk, 0)
            win32gui.PostMessage(target, win32con.WM_KEYUP, vk, 0)
            time.sleep(max(0.2, self.click_delay))
            if not self._composer_has_enabled_send_button(composer):
                return True
        return not self._composer_has_enabled_send_button(composer)

    def _focus_composer(self, composer: Any) -> None:
        self._click_control_by_input(composer)
        try:
            composer.set_focus()
        except Exception:
            pass
        time.sleep(self.click_delay / 2)

    def _composer_has_enabled_send_button(self, composer: Any) -> bool:
        try:
            button = self._composer_send_button(composer.rectangle())
            return _looks_like_send_button(button) and _looks_enabled(button)
        except Exception:
            return False

    def _clear_composer_text(self, composer: Any) -> None:
        if self._clear_composer_text_with_window_messages(composer):
            return

        self._focus_composer(composer)
        for vk in (win32con.VK_BACK, win32con.VK_DELETE):
            _tap_key_combo((win32con.VK_CONTROL,), ord("A"))
            time.sleep(0.05)
            _tap_key(vk)
            time.sleep(max(0.2, self.click_delay))
            if not self._composer_has_enabled_send_button(composer):
                return

    def _set_composer_text_via_messages(self, composer: Any, value: str) -> None:
        self._clear_composer_text(composer)

        if value:
            if self._composer_has_enabled_send_button(composer):
                raise RuntimeError("Codex composer still contains unsent text after clearing; refusing to append a new message.")

            try:
                self._send_text_with_window_messages(composer, value)
                self._wait_for_send_button(composer.rectangle(), timeout=4.0, enabled=True)
                return
            except Exception as exc:
                self._clear_composer_text(composer)
                raise RuntimeError(f"Codex composer window message input failed: {exc}") from exc

        time.sleep(max(0.35, self.click_delay))

        if value:
            self._wait_for_send_button(composer.rectangle(), timeout=4.0, enabled=True)

    def _iter_descendants(self, control_type: str | None = None) -> Iterable[Any]:
        for element_info in self.window.element_info.descendants(control_type=control_type):
            if not getattr(element_info, "control_type", None):
                continue
            try:
                yield UIAWrapper(element_info)
            except Exception:
                continue

    def _iter_visible_desktop_controls(self, control_types: tuple[str, ...]) -> Iterable[Any]:
        desktop = Desktop(backend="uia")
        for top_window in desktop.windows():
            try:
                root_info = top_window.element_info
            except Exception:
                continue

            for control_type in control_types:
                element_infos = []
                if getattr(root_info, "control_type", None) == control_type:
                    element_infos.append(root_info)
                try:
                    element_infos.extend(root_info.descendants(control_type=control_type))
                except Exception:
                    continue

                for element_info in element_infos:
                    try:
                        control = UIAWrapper(element_info)
                        if control.is_visible():
                            yield control
                    except Exception:
                        continue


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Automate the Codex desktop app through UIA.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    for name in ("dump-state", "list-projects"):
        command = subparsers.add_parser(name)
        command.add_argument("--json", action="store_true")

    list_sessions = subparsers.add_parser("list-sessions")
    list_sessions.add_argument("--project", required=True)
    list_sessions.add_argument("--project-b64")
    list_sessions.add_argument("--project-contains", action="store_true")
    list_sessions.add_argument("--expand", action="store_true")
    list_sessions.add_argument("--max-scrolls", type=int, default=25)
    list_sessions.add_argument("--json", action="store_true")

    expand_project = subparsers.add_parser("expand-project")
    expand_project.add_argument("--project", required=True)
    expand_project.add_argument("--project-b64")
    expand_project.add_argument("--project-contains", action="store_true")
    expand_project.add_argument("--max-scrolls", type=int, default=25)
    expand_project.add_argument("--json", action="store_true")

    open_session = subparsers.add_parser("open-session")
    open_session.add_argument("--project", required=True)
    open_session.add_argument("--session", required=True)
    open_session.add_argument("--project-b64")
    open_session.add_argument("--session-b64")
    open_session.add_argument("--project-contains", action="store_true")
    open_session.add_argument("--session-exact", action="store_true")
    open_session.add_argument("--max-scrolls", type=int, default=25)
    open_session.add_argument("--json", action="store_true")

    archive_session = subparsers.add_parser("archive-session")
    archive_session.add_argument("--project", required=True)
    archive_session.add_argument("--session", required=True)
    archive_session.add_argument("--project-b64")
    archive_session.add_argument("--session-b64")
    archive_session.add_argument("--project-contains", action="store_true")
    archive_session.add_argument("--session-exact", action="store_true")
    archive_session.add_argument("--max-scrolls", type=int, default=25)
    archive_session.add_argument("--json", action="store_true")

    open_latest = subparsers.add_parser("open-latest-session")
    open_latest.add_argument("--project", required=True)
    open_latest.add_argument("--project-b64")
    open_latest.add_argument("--project-contains", action="store_true")
    open_latest.add_argument("--max-scrolls", type=int, default=25)
    open_latest.add_argument("--json", action="store_true")

    send_message = subparsers.add_parser("send-message")
    send_message.add_argument("--project", required=True)
    send_message.add_argument("--session")
    send_message.add_argument("--new-session", action="store_true")
    send_message.add_argument("--project-b64")
    send_message.add_argument("--session-b64")
    send_message.add_argument("--project-contains", action="store_true")
    send_message.add_argument("--session-exact", action="store_true")
    send_message.add_argument("--max-scrolls", type=int, default=25)
    send_message.add_argument("--message")
    send_message.add_argument("--message-file")
    send_message.add_argument("--json", action="store_true")

    send_message_current = subparsers.add_parser("send-message-current")
    send_message_current.add_argument("--session-id")
    send_message_current.add_argument("--new-session", action="store_true")
    send_message_current.add_argument("--message")
    send_message_current.add_argument("--message-file")
    send_message_current.add_argument("--json", action="store_true")

    subparsers.add_parser("worker")

    return parser


def _load_message_text(args: argparse.Namespace) -> str:
    if args.message and args.message_file:
        raise SystemExit("Use either --message or --message-file, not both.")

    if args.message_file:
        return Path(args.message_file).read_text(encoding="utf-8")

    if args.message:
        return args.message

    raise SystemExit("send-message requires --message or --message-file.")


def _emit(payload: Any, as_json: bool) -> None:
    print(_render_payload(payload, as_json))


def _render_payload(payload: Any, as_json: bool) -> str:
    if as_json:
        return json.dumps(payload, ensure_ascii=False, indent=2)

    if isinstance(payload, dict):
        return json.dumps(payload, ensure_ascii=False, indent=2)

    if isinstance(payload, list):
        return "\n".join(json.dumps(entry, ensure_ascii=False) for entry in payload)

    return str(payload)


def _execute_command(automation: CodexDesktopAutomation, args: argparse.Namespace) -> Any:
    if args.command == "dump-state":
        return automation.snapshot()

    if args.command == "list-projects":
        return automation.list_projects()

    if args.command == "list-sessions":
        project_name = _decode_text_argument(args.project, args.project_b64, "project")
        return automation.list_sessions(
            project_name=project_name,
            project_exact=not args.project_contains,
            max_scrolls=args.max_scrolls,
            expand=args.expand,
        )

    if args.command == "expand-project":
        project_name = _decode_text_argument(args.project, args.project_b64, "project")
        return automation.expand_project(
            project_name=project_name,
            exact=not args.project_contains,
            max_scrolls=args.max_scrolls,
        ).to_json()

    if args.command == "open-session":
        project_name = _decode_text_argument(args.project, args.project_b64, "project")
        session_name = _decode_text_argument(args.session, args.session_b64, "session")
        return automation.open_session(
            project_name=project_name,
            session_name=session_name,
            project_exact=not args.project_contains,
            session_exact=args.session_exact,
            max_scrolls=args.max_scrolls,
        )

    if args.command == "archive-session":
        project_name = _decode_text_argument(args.project, args.project_b64, "project")
        session_name = _decode_text_argument(args.session, args.session_b64, "session")
        return automation.archive_session(
            project_name=project_name,
            session_name=session_name,
            project_exact=not args.project_contains,
            session_exact=args.session_exact,
            max_scrolls=args.max_scrolls,
        )

    if args.command == "open-latest-session":
        project_name = _decode_text_argument(args.project, args.project_b64, "project")
        return automation.open_latest_session(
            project_name=project_name,
            project_exact=not args.project_contains,
            max_scrolls=args.max_scrolls,
        )

    if args.command == "send-message":
        project_name = _decode_text_argument(args.project, args.project_b64, "project")
        session_name = _decode_text_argument(args.session, args.session_b64, "session") if args.session or args.session_b64 else None
        if args.new_session and session_name:
            raise SystemExit("Use either --new-session or --session, not both.")
        return automation.send_message(
            project_name=project_name,
            message=_load_message_text(args),
            session_name=session_name,
            new_session=args.new_session,
            project_exact=not args.project_contains,
            session_exact=args.session_exact,
            max_scrolls=args.max_scrolls,
        )

    if args.command == "send-message-current":
        if args.new_session and args.session_id:
            raise SystemExit("Use either --new-session or --session-id, not both.")
        return automation.send_message_current(
            message=_load_message_text(args),
            session_id=args.session_id,
            new_session=args.new_session,
        )

    raise RuntimeError(f"Unsupported command: {args.command}")


def _run_worker() -> int:
    parser = _build_parser()
    automation = CodexDesktopAutomation()
    print(json.dumps({"event": "ready"}, ensure_ascii=False), flush=True)

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue

        request_id: Any = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            argv = request.get("argv")

            if request_id is None:
                raise ValueError("Worker request is missing 'id'.")
            if not isinstance(argv, list) or not all(isinstance(entry, str) for entry in argv):
                raise ValueError("Worker request 'argv' must be a list of strings.")

            args = parser.parse_args(argv)
            if args.command == "worker":
                raise ValueError("Nested worker command is not allowed.")

            payload = _execute_command(automation, args)
            response = {
                "id": request_id,
                "ok": True,
                "payload": payload,
                "asJson": bool(getattr(args, "json", False)),
            }
        except SystemExit as exc:
            response = {
                "id": request_id,
                "ok": False,
                "error": f"Argument parsing failed with exit code {exc.code}.",
            }
        except Exception as exc:  # pragma: no cover - exercised via desktop automation bridge
            response = {
                "id": request_id,
                "ok": False,
                "error": str(exc) or exc.__class__.__name__,
                "traceback": traceback.format_exc(limit=6),
            }

        print(json.dumps(response, ensure_ascii=False), flush=True)

    return 0


def main() -> int:
    _configure_stdio()
    parser = _build_parser()
    args = parser.parse_args()
    if args.command == "worker":
        return _run_worker()

    automation = CodexDesktopAutomation()
    payload = _execute_command(automation, args)
    _emit(payload, as_json=bool(getattr(args, "json", False)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
