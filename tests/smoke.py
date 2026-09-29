"""Exercise the real HTTP ingestion -> PostgreSQL -> Java pipeline.

Run with the services started: python tests/smoke.py --base-url http://localhost:8080
Only Python's standard library is required. Every run uses fresh event UUIDs and
high test-user IDs. The 30 labelled fixture transactions remain in the database.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import json
import secrets
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from uuid import uuid4


def ensure(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


class Client:
    def __init__(self, base_url: str):
        self.base_url = base_url.rstrip("/")

    def request(self, path: str, *, method: str = "GET", body=None, expected: int = 200):
        data = None if body is None else json.dumps(body).encode("utf-8")
        headers = {"Accept": "application/json"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        request = Request(self.base_url + path, data=data, headers=headers, method=method)
        try:
            response = urlopen(request, timeout=25)
        except HTTPError as error:
            response = error
        with response:
            status = response.status
            raw = response.read().decode("utf-8")
            content_type = response.headers.get("Content-Type", "")
        ensure(status == expected, f"{method} {path}: expected HTTP {expected}, got {status}: {raw[:500]}")
        return json.loads(raw) if "application/json" in content_type else raw

    def get(self, path: str, **parameters):
        return self.request(path + ("?" + urlencode(parameters) if parameters else ""))


def run(base_url: str) -> None:
    client = Client(base_url)
    liveness = client.get("/healthz")
    ready = liveness.get("status") == "ok" if isinstance(liveness, dict) else liveness.strip() == "ok"
    ensure(ready, "Gateway or dashboard proxy is not ready")
    health = client.get("/api/health")
    ensure(health["database"] == "up" and health["engine"] == "up", f"Dependency health is degraded: {health}")
    ensure(client.get("/engine/healthz")["database"] == "up", "Analytics database is not ready")
    document = client.get("/engine/openapi.json")
    ensure("/ingest" in document["paths"], "Engine OpenAPI ingestion endpoint is missing")
    ensure("/engine/openapi.json" in client.get("/engine/docs"), "Swagger proxy root_path is incorrect")
    print("PASS service health and proxied Swagger/OpenAPI")

    # Generator users occupy the low IDs. Check candidate senders against the
    # API's maximum window to avoid reusing IDs from a previous recent smoke run.
    participants: list[int] = []
    while len(participants) < 4:
        candidate = 100_000 + secrets.randbelow(900_000)
        if candidate in participants:
            continue
        existing = client.get("/api/transactions", minutes=1440, search=str(candidate), limit=1)
        if existing["total"] == 0:
            participants.append(candidate)
    sender, receiver, velocity_sender, late_sender = participants
    run_id = str(uuid4())
    now = datetime.now(timezone.utc)

    def event(amount: int, seconds_ago: int, *, user: int = sender, country: str = "US") -> dict:
        return {
            "event_id": str(uuid4()),
            "sender_id": user,
            "receiver_id": receiver,
            "amount": f"{amount:.2f}",
            "currency": "USD",
            "country": country,
            "merchant": f"Smoke test {run_id}",
            "sender_ip": "192.0.2.10",
            "device_id": f"smoke-{run_id}",
            "transaction_type": "purchase",
            "created_at": (now - timedelta(seconds=seconds_ago)).isoformat(),
        }

    # Fourteen-second spacing keeps warmup below six transactions per minute.
    warmup = [event(40 + index, 291 - index * 14) for index in range(20)]
    spike = event(6000, 15)
    country_hop = event(54, 5, country="DE")
    velocity = [event(25, 40 - index * 5, user=velocity_sender) for index in range(6)]
    events = warmup + [spike, country_hop] + velocity
    first = client.request("/engine/ingest", method="POST", body=events)
    ensure(first["accepted"] == len(events) and first["duplicates"] == 0, f"Initial ingestion failed: {first}")
    replay = client.request("/engine/ingest", method="POST", body=events)
    ensure(replay == {"accepted": 0, "duplicates": len(events), "alerts": 0}, f"Replay was not idempotent: {replay}")
    print(f"PASS {len(events)} events ingested; identical replay creates no transactions or alerts")

    spike_rows = client.get("/api/transactions", minutes=15, search=spike["event_id"])
    ensure(spike_rows["total"] == 1, "Spike must appear exactly once")
    spike_row = spike_rows["items"][0]
    ensure(spike_row["status"] == "flagged" and spike_row["amount"] == 6000, "Spike risk/amount is incorrect")
    ensure(spike_row["senderId"] == sender, "Transaction sender did not survive the pipeline")
    spike_alerts = client.get("/api/fraud-alerts", minutes=15, search=spike["event_id"])["items"]
    spike_codes = {item["ruleCode"] for item in spike_alerts}
    ensure({"HIGH_AMOUNT", "AMOUNT_SPIKE"}.issubset(spike_codes), f"Missing spike rules: {spike_codes}")
    hop_alerts = client.get("/api/fraud-alerts", minutes=15, search=country_hop["event_id"])["items"]
    ensure("COUNTRY_HOP" in {item["ruleCode"] for item in hop_alerts}, "Country change was not flagged")
    velocity_alerts = client.get("/api/fraud-alerts", minutes=15, search=velocity[-1]["event_id"])["items"]
    ensure("VELOCITY" in {item["ruleCode"] for item in velocity_alerts}, "Six-event burst was not flagged")
    print("PASS HIGH_AMOUNT, AMOUNT_SPIKE, COUNTRY_HOP and VELOCITY rules through Java reads")

    # The event arriving second is older in event time. The already stored US
    # transaction must not become its "previous" country or amount baseline.
    latest = event(6000, 30, user=late_sender, country="US")
    late = event(30, 180, user=late_sender, country="GB")
    ensure(client.request("/engine/ingest", method="POST", body=[latest])["accepted"] == 1,
           "Latest event for out-of-order fixture was not stored")
    ensure(client.request("/engine/ingest", method="POST", body=[late])["accepted"] == 1,
           "Late event was not accepted")
    late_rows = client.get("/api/transactions", minutes=15, search=late["event_id"])
    ensure(late_rows["total"] == 1 and late_rows["items"][0]["status"] == "clear",
           "Late event was missing or scored against future history")
    late_alerts = client.get("/api/fraud-alerts", minutes=15, search=late["event_id"])
    ensure(late_alerts["total"] == 0 and late_alerts["items"] == [],
           "Late event incorrectly used the future transaction as its previous country")
    print("PASS late event is stored and excludes future-to-it history from fraud scoring")

    stats = client.get("/api/stats", minutes=15)
    ensure(stats["totalTransactions"] >= len(events), "Stats omitted smoke transactions")
    ensure(stats["totalVolume"] >= 7194, "Stats volume omitted fixture amounts")
    ensure(stats["flaggedTransactions"] >= 3, "Stats omitted flagged transactions")
    ensure(sum(bucket["transactions"] for bucket in stats["series"]) == stats["totalTransactions"],
           "Timeline and transaction total disagree")
    ensure(sum(bucket["alerts"] for bucket in stats["series"]) == sum(rule["alerts"] for rule in stats["rules"]),
           "Timeline and per-rule alert totals disagree")
    print("PASS statistical totals and chart/rule aggregates are consistent")

    alert = next(item for item in spike_alerts if item["ruleCode"] == "HIGH_AMOUNT")
    updated = client.request(f"/api/fraud-alerts/{alert['id']}", method="PATCH", body={"status": "reviewed"})
    ensure(updated["status"] == "reviewed", "PATCH did not return the updated status")
    reviewed = client.get("/api/fraud-alerts", minutes=15, status="reviewed", search=spike["event_id"])["items"]
    ensure(any(item["id"] == alert["id"] for item in reviewed), "Reviewed status was not persisted")
    client.request(f"/api/fraud-alerts/{alert['id']}", method="PATCH", body={"status": "approved"}, expected=400)
    print("PASS alert review persists and invalid status is rejected")

    invalid = event(-10, 2)
    client.request("/engine/ingest", method="POST", body=[invalid], expected=422)
    ensure(client.get("/api/transactions", minutes=15, search=invalid["event_id"])["total"] == 0,
           "Invalid transaction was stored")
    client.request("/api/stats?minutes=0", expected=400)
    client.request("/api/transactions?limit=201", expected=400)
    health = client.get("/api/health")
    ensure(health["database"] == "up" and health["engine"] == "up", f"Dependency health is degraded: {health}")
    print("PASS negative amount and invalid filters rejected; healthy engine heartbeat")
    print(f"Smoke test passed. Fixture run {run_id}; 30 events; sender IDs {sender}, {velocity_sender}, {late_sender}.")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://localhost:8080", help="Java gateway or dashboard proxy URL")
    arguments = parser.parse_args()
    try:
        run(arguments.base_url)
        return 0
    except (AssertionError, URLError, TimeoutError, KeyError, ValueError) as error:
        print(f"FAIL {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
