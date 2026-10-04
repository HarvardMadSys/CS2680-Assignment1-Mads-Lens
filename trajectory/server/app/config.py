import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = Path(os.environ.get("TRAJECTORY_DATA", ROOT / "data"))
DB_PATH = DATA_DIR / "trajectory.db"
FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"

CLAUDE_BIN = os.environ.get("CLAUDE_BIN", "claude")
# Tool output kept inline in the stream; the full text always lands in SQLite.
INLINE_RESULT_CHARS = int(os.environ.get("INLINE_RESULT_CHARS", 4000))
# Any OpenAI-compatible /v1/chat/completions endpoint. The default is where `trajectory model`
# parks llama-server; nothing listening there just means summaries fall back to the heuristic.
SUMMARIZER_URL = os.environ.get("SUMMARIZER_URL", "http://127.0.0.1:8088/v1/chat/completions")
SUMMARIZER_MODEL = os.environ.get("SUMMARIZER_MODEL", "LiquidAI/LFM2.5-2.6B-GGUF")
SUMMARIZER_KEY = os.environ.get("SUMMARIZER_KEY", "")     # only a hosted endpoint needs one
SUMMARIZER_TIMEOUT = float(os.environ.get("SUMMARIZER_TIMEOUT", 8))

DATA_DIR.mkdir(parents=True, exist_ok=True)
