"""Bounded streaming queue with backpressure and retry of uncommitted batches."""
import logging
import os
from pathlib import Path
from queue import Empty, Full, Queue
import subprocess
import threading
import time

from .models import TransactionEvent
from .storage import heartbeat, ingest

log = logging.getLogger("opentrace.worker")


class Worker:
    def __init__(self):
        self.stop_event = threading.Event()
        self.reader_done = threading.Event()
        self.queue = Queue(maxsize=2000)
        self.process = None
        self.threads = []
        self.last_error = None
        self.rejected = 0
        self.auto_generate = os.getenv("AUTO_GENERATE", "true").lower() == "true"

    def start(self):
        self.threads = [threading.Thread(target=self.consume, daemon=True, name="ingestion")]
        if self.auto_generate:
            self.threads.append(threading.Thread(target=self.generate, daemon=True, name="generator-reader"))
        else:
            self.reader_done.set()
        for thread in self.threads:
            thread.start()

    @property
    def running(self):
        return self.process is not None and self.process.poll() is None

    def generate(self):
        default_binary = Path(__file__).resolve().parents[2] / "data_generator" / "build" / "transaction_generator.exe"
        command = [os.getenv("GENERATOR_PATH",str(default_binary)),"--rate",os.getenv("GENERATOR_RATE","20"),
                   "--users",os.getenv("GENERATOR_USERS","1000"),"--fraud-rate",os.getenv("FRAUD_RATE","0.08")]
        while not self.stop_event.is_set():
            try:
                self.process = subprocess.Popen(command,stdout=subprocess.PIPE,text=True,encoding="utf-8",bufsize=1)
                for line in self.process.stdout:
                    if self.stop_event.is_set():
                        break
                    try:
                        event = TransactionEvent.model_validate_json(line)
                    except ValueError:
                        self.rejected += 1
                        log.warning("Rejected malformed generator event")
                        continue
                    while not self.stop_event.is_set():
                        try:
                            self.queue.put(event,timeout=0.5)
                            break
                        except Full:
                            pass
                if not self.stop_event.is_set():
                    self.last_error = "Generator exited; restarting"
                    log.warning(self.last_error)
            except (OSError,ValueError):
                self.last_error = "Generator could not start; check GENERATOR_PATH and arguments"
                log.exception("Generator launch failed")
            finally:
                if self.process:
                    if self.process.poll() is None:
                        self.process.terminate()
                    try:
                        self.process.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        self.process.kill()
                        self.process.wait(timeout=3)
                    if self.process.stdout:
                        self.process.stdout.close()
            self.stop_event.wait(2)
        self.reader_done.set()

    def consume(self):
        pending = []
        last_heartbeat = 0.0
        retry_delay = 1.0
        while not self.stop_event.is_set() or not self.reader_done.is_set() or not self.queue.empty() or pending:
            try:
                if not pending:
                    try:
                        pending.append(self.queue.get(timeout=0.25))
                    except Empty:
                        pass
                    deadline = time.monotonic() + 0.2
                    while pending and len(pending) < 100 and time.monotonic() < deadline:
                        try:
                            pending.append(self.queue.get(timeout=max(0.001,deadline-time.monotonic())))
                        except Empty:
                            break
                if pending:
                    ingest(pending)
                    pending.clear()
                    self.last_error = None
                if time.monotonic()-last_heartbeat > 2:
                    rejected = self.rejected
                    heartbeat(self.running,self.last_error,rejected)
                    self.rejected -= rejected
                    last_heartbeat = time.monotonic()
                retry_delay = 1.0
            except Exception as exc:
                # Retain pending events: a failed SQL transaction is retried idempotently.
                self.last_error = f"Ingestion retry: {type(exc).__name__}"
                log.warning(self.last_error)
                if self.stop_event.is_set():
                    log.error("Storage unavailable during shutdown; uncommitted synthetic events will be lost")
                    break
                self.stop_event.wait(retry_delay)
                retry_delay = min(10.0,retry_delay*2)
    def stop(self):
        self.stop_event.set()
        if self.running:
            self.process.terminate()
        for thread in reversed(self.threads):
            thread.join(timeout=8)
        try:
            heartbeat(False,"Engine stopped")
        except Exception:
            pass
