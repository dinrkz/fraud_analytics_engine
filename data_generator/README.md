# C++ transaction generator

A dependency-free C++17 CLI emits one JSON object per line. Diagnostics go to stderr, so stdout can feed the Python ingestion process directly. Ordinary amounts follow a lognormal distribution, capped at $1,500. Sender profiles keep a stable home country and device. Injected scenarios include $5,000–$25,000 amounts, consecutive transactions in different countries, and eight-event sender bursts.

## Build and run

```sh
cmake -S data_generator -B data_generator/build -DCMAKE_BUILD_TYPE=Release
cmake --build data_generator/build --config Release
./data_generator/build/transaction_generator --rate 20 --count 100
```

On Windows the binary has an `.exe` suffix; multi-configuration generators may place it in `build/Release`. The included Dockerfile builds with GCC 14 and runs without root privileges.

```sh
docker build -t opentrace-generator data_generator
docker run --rm opentrace-generator --rate 0 --count 10000 > events.jsonl
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--rate` | `20` | Events per second; `0` emits as fast as the consumer accepts data. |
| `--count` | `0` | Event limit; `0` keeps running until SIGINT/SIGTERM. |
| `--seed` | Random | Seed for amounts, user selection, merchants and scenarios. |
| `--users` | `1000` | User IDs range from 1 through this number; minimum 2. |
| `--fraud-rate` | `0.08` | Probability that an event starts an anomaly scenario when no scenario is in progress. |
| `--start-time` | Wall clock | UTC timestamp in `YYYY-MM-DDTHH:MM:SSZ` format. Enables deterministic logical event time. |
| `--run-id` | Random | Stable namespace for deterministic event IDs. |
| `--output` | stdout | File destination; an existing file is overwritten. |

Without `--start-time`, events use the current UTC clock, including after a blocked consumer resumes. Time is strictly increasing at microsecond precision. With `--start-time`, logical time advances at the selected rate, or 20 events/second for an unlimited run. Real-time delivery is flushed at least every 100ms while producing events; low-rate streams flush each event. Broken pipes and failed writes terminate with a nonzero exit status.

For reproducibility on the same C++ standard library, supply **all three** of `--seed`, `--start-time`, and `--run-id`. Random distribution implementations can differ across standard libraries. Reusing `--run-id` repeats event IDs and is intended for replay/idempotency testing; choose a new run ID for a fresh dataset. UUID-shaped IDs use a random 60-bit run identity and 62-bit counter, with UUID version/variant bits, rather than cryptographic UUID generation.

`--fraud-rate` controls scenario starts, not the exact fraction of alerting transactions. Scenarios span multiple events; the fraud engine independently evaluates actual rules. High rates or very few users can trigger genuine velocity rules even when this flag is zero. Streams contain no fraud label or rule verdict. Slow rates can spread a burst beyond a rule's time window.

## Contract and verification

Events contain `event_id`, `sender_id`, `receiver_id`, `amount` (two-decimal string), `currency` (`USD`), `country`, `merchant`, `sender_ip`, `device_id`, `transaction_type` (`purchase` or `transfer`), and `created_at`. Addresses are synthetic private IPv4 addresses, not geographical IP lookups. User IDs must be provisioned by ingestion before transactions are inserted.

```sh
python data_generator/tests/self_check.py data_generator/build/transaction_generator
```

The black-box check verifies JSONL data, reproducibility, valid distinct parties and event IDs, monotonically increasing event time, observable anomaly scenarios, leap-day validation, malformed arguments, and file output. Generation is a single-process synthetic workload; actual throughput depends on serialization, disk/pipe speed, and consumer backpressure.
