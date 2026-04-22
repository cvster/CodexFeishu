from __future__ import annotations

import argparse
import json
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, List

try:
    from pywinauto import Desktop, clipboard, mouse
    from pywinauto.controls.uiawrapper import UIAWrapper
    from pywinauto.keyboard import send_keys
except ImportError as exc:  # pragma: no cover - exercised through the wrapper
    raise SystemExit(
        "pywinauto is required. Run scripts\\run-codex-desktop-automation.ps1 "
        "to bootstrap the automation environment."
    ) from exc


SIDEBAR_RIGHT_EDGE = 650


def _configure_stdio() -> None:
    for stream_name in ("stdout", "stderr"):
        stream = getattr(sys, stream_name, None)
        if stream and hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")


def _rect_to_list(rect: Any) -> list[int]:
    return [int(rect.left), int(rect.top), int(rect.right), int(rect.bottom)]


def _normalize(value: str) -> str:
    return value.strip().casefold()


def _text_matches(candidate: str, target: str, exact: bool) -> bool:
    normalized_candidate = _normalize(candidate)
    normalized_target = _normalize(target)
    if exact:
        return normalized_candidate == normalized_target
    return normalized_target in normalized_candidate


@dataclass
class SessionRef:
    title: str
    rect: list[int]
    item: Any

    def to_json(self) -> dict[str, Any]:
        return {"title": self.title, "rect": self.rect}


@dataclass
class ProjectRef:
    title: str
    rect: list[int]
    expanded: bool
    item: Any
    button: Any | None
    sessions: list[SessionRef]

    def to_json(self) -> dict[str, Any]:
        return {
            "title": self.title,
            "rect": self.rect,
            "expanded": self.expanded,
            "sessions": [session.to_json() for session in self.sessions],
        }


class CodexDesktopAutomation:
    def __init__(
        self,
        sidebar_right_edge: int = SIDEBAR_RIGHT_EDGE,
        click_delay: float = 0.6,
        scroll_delay: float = 0.2,
    ) -> None:
        self.sidebar_right_edge = sidebar_right_edge
        self.click_delay = click_delay
        self.scroll_delay = scroll_delay
        self.window_spec = Desktop(backend="uia").window(
            title="Codex",
            class_name="Chrome_WidgetWin_1",
        )
        self.window_spec.wait("exists enabled visible ready", timeout=10)
        self.window = self.window_spec.wrapper_object()

    def activate(self) -> None:
        self.window.set_focus()
        time.sleep(self.click_delay)

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
        clickable.click_input()
        time.sleep(self.click_delay)
        refreshed = self._find_project(
            project_name,
            exact=exact,
            max_scrolls=3,
            reset_to_top=False,
        )
        if not refreshed.expanded:
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
    ) -> dict[str, Any]:
        project = self.expand_project(project_name, exact=project_exact, max_scrolls=max_scrolls)
        before = tuple(self._main_text_preview())
        seen: set[tuple[str, ...]] = set()

        for _ in range(max_scrolls):
            titles = tuple(session.title for session in project.sessions)
            for session in project.sessions:
                if _text_matches(session.title, session_name, exact=session_exact):
                    session.item.click_input()
                    time.sleep(self.click_delay)
                    self._wait_for_main_text_change(before)
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
    ) -> dict[str, Any]:
        project = self.expand_project(project_name, exact=project_exact, max_scrolls=max_scrolls)
        if not project.sessions:
            raise RuntimeError(f"Project '{project_name}' has no visible sessions to open.")

        before = tuple(self._main_text_preview())
        session = project.sessions[0]
        session.item.click_input()
        time.sleep(self.click_delay)
        self._wait_for_main_text_change(before)
        return {
            "selected_project": project.title,
            "selected_session": session.title,
            "selection_mode": "latest",
            "state": self.snapshot(),
        }

    def send_message(
        self,
        project_name: str,
        message: str,
        *,
        session_name: str | None,
        project_exact: bool,
        session_exact: bool,
        max_scrolls: int,
    ) -> dict[str, Any]:
        if session_name:
            selection = self.open_session(
                project_name,
                session_name,
                project_exact=project_exact,
                session_exact=session_exact,
                max_scrolls=max_scrolls,
            )
        else:
            selection = self.open_latest_session(
                project_name,
                project_exact=project_exact,
                max_scrolls=max_scrolls,
            )

        before = tuple(self._main_text_preview())
        composer = self._composer()
        composer.click_input()
        time.sleep(self.click_delay / 2)

        # Reset any existing draft before pasting the bridged mobile prompt.
        send_keys("^a{BACKSPACE}", pause=0.02)
        self._set_clipboard_text(message)
        send_keys("^v", pause=0.02)
        time.sleep(self.click_delay / 2)

        send_button = self._composer_send_button(composer.rectangle())
        send_button.click_input()
        self._wait_for_main_text_change(before, timeout=8.0)

        return {
            "selected_project": selection["selected_project"],
            "selected_session": selection["selected_session"],
            "submitted_message": message,
            "state": self.snapshot(),
        }

    def _wait_for_main_text_change(self, before: Iterable[str], timeout: float = 4.0) -> None:
        expected = tuple(before)
        deadline = time.time() + timeout
        while time.time() < deadline:
            current = tuple(self._main_text_preview())
            if current and current != expected:
                return
            time.sleep(0.2)

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
        projects: list[ProjectRef] = []
        for item in project_list.children():
            if item.element_info.control_type != "ListItem":
                continue
            projects.append(self._parse_project(item))
        return projects

    def _parse_project(self, item: Any) -> ProjectRef:
        button = None
        sessions: list[SessionRef] = []
        expanded = False

        for child in item.children():
            control_type = child.element_info.control_type
            if control_type == "Button" and child.is_visible():
                if button is None:
                    button = child
            elif control_type == "List":
                expanded = True
                for session_item in child.children():
                    if session_item.element_info.control_type != "ListItem":
                        continue
                    sessions.append(
                        SessionRef(
                            title=session_item.window_text().strip(),
                            rect=_rect_to_list(session_item.rectangle()),
                            item=session_item,
                        )
                    )

        return ProjectRef(
            title=item.window_text().strip(),
            rect=_rect_to_list(item.rectangle()),
            expanded=expanded,
            item=item,
            button=button,
            sessions=sessions,
        )

    def _project_listbox(self) -> Any:
        lists = [
            element
            for element in self._iter_descendants(control_type="List")
            if element.is_visible() and element.rectangle().left < self.sidebar_right_edge
        ]
        root_lists = [element for element in lists if not element.window_text().strip()]
        if not root_lists:
            raise RuntimeError("Could not find the Codex sidebar project list.")
        root_lists.sort(key=lambda element: (element.rectangle().top, element.rectangle().left))
        return root_lists[0]

    def _scroll_sidebar(self, wheel_dist: int) -> None:
        project_list = self._project_listbox()
        rect = project_list.rectangle()
        center = (
            int((rect.left + rect.right) / 2),
            int((rect.top + rect.bottom) / 2),
        )
        mouse.scroll(coords=center, wheel_dist=wheel_dist)
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

    def _composer(self) -> Any:
        composers = []
        for element in self._iter_descendants(control_type="Group"):
            try:
                if not element.is_visible():
                    continue
                rect = element.rectangle()
                if rect.left < self.sidebar_right_edge or rect.bottom < 1100:
                    continue
                class_name = getattr(element.element_info, "class_name", "") or ""
                if "ProseMirror" not in class_name:
                    continue
                composers.append(element)
            except Exception:
                continue

        if not composers:
            raise RuntimeError("Could not find the Codex composer input.")

        composers.sort(key=lambda element: (element.rectangle().bottom, element.rectangle().left), reverse=True)
        return composers[0]

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
                element.rectangle().right,
                element.rectangle().bottom,
            ),
            reverse=True,
        )
        return candidates[0]

    def _set_clipboard_text(self, value: str) -> None:
        win32clipboard = clipboard.win32clipboard
        win32clipboard.OpenClipboard()
        try:
            win32clipboard.EmptyClipboard()
            win32clipboard.SetClipboardText(value)
        finally:
            win32clipboard.CloseClipboard()

    def _iter_descendants(self, control_type: str | None = None) -> Iterable[Any]:
        for element_info in self.window.element_info.descendants(control_type=control_type):
            if not getattr(element_info, "control_type", None):
                continue
            try:
                yield UIAWrapper(element_info)
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
    list_sessions.add_argument("--project-contains", action="store_true")
    list_sessions.add_argument("--expand", action="store_true")
    list_sessions.add_argument("--max-scrolls", type=int, default=25)
    list_sessions.add_argument("--json", action="store_true")

    expand_project = subparsers.add_parser("expand-project")
    expand_project.add_argument("--project", required=True)
    expand_project.add_argument("--project-contains", action="store_true")
    expand_project.add_argument("--max-scrolls", type=int, default=25)
    expand_project.add_argument("--json", action="store_true")

    open_session = subparsers.add_parser("open-session")
    open_session.add_argument("--project", required=True)
    open_session.add_argument("--session", required=True)
    open_session.add_argument("--project-contains", action="store_true")
    open_session.add_argument("--session-exact", action="store_true")
    open_session.add_argument("--max-scrolls", type=int, default=25)
    open_session.add_argument("--json", action="store_true")

    open_latest = subparsers.add_parser("open-latest-session")
    open_latest.add_argument("--project", required=True)
    open_latest.add_argument("--project-contains", action="store_true")
    open_latest.add_argument("--max-scrolls", type=int, default=25)
    open_latest.add_argument("--json", action="store_true")

    send_message = subparsers.add_parser("send-message")
    send_message.add_argument("--project", required=True)
    send_message.add_argument("--session")
    send_message.add_argument("--project-contains", action="store_true")
    send_message.add_argument("--session-exact", action="store_true")
    send_message.add_argument("--max-scrolls", type=int, default=25)
    send_message.add_argument("--message")
    send_message.add_argument("--message-file")
    send_message.add_argument("--json", action="store_true")

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
    if as_json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return

    if isinstance(payload, dict):
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return

    if isinstance(payload, list):
        for entry in payload:
            print(json.dumps(entry, ensure_ascii=False))
        return

    print(payload)


def main() -> int:
    _configure_stdio()
    parser = _build_parser()
    args = parser.parse_args()
    automation = CodexDesktopAutomation()

    if args.command == "dump-state":
        _emit(automation.snapshot(), as_json=args.json)
        return 0

    if args.command == "list-projects":
        _emit(automation.list_projects(), as_json=args.json)
        return 0

    if args.command == "list-sessions":
        payload = automation.list_sessions(
            project_name=args.project,
            project_exact=not args.project_contains,
            max_scrolls=args.max_scrolls,
            expand=args.expand,
        )
        _emit(payload, as_json=args.json)
        return 0

    if args.command == "expand-project":
        payload = automation.expand_project(
            project_name=args.project,
            exact=not args.project_contains,
            max_scrolls=args.max_scrolls,
        ).to_json()
        _emit(payload, as_json=args.json)
        return 0

    if args.command == "open-session":
        payload = automation.open_session(
            project_name=args.project,
            session_name=args.session,
            project_exact=not args.project_contains,
            session_exact=args.session_exact,
            max_scrolls=args.max_scrolls,
        )
        _emit(payload, as_json=args.json)
        return 0

    if args.command == "open-latest-session":
        payload = automation.open_latest_session(
            project_name=args.project,
            project_exact=not args.project_contains,
            max_scrolls=args.max_scrolls,
        )
        _emit(payload, as_json=args.json)
        return 0

    if args.command == "send-message":
        payload = automation.send_message(
            project_name=args.project,
            message=_load_message_text(args),
            session_name=args.session,
            project_exact=not args.project_contains,
            session_exact=args.session_exact,
            max_scrolls=args.max_scrolls,
        )
        _emit(payload, as_json=args.json)
        return 0

    parser.error(f"Unsupported command: {args.command}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
