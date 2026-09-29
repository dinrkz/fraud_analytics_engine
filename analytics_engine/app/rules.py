"""Pure fraud rules, deliberately independent of HTTP and database access."""
from dataclasses import dataclass
from math import sqrt


@dataclass(frozen=True)
class Baseline:
    count: int = 0
    mean: float = 0.0
    m2: float = 0.0
    recent_count: int = 0
    previous_country: str | None = None
    previous_age_seconds: float | None = None


def evaluate(amount: float, country: str, baseline: Baseline, rules: dict) -> list[dict]:
    hits = []

    def hit(code: str, score: int, description: str):
        hits.append({"code": code, "score": score, "description": description})

    rule = rules.get("HIGH_AMOUNT")
    if rule and rule["enabled"] and amount >= float(rule["threshold"]):
        hit("HIGH_AMOUNT", 85, f"Amount ${amount:,.2f} exceeds the ${float(rule['threshold']):,.2f} threshold.")
    rule = rules.get("AMOUNT_SPIKE")
    if rule and rule["enabled"] and baseline.count >= 20:
        deviation = sqrt(max(0.0, baseline.m2) / (baseline.count - 1))
        boundary = max(100.0, baseline.mean + float(rule["threshold"]) * deviation)
        if amount > boundary:
            hit("AMOUNT_SPIKE", 75, f"Amount ${amount:,.2f}; prior average ${baseline.mean:,.2f}, deviation ${deviation:,.2f}.")
    rule = rules.get("VELOCITY")
    if rule and rule["enabled"] and baseline.recent_count + 1 >= int(rule["threshold"]):
        hit("VELOCITY", 80, f"{baseline.recent_count + 1} transactions within {rule['window_seconds']} event-time seconds.")
    rule = rules.get("COUNTRY_HOP")
    if (rule and rule["enabled"] and baseline.previous_country is not None
        and baseline.previous_country != country and baseline.previous_age_seconds is not None
        and 0 <= baseline.previous_age_seconds <= rule["window_seconds"]):
        hit("COUNTRY_HOP", 90, f"Country changed from {baseline.previous_country} to {country} in {baseline.previous_age_seconds:.1f} seconds.")
    return hits


def update_moments(count: int, mean: float, m2: float, value: float) -> tuple[int, float, float]:
    """Welford's stable online sample statistics; update AFTER scoring the event."""
    delta = value - mean
    new_mean = mean + delta / (count + 1)
    return count + 1, new_mean, max(0.0, m2 + delta * (value - new_mean))
