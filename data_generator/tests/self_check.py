"""Black-box checks of the compiled generator, with Python's standard library only."""

import argparse
import ipaddress
import json
import re
import subprocess
import tempfile
import uuid
from collections import deque
from datetime import datetime, timedelta
from decimal import Decimal
from pathlib import Path


def run(binary, *options, success=True):
    result = subprocess.run([str(binary), *options], capture_output=True, text=True, timeout=30)
    assert (result.returncode == 0) == success, result.stderr
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    binary = parser.parse_args().binary.resolve()
    options = ["--rate", "0", "--count", "1500", "--seed", "42", "--run-id", "self-check",
               "--start-time", "2026-01-01T00:00:00Z", "--fraud-rate", "0.3"]
    first = run(binary, *options)
    assert first.stdout == run(binary, *options).stdout, "Identical seed/time/run must reproduce a stream"
    events = [json.loads(line) for line in first.stdout.splitlines()]
    assert len(events) == 1500
    assert len({e["event_id"] for e in events}) == len(events)
    required = {"event_id", "sender_id", "receiver_id", "amount", "currency", "country", "merchant",
                "sender_ip", "device_id", "transaction_type", "created_at"}
    previous = None
    countries = {}
    windows = {}
    high_amount = country_hop = velocity = False
    for event in events:
        assert set(event) == required
        assert uuid.UUID(event["event_id"]).version == 4
        assert 1 <= event["sender_id"] <= 1000 and 1 <= event["receiver_id"] <= 1000
        assert event["sender_id"] != event["receiver_id"]
        assert re.fullmatch(r"\d+\.\d{2}", event["amount"])
        assert Decimal(event["amount"]) > 0
        assert event["currency"] == "USD"
        assert event["country"] in {"US", "GB", "DE", "FR", "JP", "SG", "KZ"}
        assert event["transaction_type"] in {"purchase", "transfer"}
        ipaddress.IPv4Address(event["sender_ip"])
        instant = datetime.fromisoformat(event["created_at"].replace("Z", "+00:00"))
        assert previous is None or instant > previous
        previous = instant
        high_amount |= Decimal(event["amount"]) >= 5000
        sender = event["sender_id"]
        old = countries.get(sender)
        country_hop |= old is not None and old[0] != event["country"] and instant - old[1] <= timedelta(minutes=5)
        countries[sender] = (event["country"], instant)
        window = windows.setdefault(sender, deque())
        while window and instant - window[0] > timedelta(seconds=60):
            window.popleft()
        window.append(instant)
        velocity |= len(window) >= 6
    assert high_amount and country_hop and velocity, "All three anomaly scenarios must be observable"
    # A normal stream with two users exercises the receiver boundary and spends below the absolute limit.
    normal = run(binary, "--rate", "0", "--count", "100", "--users", "2", "--fraud-rate", "0")
    for event in map(json.loads, normal.stdout.splitlines()):
        assert {event["sender_id"], event["receiver_id"]} == {1, 2}
        assert Decimal(event["amount"]) <= 1500
    for invalid in (["--users", "1"], ["--rate", "-1"], ["--rate", "nan"], ["--count", "1junk"],
                    ["--fraud-rate", "1.1"], ["--start-time", "2025-02-29T00:00:00Z"],
                    ["--start-time", "2026-13-01T00:00:00Z"], ["--bogus", "1"]):
        assert not run(binary, *invalid, success=False).stdout, "Errors must never contaminate JSONL stdout"
    leap = run(binary, "--count", "1", "--start-time", "2024-02-29T23:59:59Z")
    assert json.loads(leap.stdout)["created_at"] == "2024-02-29T23:59:59.000000Z"
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "events.jsonl"
        result = run(binary, "--rate", "0", "--count", "3", "--output", str(path))
        assert not result.stdout
        assert len(path.read_text().splitlines()) == 3
    print("PASS: deterministic JSONL, IDs, amounts, event time, all anomaly scenarios, argument validation, file output")


if __name__ == "__main__":
    main()
