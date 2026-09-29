# OpenTrace dashboard

Dependency-free HTML, CSS and JavaScript served by Nginx. There is no frontend
build step, CDN dependency, external font or demonstration data fallback.
Run the repository's Docker Compose stack and open its configured frontend URL.
Opening `index.html` directly is insufficient: `/api/` requires the Java gateway.

## Navigation and interaction

- **Overview:** selected-window totals, a transaction timeline, top origins,
  recent alerts and pipeline health. The period selector offers 15 minutes,
  one hour, six hours and 24 hours. Totals are USD for the v1 generator.
- **Transactions:** event/sender/merchant/country search, flagged-only filtering
  and 25-row pages.
- **Fraud alerts:** event/sender/rule-name/country search and status filtering.
  Inspect a signal, then mark it reviewed, dismiss it, or reopen it. These
  actions change the alert workflow status; they do not rewrite transaction risk.
- **Detection rules:** read-only descriptions, thresholds and time windows
  obtained from the API.
- **Export CSV:** exports transactions from Overview or matching rows from
  Transactions/Alerts, requesting pages of 200. UTF-8 CSV uses standard quoting
  and protects text cells against spreadsheet formula interpretation. An export
  captures the initial row count and deduplicates IDs, but is not an atomic
  database snapshot across pages; a continuing stream can change its contents.
  More than one million matching records requires a narrower time window.

Automatic polling runs every three seconds. Pause freezes automatic refresh;
manual refresh, filter changes and review actions still request current data.
Background polling stops while the tab is hidden or an investigation dialog is
open. Requests from superseded filters/views cannot replace newer results.
Keyboard focus is preserved when polling replaces a table. Escape closes an
investigation except while its status update is being saved.

Charts use the API's `bucketMinutes`: one-minute buckets up to one hour,
five-minute buckets up to six hours, and 30-minute buckets above six hours.
The visible label and tooltip show the actual bucket size. Edge buckets may be
partial. All timestamps are displayed in the browser's local timezone.
Country percentages use the full transaction total, while the list shows the
five largest origins. The API returns at most ten origins; `10+` therefore means
at least ten countries.

## Responsive and accessibility design

The default layout has a fixed dark navigation rail, four metric cards and two
chart columns. At 980px the rail becomes icon-only and cards form two columns.
At 740px charts stack; at 480px spacing and secondary controls become compact.
Wide transaction tables remain horizontally scrollable instead of hiding fields.
System fonts, inline SVG icons, keyboard focus indicators, a skip link, labeled
controls, a native modal dialog and reduced-motion preferences are supported.
Errors, empty results, disconnected services and paused updates are explicit.

## Proxy and validation

Nginx proxies `/api/` to `api:8080` without stripping the prefix, and `/engine/`
to `analytics:8000` after stripping it. FastAPI must use `/engine` as its external
root path for the linked Swagger documentation. `/healthz` checks Nginx itself.

`node --check frontend_dashboard/app.js` validates JavaScript syntax from the
repository root. The implementation has been statically reviewed against the
Java endpoint contract. Browser rendering and end-to-end UI interactions were
not verified in the current environment because its browser automation surface
was unavailable.
