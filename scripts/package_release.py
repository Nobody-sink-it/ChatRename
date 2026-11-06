"""Create a minimal load-unpacked extension ZIP; exclude tests and local data."""
from pathlib import Path
import hashlib
import json
import zipfile

ROOT = Path(__file__).resolve().parents[1]
FILES = ["manifest.json", "background.js", "content.js", "core.mjs", "provider.mjs", "manager.html", "manager.css", "manager.mjs", "README.md", "启动Codex命名服务.ps1", "start-renamer.ps1", "双击启动命名服务.cmd", "local-codex/runner.mjs", "local-codex/server.mjs"]
manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
output = ROOT.parent / "releases"
output.mkdir(exist_ok=True)
target = output / f"ChatGPT聊天重命名助手-v{manifest['version']}.zip"
with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
    for name in FILES:
        archive.write(ROOT / name, "chatgpt-renamer/" + name)
with zipfile.ZipFile(target) as archive:
    assert archive.testzip() is None
digest = hashlib.sha256(target.read_bytes()).hexdigest()
(output / (target.name + ".sha256")).write_text(digest + "  " + target.name + "\n", encoding="utf-8")
print(json.dumps({"archive": str(target), "files": len(FILES), "sha256": digest}, ensure_ascii=False, indent=2))
