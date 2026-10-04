import os
from pathlib import Path

HIDE = {".git", "node_modules", ".next", "__pycache__", ".venv", "venv", "dist",
        "build", ".DS_Store", ".mypy_cache", ".pytest_cache", "target", ".idea"}
CODE = {".py", ".ts", ".tsx", ".js", ".jsx", ".go", ".rs", ".java", ".c", ".h", ".cc",
        ".cpp", ".rb", ".sh", ".md", ".json", ".toml", ".yaml", ".yml", ".css", ".html"}


def expand(p: str) -> Path:
    return Path(os.path.expanduser(p or "~")).resolve()


def listing(p: str) -> dict:
    d = expand(p)
    if not d.is_dir():
        raise NotADirectoryError(f"{d} is not a directory")
    entries = []
    for e in sorted(d.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower())):
        is_dir = e.is_dir()
        # dotted directories stay navigable (~/.config and friends); dotfiles are just noise
        if e.name in HIDE or (e.name.startswith(".") and not is_dir):
            continue
        entries.append({"name": e.name, "path": str(e), "dir": is_dir,
                        "repo": (e / ".git").exists() if is_dir else False})
    return {"path": str(d), "parent": str(d.parent) if d.parent != d else None, "entries": entries}


def tree(p: str, depth: int = 3, cap: int = 1200) -> dict:
    root = expand(p)
    count = 0

    def walk(d: Path, lvl: int) -> list[dict]:
        nonlocal count
        if lvl > depth or count > cap:
            return []
        out = []
        try:
            kids = sorted(d.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower()))
        except OSError:
            return []
        for e in kids:
            if e.name in HIDE or e.name.startswith("."):
                continue
            count += 1
            if count > cap:
                break
            if e.is_dir():
                out.append({"name": e.name, "path": str(e), "dir": True, "children": walk(e, lvl + 1)})
            else:
                out.append({"name": e.name, "path": str(e), "dir": False,
                            "size": e.stat().st_size if e.exists() else 0,
                            "code": e.suffix in CODE})
        return out

    return {"name": root.name, "path": str(root), "dir": True, "children": walk(root, 1)}


def read_file(p: str, limit: int = 200_000) -> dict:
    f = expand(p)
    data = f.read_text(errors="replace")[:limit]
    return {"path": str(f), "text": data, "lines": data.count("\n") + 1}


def write_file(p: str, text: str) -> None:
    f = expand(p)
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(text)
