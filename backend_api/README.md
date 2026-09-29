# OpenTrace Java API

Java 21 HTTP gateway built with the JDK HTTP server and one external dependency:
[pgJDBC 42.7.13](https://jdbc.postgresql.org/download/). The Docker build and
PowerShell build verify the driver SHA-256 before use.

## Run

The repository Docker Compose configuration builds this directory as the API
service. To compile locally on Windows, run `./backend_api/build.ps1` from the
repository root, then:

```powershell
$env:STATIC_DIR = (Resolve-Path frontend_dashboard).Path
java -cp "backend_api/build/classes;backend_api/lib/postgresql-42.7.13.jar" opentrace.Main
```

`STATIC_DIR` is optional. With it set, the API also serves the dashboard at
`http://localhost:8080`. The `/engine/` proxy forwards requests to the configured
analytics engine; configure FastAPI with `ROOT_PATH=/engine` for Swagger links.

| Environment variable | Local default |
| --- | --- |
| `API_PORT` | `8080` |
| `API_HOST` | `127.0.0.1` (Docker uses `0.0.0.0`) |
| `DB_HOST` | `localhost` |
| `DB_PORT` | `55432` |
| `DB_NAME` | `opentrace` |
| `DB_USER` | `opentrace` |
| `DB_PASSWORD` | `opentrace_local` |
| `ENGINE_URL` | `http://localhost:8000` |
| `STATIC_DIR` | unset |

## Endpoints

| Method and path | Result |
| --- | --- |
| `GET /api/stats?minutes=60` | Window totals, timeline, country totals and rule counts |
| `GET /api/transactions` | `{items, total}`; filters: `minutes`, `risk=all\|flagged`, `search`, `limit`, `offset` |
| `GET /api/fraud-alerts` | `{items, total}`; filters: `minutes`, `status=all\|new\|reviewed\|dismissed`, `search`, `limit`, `offset` |
| `PATCH /api/fraud-alerts/{id}` | Update an alert using the JSON body `{"status":"reviewed"}` |
| `GET /api/rules` | Configured rule definitions |
| `GET /api/health` | Database availability and engine heartbeat state |
| `GET /healthz` | API process liveness |

Time filters use transaction event time in UTC. `minutes` defaults to 60 and
accepts integers 1–1440. Pagination defaults to 25 rows, allows up to 200 rows,
and bounds offset to 1,000,000. Search treats `%` and `_` as literal characters.
Invalid filters return HTTP 400. An absent alert returns 404; an unavailable
database returns 503. Successful PATCH returns `{id,status}`.

`fraudRate` is the percentage of transactions flagged in the window, while
`openAlerts` counts individual new rule alerts in the window. One transaction
can trigger several rules. Reviewing or dismissing an alert does not erase the
original transaction's risk assessment. `transactionsPerMinute` divides the
window count by the full selected window length. Chart buckets are 1 minute
for windows up to 60 minutes, 5 minutes up to 360, and 30 minutes above 360.
Buckets at window boundaries can be partial.

Read endpoints use repeatable-read snapshots for consistent totals and rows.
Each request opens a JDBC connection; the executor and query execution times
are bounded. The engine is healthy when its stored heartbeat is no older than
30 seconds and its latest heartbeat has no recorded error. `/api/health` returns 200 with `status: degraded` for dependency
failures; `/healthz` reports the API process separately.

## Boundary tests

From the repository root with JDK 21 or newer:

```powershell
javac --release 21 -d backend_api/build/classes backend_api/src/opentrace/*.java backend_api/tests/opentrace/GatewayTest.java
java -ea -cp backend_api/build/classes opentrace.GatewayTest
```

These tests cover JSON escaping, strict PATCH input, duplicate fields, malformed
JSON and query validation. Repository smoke tests exercise the PostgreSQL-backed
HTTP endpoints and ingestion pipeline.
