import json
import re
from pathlib import Path

BUILTIN_TOOLS = ["Task", "Bash", "Glob", "Grep", "Read", "Edit", "Write", "NotebookEdit",
                 "WebFetch", "WebSearch", "TodoWrite", "BashOutput", "KillShell", "SlashCommand"]
MODELS = ["default", "opus", "sonnet", "haiku", "fable"]
EFFORTS = ["low", "medium", "high", "xhigh", "max"]
PERMISSION_MODES = ["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"]

HOME = Path.home() / ".claude"


def _front(p: Path) -> dict:
    """Minimal YAML front-matter reader (name/description only)."""
    try:
        txt = p.read_text(errors="replace")[:4000]
    except OSError:
        return {}
    m = re.match(r"^---\n(.*?)\n---", txt, re.S)
    out = {}
    if m:
        for line in m.group(1).splitlines():
            if ":" in line and not line.startswith(" "):
                k, v = line.split(":", 1)
                out[k.strip()] = v.strip().strip("\"'")
    return out


def _collect(dirs: list[Path], pattern: str, kind: str) -> list[dict]:
    seen, out = set(), []
    for d in dirs:
        if not d.is_dir():
            continue
        for p in sorted(d.glob(pattern)):
            name = p.parent.name if p.name == "SKILL.md" else p.stem
            if name in seen:
                continue
            seen.add(name)
            fm = _front(p)
            out.append({"name": fm.get("name", name), "description": fm.get("description", "")[:160],
                        "scope": "project" if str(HOME) not in str(p) else "user",
                        "kind": kind, "path": str(p)})
    return out


def mcp_servers(cwd: str) -> list[dict]:
    out, seen = [], set()
    sources = [Path.home() / ".claude.json", HOME / "settings.json",
               Path(cwd) / ".mcp.json", Path(cwd) / ".claude" / "settings.json"]
    for s in sources:
        if not s.exists():
            continue
        try:
            data = json.loads(s.read_text())
        except Exception:
            continue
        blocks = [data.get("mcpServers") or {}]
        proj = (data.get("projects") or {}).get(str(Path(cwd).resolve()))
        if isinstance(proj, dict):
            blocks.append(proj.get("mcpServers") or {})
        for block in blocks:
            for name, cfg in block.items():
                if name in seen:
                    continue
                seen.add(name)
                out.append({"name": name, "transport": cfg.get("type") or ("http" if cfg.get("url") else "stdio"),
                            "target": cfg.get("url") or cfg.get("command", ""), "source": str(s)})
    return out


def _existing(paths: list[Path]) -> list[str]:
    seen, out = set(), []
    for p in paths:  # cwd may itself be ~/.claude, so the same file can be listed twice
        r = str(p.resolve())
        if p.exists() and r not in seen:
            seen.add(r)
            out.append(r)
    return out


def capabilities(cwd: str) -> dict:
    c = Path(cwd)
    return {
        "tools": BUILTIN_TOOLS,
        "models": MODELS,
        "efforts": EFFORTS,
        "permission_modes": PERMISSION_MODES,
        "skills": _collect([c / ".claude" / "skills", HOME / "skills"], "*/SKILL.md", "skill"),
        "commands": _collect([c / ".claude" / "commands", HOME / "commands"], "*.md", "command"),
        "agents": _collect([c / ".claude" / "agents", HOME / "agents"], "*.md", "agent"),
        "mcp": mcp_servers(cwd),
        "claude_md": _existing([c / "CLAUDE.md", c / ".claude" / "CLAUDE.md", HOME / "CLAUDE.md"]),
        "settings": _existing([c / ".claude" / "settings.json", c / ".claude" / "settings.local.json",
                               HOME / "settings.json", HOME / "settings.local.json"]),
    }
