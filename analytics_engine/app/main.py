from contextlib import asynccontextmanager
import logging
import os
from typing import Annotated

from fastapi import Body, FastAPI, HTTPException
from fastapi.responses import JSONResponse

from .models import TransactionEvent
from .storage import health, ingest
from .worker import Worker

logging.basicConfig(level=logging.INFO,format="%(asctime)s %(levelname)s %(name)s: %(message)s")
worker = Worker()


@asynccontextmanager
async def lifespan(app: FastAPI):
    worker.start()
    yield
    worker.stop()


app = FastAPI(title="OpenTrace Analytics Engine",version="1.0.0",lifespan=lifespan,
              description="Validated, idempotent transaction ingestion and event-time fraud rules.",
              root_path=os.getenv("ROOT_PATH",""))


@app.get("/healthz",tags=["Operations"])
def healthz():
    try:
        state = health()
        ready = state is not None and worker.last_error is None and (not worker.auto_generate or worker.running)
        return JSONResponse(status_code=200 if ready else 503,content={
            "status":"ok" if ready else "degraded", "database":"up", "generatorRunning":worker.running,
            "processedEvents":state["processed_events"] if state else 0,
            "queueDepth":worker.queue.qsize(), "lastError":worker.last_error})
    except Exception:
        return JSONResponse(status_code=503,content={"status":"degraded","database":"down"})


@app.post("/ingest",tags=["Transactions"])
def ingest_transactions(events: Annotated[list[TransactionEvent],Body(min_length=1,max_length=500)]):
    try:
        return ingest(events)
    except Exception:
        logging.getLogger("opentrace.api").exception("Ingestion failed")
        raise HTTPException(status_code=503,detail="Storage unavailable; safely retry the same event IDs") from None
