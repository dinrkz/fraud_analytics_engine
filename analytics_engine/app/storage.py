"""Transactional ingestion: deduplication, scoring, alerts and moments commit together."""
import os
import threading
from datetime import timedelta

import psycopg
from psycopg.rows import dict_row

from .models import TransactionEvent
from .rules import Baseline, evaluate, update_moments

INGEST_LOCK = threading.Lock()


def connect():
    return psycopg.connect(
        host=os.getenv("DB_HOST", "127.0.0.1"), port=int(os.getenv("DB_PORT", "55432")),
        dbname=os.getenv("DB_NAME", "opentrace"), user=os.getenv("DB_USER", "opentrace"),
        password=os.getenv("DB_PASSWORD", "opentrace_local"), connect_timeout=5,
        row_factory=dict_row, options="-c timezone=UTC -c statement_timeout=15000",
    )


def heartbeat(running: bool, error: str | None = None, rejected: int = 0):
    with connect() as conn:
        conn.execute("""UPDATE engine_state SET last_heartbeat_at=now(),generator_running=%s,
                     last_error=%s,rejected_events=rejected_events+%s WHERE id=1""",
                     (running, error, rejected))


def health():
    with connect() as conn:
        return conn.execute("SELECT * FROM engine_state WHERE id=1").fetchone()


def ingest(events: list[TransactionEvent]) -> dict:
    accepted = alerts = duplicates = 0
    # A single writer preserves deterministic order. DB transaction-level advisory lock
    # also serializes independently launched engine instances for this small demo.
    with INGEST_LOCK, connect() as conn:
        conn.execute("SELECT pg_advisory_xact_lock(71420931)")
        rules = {r["code"]: r for r in conn.execute("SELECT * FROM rules")}
        user_ids = sorted({uid for event in events for uid in (event.sender_id, event.receiver_id)})
        with conn.cursor() as cursor:
            cursor.executemany("""INSERT INTO users(id,username,email,reg_country)
                VALUES (%s,%s,%s,'US') ON CONFLICT (id) DO NOTHING""",
                [(uid, f"user_{uid:06}", f"user{uid}@example.test") for uid in user_ids])
        for event in events:
            inserted = conn.execute("""INSERT INTO transactions
                (event_id,sender_id,receiver_id,amount,currency,country,merchant,sender_ip,device_id,transaction_type,created_at)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT (event_id) DO NOTHING RETURNING id""",
                (event.event_id,event.sender_id,event.receiver_id,event.amount,event.currency,event.country,
                 event.merchant,str(event.sender_ip),event.device_id,event.transaction_type,event.created_at)).fetchone()
            if inserted is None:
                duplicates += 1
                continue
            transaction_id = inserted["id"]
            conn.execute("INSERT INTO user_metrics(user_id) VALUES (%s) ON CONFLICT DO NOTHING", (event.sender_id,))
            metrics = conn.execute("SELECT * FROM user_metrics WHERE user_id=%s FOR UPDATE", (event.sender_id,)).fetchone()
            window = int(rules.get("VELOCITY", {}).get("window_seconds", 60))
            recent_count = conn.execute("""SELECT count(*) AS n FROM transactions
                WHERE sender_id=%s AND created_at >= %s AND created_at <= %s AND id<>%s""",
                (event.sender_id,event.created_at-timedelta(seconds=window),event.created_at,transaction_id)).fetchone()["n"]
            previous = conn.execute("""SELECT country,created_at FROM transactions WHERE sender_id=%s
                AND created_at <= %s AND id<>%s ORDER BY created_at DESC,id DESC LIMIT 1""",
                (event.sender_id,event.created_at,transaction_id)).fetchone()
            count, mean, m2 = metrics["event_count"], metrics["mean_amount"], metrics["m2_amount"]
            # For late events use only history at or before their event time.
            if metrics["last_event_at"] and event.created_at < metrics["last_event_at"]:
                prior = conn.execute("""SELECT count(*) AS n,coalesce(avg(amount),0) AS mean,
                    coalesce(var_samp(amount),0) AS variance FROM transactions
                    WHERE sender_id=%s AND created_at<=%s AND id<>%s""",
                    (event.sender_id,event.created_at,transaction_id)).fetchone()
                count, mean, m2 = prior["n"], float(prior["mean"]), float(prior["variance"]) * max(0,prior["n"]-1)
            baseline = Baseline(count,mean,m2,recent_count,
                previous["country"] if previous else None,
                (event.created_at-previous["created_at"]).total_seconds() if previous else None)
            hits = evaluate(float(event.amount),event.country,baseline,rules)
            score = max((hit["score"] for hit in hits), default=0)
            conn.execute("UPDATE transactions SET risk_score=%s,is_flagged=%s WHERE id=%s",
                         (score,bool(hits),transaction_id))
            for hit in hits:
                conn.execute("""INSERT INTO fraud_alerts(transaction_id,rule_code,risk_score,description)
                    VALUES (%s,%s,%s,%s)""", (transaction_id,hit["code"],hit["score"],hit["description"]))
            new_count,new_mean,new_m2 = update_moments(metrics["event_count"],metrics["mean_amount"],metrics["m2_amount"],float(event.amount))
            conn.execute("""UPDATE user_metrics SET event_count=%s,total_amount=total_amount+%s,
                mean_amount=%s,m2_amount=%s,
                last_country=CASE WHEN last_event_at IS NULL OR last_event_at<=%s THEN %s ELSE last_country END,
                last_event_at=greatest(last_event_at,%s),updated_at=now() WHERE user_id=%s""",
                (new_count,event.amount,new_mean,new_m2,event.created_at,event.country,event.created_at,event.sender_id))
            accepted += 1
            alerts += len(hits)
        conn.execute("""UPDATE engine_state SET processed_events=processed_events+%s,
                     last_heartbeat_at=now(),last_error=NULL WHERE id=1""", (accepted,))
    return {"accepted":accepted,"duplicates":duplicates,"alerts":alerts}
