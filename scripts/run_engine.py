"""Works with a normal venv or the isolated pgAdmin Python used for local QA."""
from pathlib import Path
import sys

project = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(project / "analytics_engine"))
if (project / ".local" / "python-packages").exists():
    sys.path.insert(0,str(project / ".local" / "python-packages"))

if __name__ == "__main__":
    import uvicorn
    import os
    uvicorn.run("app.main:app",host=os.getenv("ENGINE_HOST","127.0.0.1"),port=int(os.getenv("ENGINE_PORT","8000")))
