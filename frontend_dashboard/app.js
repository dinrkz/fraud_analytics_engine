"use strict";

const ICONS = {
  overview: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  transactions: '<path d="M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="M12 8v5m0 3h.01"/>',
  sliders: '<path d="M4 6h8m4 0h4M4 12h3m4 0h9M4 18h11m4 0h1"/><circle cx="14" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  activity: '<path d="M2 12h5l3-8 4 16 3-8h5"/>',
  book: '<path d="M12 5c-3-2-7-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-2-1-6-1-9 1Zm0 0v15"/>',
  "arrow-up-right": '<path d="M6 18 18 6M6 6h12v12"/>',
  "arrow-right": '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 11h18m-13 4h2m4 0h2"/>',
  pause: '<path d="M9 5v14M15 5v14"/>',
  play: '<path d="m8 4 12 8-12 8V4Z"/>',
  refresh: '<path d="M20 10a8 8 0 0 0-14-5L3 8m0-5v5h5M4 14a8 8 0 0 0 14 5l3-3m0 5v-5h-5"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  wallet: '<path d="M20 8V5H5a2 2 0 0 0 0 4h16v12H5a2 2 0 0 1-2-2V7"/><path d="M21 12h-6v5h6m-3-2.5h.01"/>',
  users: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3m0-16a3 3 0 0 1 0 6m3 3a5 5 0 0 1 3 4v3"/>',
  globe: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18M5 7h14M5 17h14"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  left: '<path d="m15 5-7 7 7 7"/>',
  right: '<path d="m9 5 7 7-7 7"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  inbox: '<path d="M4 4h16l2 12v5H2v-5L4 4Zm-2 12h6l2 3h4l2-3h6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>'
};

const $ = (selector) => document.querySelector(selector);
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ICONS.info}</svg>`;
document.querySelectorAll("[data-icon]").forEach((element) => { element.innerHTML = icon(element.dataset.icon); });
$("#export-button").setAttribute("aria-label", "Export CSV");
$("#pause-button").setAttribute("aria-pressed", "false");
$(".monitor-line").setAttribute("aria-hidden", "true");
$("#transaction-search").maxLength = 100;
$("#alert-search").maxLength = 100;

const state = {
  view: "overview", minutes: 60, paused: false, loading: false, generation: 0,
  stats: null, health: null, recentAlerts: null, transactions: null, alerts: null, rules: null,
  transactionSearch: "", alertSearch: "", risk: "all", alertStatus: "all",
  transactionOffset: 0, alertOffset: 0, pageSize: 25,
  lastSuccess: null, lastHealthSuccess: null, errors: [], selectedAlert: null, saving: false,
  healthError: false, statsError: false, exporting: false, searchPending: false
};

const viewLabels = {
  overview: { breadcrumb: "Overview", title: "Transaction overview", description: "A live pulse on your payment network. Every signal, in one place." },
  transactions: { breadcrumb: "Transactions", title: "Follow every transaction", description: "Explore your payment stream, from origin to outcome." },
  alerts: { breadcrumb: "Fraud alerts", title: "Find the signal", description: "Investigate suspicious activity and bring every alert to a resolution." },
  rules: { breadcrumb: "Detection rules", title: "Know what’s watching", description: "The checks behind every signal. Simple, transparent, explainable." }
};

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const numeric = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const integer = (value) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(numeric(value));
const decimal = (value, digits = 1) => new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(numeric(value));
const money = (value, currency = "USD") => {
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(numeric(value)); }
  catch { return `${decimal(value, 2)} ${currency}`; }
};
const shortMoney = (value) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: numeric(value) >= 1000000 ? "compact" : "standard", maximumFractionDigits: numeric(value) >= 1000000 ? 2 : 0 }).format(numeric(value));
const validDate = (value) => { if (!value) return null; const date = new Date(value); return Number.isNaN(date.getTime()) ? null : date; };
const time = (value) => { const date = validDate(value); return date ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : "—"; };
const fullDate = (value) => { const date = validDate(value); return date ? date.toLocaleString([], { dateStyle: "medium", timeStyle: "medium" }) : "—"; };
const shortId = (value) => { const string = String(value ?? "—"); return string.length > 17 ? `${string.slice(0, 8)}…${string.slice(-5)}` : string; };
const countryNames = typeof Intl.DisplayNames === "function" ? new Intl.DisplayNames(["en"], { type: "region" }) : null;
const countryName = (code) => { try { return countryNames?.of(String(code).toUpperCase()) || String(code || "Unknown"); } catch { return String(code || "Unknown"); } };
const empty = (title, description = "", symbol = "inbox") => `<div class="empty-state">${icon(symbol)}<strong>${escapeHtml(title)}</strong>${description ? `<p>${escapeHtml(description)}</p>` : ""}</div>`;

async function api(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`/api${path}`, { cache: "no-store", ...options, signal: controller.signal, headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers } });
    if (!response.ok) throw new Error(`Request failed (${response.status})`);
    return await response.json();
  } catch (error) {
    if (error.name === "AbortError") throw new Error("The API took too long to respond");
    throw error;
  } finally { clearTimeout(timeout); }
}

function listPath(kind, limit = state.pageSize, offset = null) {
  const isTransactions = kind === "transactions";
  const parameters = new URLSearchParams({ limit, offset: offset ?? (isTransactions ? state.transactionOffset : state.alertOffset), minutes: state.minutes, search: isTransactions ? state.transactionSearch : state.alertSearch });
  parameters.set(isTransactions ? "risk" : "status", isTransactions ? state.risk : state.alertStatus);
  return `/${isTransactions ? "transactions" : "fraud-alerts"}?${parameters}`;
}

async function refresh({ force = false } = {}) {
  if ((state.loading || state.searchPending || $("#alert-dialog").open) && !force) return;
  const generation = ++state.generation;
  state.loading = true;
  $("#refresh-button").classList.add("loading-icon");
  $("#refresh-button").setAttribute("aria-busy", "true");
  const requests = [
    { key: "stats", label: "statistics", path: `/stats?minutes=${state.minutes}` },
    { key: "health", label: "pipeline health", path: "/health" }
  ];
  if (state.view === "overview") requests.push({ key: "recentAlerts", label: "latest alerts", path: `/fraud-alerts?limit=4&offset=0&status=all&minutes=${state.minutes}` });
  if (state.view === "transactions") requests.push({ key: "transactions", label: "transactions", path: listPath("transactions") });
  if (state.view === "alerts") requests.push({ key: "alerts", label: "fraud alerts", path: listPath("alerts") });
  if (state.view === "rules") requests.push({ key: "rules", label: "detection rules", path: "/rules" });
  const results = await Promise.allSettled(requests.map((request) => api(request.path)));
  if (generation !== state.generation) return;
  state.errors = [];
  let successful = false;
  results.forEach((result, index) => {
    const request = requests[index];
    if (result.status === "fulfilled") {
      state[request.key] = result.value;
      if (request.key === "health") { state.lastHealthSuccess = new Date(); state.healthError = false; }
      if (request.key === "stats") state.statsError = false;
      successful = true;
    } else {
      state.errors.push(request.label);
      if (request.key === "health") state.healthError = true;
      if (request.key === "stats") state.statsError = true;
    }
  });
  if (successful && !state.errors.length) state.lastSuccess = new Date();
  state.loading = false;
  $("#refresh-button").classList.remove("loading-icon");
  $("#refresh-button").removeAttribute("aria-busy");
  for (const [key, offsetKey] of [["transactions", "transactionOffset"], ["alerts", "alertOffset"]]) {
    if (state.view === key && state[key] && state[offsetKey] > 0 && state[offsetKey] >= numeric(state[key].total)) {
      state[offsetKey] = Math.max(0, Math.ceil(numeric(state[key].total) / state.pageSize) - 1) * state.pageSize;
      state[key] = null;
      refresh({ force: true });
      return;
    }
  }
  render();
}

function render() {
  const focused = document.activeElement;
  const focusedAlert = focused?.dataset.alertId;
  const focusedPage = focused?.dataset.page;
  const focusedKind = focused?.dataset.kind;
  renderStatus();
  renderStats();
  renderPipeline();
  const failed = state.errors.length > 0;
  $("#error-banner").hidden = !failed;
  $("#error-message").textContent = failed ? `Unable to refresh ${state.errors.join(", ")}. ${state.lastSuccess ? "Previously loaded data may be out of date." : "Check that the local services are running."}` : "";
  if (state.view === "overview") {
    renderChart();
    renderCountries();
    $("#recent-alert-count").textContent = state.recentAlerts ? integer(state.recentAlerts.total) : "—";
    $("#recent-alerts-table").innerHTML = state.recentAlerts ? alertsTable(state.recentAlerts.items || [], true) : empty("No alert data available", "The analytics service will publish alerts here when connected.");
  }
  if (state.view === "transactions") {
    $("#transactions-table").innerHTML = state.transactions ? transactionsTable(state.transactions.items || []) : empty("No transaction data available", "Check the API connection and try again.");
    renderPagination("transactions", state.transactions?.total);
  }
  if (state.view === "alerts") {
    $("#alerts-table").innerHTML = state.alerts ? alertsTable(state.alerts.items || [], false) : empty("No alert data available", "Check the API connection and try again.");
    renderPagination("alerts", state.alerts?.total);
  }
  if (state.view === "rules") renderRules();
  $("#export-button").hidden = state.view === "rules";
  if (focusedAlert) [...document.querySelectorAll(".view:not([hidden]) [data-alert-id]")].find((element) => element.dataset.alertId === focusedAlert)?.focus({ preventScroll: true });
  if (focusedPage) [...document.querySelectorAll("[data-page]")].find((element) => element.dataset.page === focusedPage && element.dataset.kind === focusedKind)?.focus({ preventScroll: true });
}

function renderStatus() {
  let label = "Connecting", className = "";
  if (state.paused) { label = "Updates paused"; className = "paused"; }
  else if (state.healthError && state.statsError) { label = state.lastSuccess ? "Reconnecting" : "Offline"; className = "offline"; }
  else if (state.errors.length) { label = "Reconnecting"; className = "degraded"; }
  else if (state.health) {
    if (state.health.status === "ok" && state.health.generatorRunning && state.health.engine === "up" && state.health.database === "up") { label = "Live monitoring"; className = "live"; }
    else { label = state.health.engine === "up" && state.health.database === "up" && !state.health.generatorRunning ? "Generator idle" : "Pipeline degraded"; className = "degraded"; }
  }
  $("#live-state").className = `live-state ${className}`;
  if ($("#live-label").textContent !== label) $("#live-label").textContent = label;
  $("#updated-at").textContent = state.lastSuccess ? `${state.paused ? "Paused" : "Updated"} at ${time(state.lastSuccess)}${state.paused ? "" : " · refreshes every 3s"}` : "Waiting for first update";
}

function renderStats() {
  const stats = state.stats;
  if (!stats) return;
  $("#kpi-volume").textContent = shortMoney(stats.totalVolume);
  $("#kpi-volume").title = money(stats.totalVolume);
  $("#kpi-average").textContent = `Average transaction ${money(stats.averageAmount)}`;
  $("#kpi-transactions").textContent = integer(stats.totalTransactions);
  $("#kpi-throughput").textContent = `${decimal(stats.transactionsPerMinute)} transactions / min`;
  $("#kpi-flagged").innerHTML = `${integer(stats.flaggedTransactions)}<span class="kpi-rate" id="kpi-fraud-rate">${decimal(stats.fraudRate)}%</span>`;
  $("#kpi-open").textContent = `${integer(stats.openAlerts)} alerts awaiting review`;
  $("#kpi-users").textContent = integer(stats.activeUsers);
  $("#nav-alert-count").textContent = integer(stats.openAlerts);
  $("#nav-alert-count").title = `${integer(stats.openAlerts)} alerts awaiting review in the selected period`;
}

function renderChart() {
  const container = $("#activity-chart");
  const bucketMinutes = Math.max(1, numeric(state.stats?.bucketMinutes) || (state.minutes <= 60 ? 1 : state.minutes <= 360 ? 5 : 30));
  const bucketLabel = bucketMinutes === 1 ? "minute" : `${bucketMinutes} minutes`;
  $(".chart-unit").textContent = `events / ${bucketLabel}`;
  if (!state.stats) { container.innerHTML = empty("Waiting for your data stream", "Start the local pipeline to see transaction activity.", "activity"); return; }
  const series = [...(state.stats.series || [])].filter((item) => validDate(item.time)).sort((first, second) => new Date(first.time) - new Date(second.time));
  if (!series.length || !numeric(state.stats.totalTransactions)) { container.innerHTML = empty("Your next transaction starts here", "Activity will appear as the generator sends events.", "activity"); return; }
  const width = 720, height = 230, left = 42, right = 13, top = 13, bottom = 32;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const maximum = Math.max(1, ...series.map((item) => Math.max(numeric(item.transactions), numeric(item.alerts))));
  const ceiling = Math.max(4, Math.ceil(maximum / 4) * 4);
  const start = new Date(series[0].time).getTime();
  const end = new Date(series[series.length - 1].time).getTime();
  const pointX = (item) => series.length === 1 ? left + plotWidth / 2 : left + ((new Date(item.time).getTime() - start) / Math.max(1, end - start)) * plotWidth;
  const pointY = (amount) => top + plotHeight - numeric(amount) / ceiling * plotHeight;
  const points = series.map((item) => `${pointX(item).toFixed(2)},${pointY(item.transactions).toFixed(2)}`);
  const line = `M${points.join(" L")}`;
  const area = `${line} L${pointX(series[series.length - 1]).toFixed(2)},${top + plotHeight} L${pointX(series[0]).toFixed(2)},${top + plotHeight} Z`;
  let grid = "";
  for (let index = 0; index <= 4; index++) {
    const y = top + plotHeight * index / 4;
    grid += `<line class="chart-grid" x1="${left}" y1="${y}" x2="${width - right}" y2="${y}"/><text class="chart-label" x="${left - 13}" y="${y + 3}" text-anchor="end">${integer(ceiling * (1 - index / 4))}</text>`;
  }
  const labelIndices = [...new Set(Array.from({ length: Math.min(series.length, 6) }, (_, index) => Math.round(index * (series.length - 1) / Math.max(1, Math.min(series.length, 6) - 1))))];
  const labels = labelIndices.map((index) => `<text class="chart-label" x="${pointX(series[index])}" y="${height - 8}" text-anchor="middle">${escapeHtml(new Date(series[index].time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }))}</text>`).join("");
  const alerts = series.filter((item) => numeric(item.alerts) > 0).map((item) => `<circle cx="${pointX(item)}" cy="${pointY(item.alerts)}" r="3" fill="#bf9c6c" stroke="#fff" stroke-width="1.5"><title>${integer(item.alerts)} alerts at ${escapeHtml(time(item.time))}</title></circle>`).join("");
  container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Transactions and fraud alerts per ${bucketLabel}. ${integer(state.stats.totalTransactions)} transactions in the selected period. Boundary buckets may be partial."><defs><linearGradient id="activity-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#94bb8c" stop-opacity=".22"/><stop offset="100%" stop-color="#dcecd3" stop-opacity=".03"/></linearGradient></defs>${grid}<path d="${area}" fill="url(#activity-fill)"/><path d="${line}" fill="none" stroke="#5b916b" stroke-width="2.3" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>${series.length === 1 ? `<circle cx="${pointX(series[0])}" cy="${pointY(series[0].transactions)}" r="3" fill="#5b916b"/>` : ""}${alerts}${labels}<line id="chart-crosshair" x1="0" x2="0" y1="${top}" y2="${top + plotHeight}" stroke="#9db493" stroke-width="1" stroke-dasharray="3 3" opacity="0"/><rect id="chart-hit" x="${left}" y="${top}" width="${plotWidth}" height="${plotHeight}" fill="transparent"/></svg><div id="chart-tooltip" class="chart-tooltip" hidden></div>`;
  const hit = $("#chart-hit");
  hit.addEventListener("pointermove", (event) => {
    const bounds = hit.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    const timestamp = start + fraction * (end - start);
    const item = series.reduce((best, candidate) => Math.abs(new Date(candidate.time) - timestamp) < Math.abs(new Date(best.time) - timestamp) ? candidate : best);
    const crosshair = $("#chart-crosshair");
    crosshair.setAttribute("x1", pointX(item)); crosshair.setAttribute("x2", pointX(item)); crosshair.setAttribute("opacity", "1");
    const tooltip = $("#chart-tooltip");
    tooltip.innerHTML = `<strong>${escapeHtml(time(item.time))} · ${bucketLabel} bucket</strong>${integer(item.transactions)} transactions<br>${integer(item.alerts)} fraud alerts`;
    tooltip.hidden = false;
    tooltip.style.left = `${Math.max(10, Math.min(event.clientX - container.getBoundingClientRect().left + 12, container.clientWidth - tooltip.offsetWidth - 10))}px`;
  });
  hit.addEventListener("pointerleave", () => { $("#chart-tooltip").hidden = true; $("#chart-crosshair").setAttribute("opacity", "0"); });
}

function renderCountries() {
  const countries = [...(state.stats?.countries || [])].sort((first, second) => numeric(second.transactions) - numeric(first.transactions));
  $("#country-count").textContent = state.stats ? `${integer(countries.length)}${countries.length === 10 ? "+" : ""}` : "—";
  if (!countries.length) { $("#country-list").innerHTML = '<div class="empty-state compact">Origins appear when transactions arrive.</div>'; return; }
  const total = numeric(state.stats?.totalTransactions);
  $("#country-list").innerHTML = countries.slice(0, 5).map((country) => {
    const share = total ? numeric(country.transactions) / total * 100 : 0;
    return `<div class="country-row"><div class="country-row-head"><span class="country-flag">${escapeHtml(country.country)}</span><span class="country-name">${escapeHtml(countryName(country.country))}</span><span class="country-number">${integer(country.transactions)}</span><span class="country-percent">${Math.round(share)}%</span></div><div class="country-track" aria-label="${escapeHtml(countryName(country.country))}: ${decimal(share)} percent"><span style="width:${share.toFixed(2)}%"></span></div></div>`;
  }).join("");
}

function statusBadge(status) {
  const labels = { new: "Needs review", reviewed: "Reviewed", dismissed: "Dismissed", flagged: "Flagged", clear: "Clear" };
  const safe = Object.hasOwn(labels, status) ? status : "new";
  return `<span class="badge badge-${safe}">${labels[safe]}</span>`;
}

function riskBadge(score) {
  const number = numeric(score);
  return `<span class="badge ${number >= 80 ? "badge-high" : "badge-medium"}">${number >= 80 ? "High" : "Elevated"} · ${decimal(number, 0)}</span>`;
}

function alertsTable(items, compact) {
  if (!items.length) return empty("No signals in this view", "Try a wider time range or different filters. New signals appear automatically.", "shield");
  return `<table><thead><tr><th>Transaction</th><th>Detection rule</th><th>Amount</th>${compact ? "" : "<th>Risk</th>"}<th>Status</th><th>Detected</th><th><span class="sr-only">Action</span></th></tr></thead><tbody>${items.map((alert) => `<tr><td><span class="table-primary mono" title="${escapeHtml(alert.eventId)}">${escapeHtml(shortId(alert.eventId || alert.transactionId))}</span><span class="table-secondary">${escapeHtml(countryName(alert.country))} · User ${escapeHtml(alert.senderId)}</span></td><td><span class="rule-name"><span class="rule-icon">${icon(ruleIcon(alert.ruleCode))}</span><span>${escapeHtml(alert.ruleName || alert.ruleCode)}</span></span></td><td class="amount">${escapeHtml(money(alert.amount, alert.currency || "USD"))}</td>${compact ? "" : `<td>${riskBadge(alert.riskScore)}</td>`}<td>${statusBadge(alert.status)}</td><td title="${escapeHtml(fullDate(alert.detectedAt))}">${escapeHtml(time(alert.detectedAt))}</td><td><button class="review-link" data-alert-id="${escapeHtml(alert.id)}" aria-label="Investigate alert ${escapeHtml(alert.id)}">Inspect ↗</button></td></tr>`).join("")}</tbody></table>`;
}

function transactionsTable(items) {
  if (!items.length) return empty("No matching transactions", "Try a wider time range or adjust your search and risk filter.", "transactions");
  return `<table><thead><tr><th>Event / sender</th><th>Merchant</th><th>Amount</th><th>Origin</th><th>Risk</th><th>Status</th><th>Event time</th></tr></thead><tbody>${items.map((transaction) => `<tr><td><span class="table-primary mono" title="${escapeHtml(transaction.eventId)}">${escapeHtml(shortId(transaction.eventId))}</span><span class="table-secondary">User ${escapeHtml(transaction.senderId)} → ${escapeHtml(transaction.receiverId)}</span></td><td>${escapeHtml(transaction.merchant || "—")}</td><td class="amount">${escapeHtml(money(transaction.amount, transaction.currency || "USD"))}</td><td><span class="table-primary">${escapeHtml(countryName(transaction.country))}</span><span class="table-secondary mono">${escapeHtml(transaction.senderIp || "—")}</span></td><td>${decimal(transaction.riskScore, 0)}<span class="muted"> / 100</span></td><td>${statusBadge(transaction.status)}</td><td title="${escapeHtml(fullDate(transaction.createdAt))}">${escapeHtml(time(transaction.createdAt))}</td></tr>`).join("")}</tbody></table>`;
}

function renderPagination(kind, total) {
  const container = $(`#${kind}-pagination`);
  if (total === undefined || total === null) { container.innerHTML = ""; return; }
  const offset = kind === "transactions" ? state.transactionOffset : state.alertOffset;
  const count = numeric(total), page = Math.floor(offset / state.pageSize) + 1, pages = Math.max(1, Math.ceil(count / state.pageSize));
  container.innerHTML = `<span>${count ? `${integer(offset + 1)}–${integer(Math.min(offset + state.pageSize, count))}` : "0"} of ${integer(count)} ${kind === "transactions" ? "transactions" : "alerts"}</span><div class="pagination-controls"><span>Page ${integer(page)} of ${integer(pages)}</span><button class="icon-button" data-page="previous" data-kind="${kind}" ${offset === 0 ? "disabled" : ""} aria-label="Previous page">${icon("left")}</button><button class="icon-button" data-page="next" data-kind="${kind}" ${offset + state.pageSize >= count ? "disabled" : ""} aria-label="Next page">${icon("right")}</button></div>`;
}

function renderPipeline() {
  const health = state.health;
  const stale = state.healthError;
  const stages = [
    { name: "Generator", up: health?.generatorRunning },
    { name: "Analytics", up: health?.engine === "up" },
    { name: "PostgreSQL", up: health?.database === "up" },
    { name: "API", up: !!health && !stale }
  ];
  $("#pipeline-stages").innerHTML = stages.map((stage, index) => `${index ? '<span class="stage-connector">→</span>' : ""}<span class="pipeline-stage ${!health || stale ? "" : stage.up ? "up" : "down"}" title="${stage.name}: ${!health || stale ? "unknown" : stage.up ? "running" : "unavailable or idle"}"><span class="mini-dot"></span>${stage.name}</span>`).join("");
  $("#pipeline-caption").textContent = !health ? "Waiting for service health" : stale ? "Health check unavailable · reconnecting" : `${integer(health.processedEvents)} events processed · ${health.status === "ok" ? "Services operational" : "Some services need attention"}`;
}

function ruleIcon(code) {
  const name = String(code || "").toLowerCase();
  if (name.includes("velocity")) return "activity";
  if (name.includes("country") || name.includes("location") || name.includes("travel")) return "globe";
  if (name.includes("amount")) return "wallet";
  return "shield";
}

function renderRules() {
  if (!state.rules) { $("#rules-grid").innerHTML = empty("Rules unavailable", "Check the API connection and try again.", "sliders"); return; }
  const rules = state.rules.items || [];
  if (!rules.length) { $("#rules-grid").innerHTML = empty("No detection rules configured", "Add detection rules to the analytics service to begin monitoring.", "sliders"); return; }
  $("#rules-grid").innerHTML = rules.map((rule) => `<article class="rule-card"><div class="rule-card-top"><span class="rule-card-icon">${icon(ruleIcon(rule.code))}</span><span class="badge ${rule.enabled ? "badge-clear" : "badge-dismissed"}">${rule.enabled ? "Active" : "Disabled"}</span></div><h2>${escapeHtml(rule.name)}</h2><div class="rule-code mono">${escapeHtml(rule.code)}</div><p>${escapeHtml(rule.description)}</p><div class="rule-metadata"><div><span>THRESHOLD</span>${rule.threshold === null || rule.threshold === undefined ? "—" : escapeHtml(rule.threshold)}</div><div><span>TIME WINDOW</span>${numeric(rule.windowSeconds) > 0 ? `${decimal(numeric(rule.windowSeconds) / 60)} min` : "Per event"}</div></div></article>`).join("");
}

function selectView() {
  const requested = location.hash.slice(1);
  state.view = Object.hasOwn(viewLabels, requested) ? requested : "overview";
  const label = viewLabels[state.view];
  document.title = `${label.breadcrumb} · OpenTrace`;
  $("#breadcrumb-title").textContent = label.breadcrumb;
  $("#page-title").innerHTML = `${escapeHtml(label.title)}<span class="title-dot">.</span>`;
  $("#page-description").textContent = label.description;
  document.querySelectorAll(".view").forEach((element) => { element.hidden = element.id !== `view-${state.view}`; });
  document.querySelectorAll(".nav-link").forEach((element) => {
    const active = element.dataset.view === state.view;
    element.classList.toggle("active", active);
    if (active) element.setAttribute("aria-current", "page"); else element.removeAttribute("aria-current");
    element.title = viewLabels[element.dataset.view].breadcrumb;
  });
  $("#export-button").hidden = state.view === "rules";
  if (state.view === "overview" && !state.stats) {
    $("#activity-chart").innerHTML = '<div class="empty-state"><span class="loader"></span><p>Loading transaction activity…</p></div>';
  }
  refresh({ force: true });
}

function openAlert(id) {
  const items = state.view === "alerts" ? state.alerts?.items || [] : state.recentAlerts?.items || [];
  const alert = items.find((item) => String(item.id) === String(id));
  if (!alert) { notify("This alert is no longer in the current view. Refresh to try again."); return; }
  state.selectedAlert = { ...alert };
  // Keep the investigation stable while open; completing an action refreshes its list.
  state.generation += 1;
  state.loading = false;
  $("#refresh-button").classList.remove("loading-icon");
  $("#refresh-button").removeAttribute("aria-busy");
  renderAlertDialog();
  $("#alert-dialog").showModal();
}

function renderAlertDialog() {
  const alert = state.selectedAlert;
  if (!alert) return;
  $("#dialog-title").textContent = alert.ruleName || alert.ruleCode;
  $("#dialog-error").hidden = true;
  $("#dialog-content").innerHTML = `<div class="dialog-badges">${statusBadge(alert.status)}${riskBadge(alert.riskScore)}</div><div class="dialog-summary">${escapeHtml(alert.description || "This transaction matched a configured fraud detection rule.")}</div><dl class="detail-grid"><div><dt>Transaction amount</dt><dd>${escapeHtml(money(alert.amount, alert.currency || "USD"))}</dd></div><div><dt>Origin</dt><dd>${escapeHtml(countryName(alert.country))}</dd></div><div><dt>Sender</dt><dd>User ${escapeHtml(alert.senderId)}</dd></div><div><dt>Detected at</dt><dd>${escapeHtml(fullDate(alert.detectedAt))}</dd></div><div class="detail-full"><dt>Event ID</dt><dd class="mono">${escapeHtml(alert.eventId || "—")}</dd></div><div><dt>Detection rule</dt><dd class="mono">${escapeHtml(alert.ruleCode)}</dd></div><div><dt>Alert reference</dt><dd class="mono">${escapeHtml(alert.id)}</dd></div></dl>`;
  $("#dialog-actions").innerHTML = `${alert.status === "new" ? `<button class="button button-subtle" data-alert-status="dismissed">Dismiss alert</button><button class="button button-primary" data-alert-status="reviewed">${icon("check")}Mark reviewed</button>` : `<button class="button button-white" data-alert-status="new">Reopen alert</button><button class="button button-primary" data-close-dialog>Done</button>`}`;
}

async function updateAlert(status) {
  if (state.saving || !state.selectedAlert) return;
  state.saving = true;
  let saved = false;
  const selected = state.selectedAlert;
  $("#dialog-error").hidden = true;
  $("#close-dialog").disabled = true;
  $("#dialog-actions").querySelectorAll("button").forEach((button) => { button.disabled = true; });
  try {
    await api(`/fraud-alerts/${encodeURIComponent(selected.id)}`, { method: "PATCH", body: JSON.stringify({ status }) });
    for (const collection of [state.recentAlerts, state.alerts]) {
      (collection?.items || []).forEach((item) => { if (String(item.id) === String(selected.id)) item.status = status; });
    }
    state.selectedAlert.status = status;
    saved = true;
    renderAlertDialog();
    notify(status === "new" ? "Alert reopened for review" : `Alert marked as ${status}`);
    refresh({ force: true });
  } catch (error) {
    $("#dialog-error").textContent = "The alert could not be updated. Check the connection and try again.";
    $("#dialog-error").hidden = false;
  } finally {
    state.saving = false;
    $("#close-dialog").disabled = false;
    $("#dialog-actions").querySelectorAll("button").forEach((button) => { button.disabled = false; });
    if (saved) $("#close-dialog").focus();
  }
}

let toastTimer;
function notify(message) {
  clearTimeout(toastTimer);
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  toastTimer = setTimeout(() => { $("#toast").hidden = true; }, 4500);
}

function csvCell(value) {
  let text = String(value ?? "");
  if (typeof value === "string" && /^(?:\s*[=+\-@]|[\t\r])/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

async function exportCsv() {
  if (state.exporting) return;
  state.exporting = true;
  $("#export-button").disabled = true;
  const kind = state.view === "alerts" ? "alerts" : "transactions";
  const basePath = state.view === "overview" ? `/transactions?limit=200&offset=0&minutes=${state.minutes}&risk=all&search=` : listPath(kind, 200, 0);
  const rows = [];
  notify(`Preparing ${kind} export…`);
  try {
    let offset = 0, total = Infinity;
    const seen = new Set();
    while (offset < total) {
      const pagePath = basePath.replace(/([?&])offset=\d+/, `$1offset=${offset}`);
      const page = await api(pagePath);
      if (!Array.isArray(page.items)) throw new Error("Unexpected export response");
      if (offset === 0) total = numeric(page.total);
      if (total > 1000000) throw new Error("Export is too large; select a shorter time range");
      if (!page.items.length) break;
      page.items.forEach((item) => { if (!seen.has(String(item.id))) { rows.push(item); seen.add(String(item.id)); } });
      offset += page.items.length;
    }
    if (!rows.length) { notify("No records match the current filters."); return; }
    const columns = kind === "transactions" ? ["id", "eventId", "senderId", "receiverId", "amount", "currency", "country", "merchant", "createdAt", "riskScore", "status", "senderIp"] : ["id", "transactionId", "eventId", "ruleCode", "ruleName", "riskScore", "description", "status", "detectedAt", "amount", "currency", "country", "senderId"];
    const csv = "\uFEFF" + [columns.map(csvCell).join(","), ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(","))].join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `opentrace-${kind}-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}.csv`;
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    notify(`Exported ${integer(rows.length)} ${kind}. The live stream may change during export.`);
  } catch (error) { notify(error.message.startsWith("Export is too large") ? error.message : "Export failed. Check the connection and try again."); }
  finally { state.exporting = false; $("#export-button").disabled = false; }
}

function resetList(kind) {
  if (kind === "transactions") { state.transactionOffset = 0; state.transactions = null; }
  else { state.alertOffset = 0; state.alerts = null; }
  $(`#${kind}-table`).innerHTML = '<div class="empty-state"><span class="loader"></span><p>Finding matching records…</p></div>';
  $(`#${kind}-pagination`).innerHTML = "";
  refresh({ force: true });
}

$("#range-select").addEventListener("change", (event) => {
  state.minutes = Number(event.target.value);
  state.transactionOffset = 0; state.alertOffset = 0;
  state.stats = null; state.transactions = null; state.alerts = null; state.recentAlerts = null;
  $("#chart-period").textContent = event.target.selectedOptions[0].textContent.toUpperCase();
  ["#kpi-volume", "#kpi-transactions", "#kpi-flagged", "#kpi-users", "#nav-alert-count"].forEach((selector) => { $(selector).textContent = "—"; });
  $("#kpi-average").textContent = "Average transaction —";
  $("#kpi-throughput").textContent = "— transactions / min";
  $("#kpi-open").textContent = "— alerts awaiting review";
  $("#activity-chart").innerHTML = '<div class="empty-state"><span class="loader"></span><p>Loading transaction activity…</p></div>';
  $("#country-count").textContent = "—";
  $("#country-list").innerHTML = '<div class="empty-state compact">Loading countries…</div>';
  $("#recent-alert-count").textContent = "—";
  $("#recent-alerts-table").innerHTML = '<div class="empty-state">Loading alerts…</div>';
  if (state.view === "transactions" || state.view === "alerts") resetList(state.view); else refresh({ force: true });
});
$("#pause-button").addEventListener("click", () => {
  state.paused = !state.paused;
  if (state.paused) {
    state.generation += 1;
    state.loading = false;
    $("#refresh-button").classList.remove("loading-icon");
    $("#refresh-button").removeAttribute("aria-busy");
  }
  const label = state.paused ? "Resume automatic refresh" : "Pause automatic refresh";
  $("#pause-button").innerHTML = icon(state.paused ? "play" : "pause");
  $("#pause-button").title = label;
  $("#pause-button").setAttribute("aria-label", label);
  $("#pause-button").setAttribute("aria-pressed", String(state.paused));
  renderStatus();
  if (!state.paused) refresh({ force: true });
});
$("#refresh-button").addEventListener("click", () => refresh({ force: true }));
$("#retry-button").addEventListener("click", () => refresh({ force: true }));
$("#export-button").addEventListener("click", exportCsv);
$("#risk-filter").addEventListener("change", (event) => { state.risk = event.target.value; resetList("transactions"); });
$("#alert-filter").addEventListener("change", (event) => { state.alertStatus = event.target.value; resetList("alerts"); });
function bindSearch(selector, property, kind) {
  let timer;
  $(selector).addEventListener("input", (event) => {
    clearTimeout(timer);
    state[property] = event.target.value.trim();
    state.generation += 1;
    state.loading = false;
    state.searchPending = true;
    timer = setTimeout(() => { state.searchPending = false; resetList(kind); }, 300);
  });
}
bindSearch("#transaction-search", "transactionSearch", "transactions");
bindSearch("#alert-search", "alertSearch", "alerts");
document.addEventListener("click", (event) => {
  const investigate = event.target.closest("[data-alert-id]");
  if (investigate) openAlert(investigate.dataset.alertId);
  const update = event.target.closest("[data-alert-status]");
  if (update) updateAlert(update.dataset.alertStatus);
  const close = event.target.closest("[data-close-dialog]");
  if (close && !state.saving) $("#alert-dialog").close();
  const page = event.target.closest("[data-page]");
  if (page && !page.disabled) {
    const key = page.dataset.kind === "transactions" ? "transactionOffset" : "alertOffset";
    state[key] = Math.max(0, state[key] + (page.dataset.page === "next" ? state.pageSize : -state.pageSize));
    refresh({ force: true });
  }
});
$("#close-dialog").addEventListener("click", () => { if (!state.saving) $("#alert-dialog").close(); });
$("#alert-dialog").addEventListener("close", () => {
  const id = String(state.selectedAlert?.id);
  const original = [...document.querySelectorAll(".view:not([hidden]) [data-alert-id]")].find((element) => element.dataset.alertId === id);
  (original || $("#main")).focus({ preventScroll: true });
  state.selectedAlert = null;
  if (!state.paused) refresh();
});
$("#alert-dialog").addEventListener("cancel", (event) => { if (state.saving) event.preventDefault(); });
$("#alert-dialog").addEventListener("click", (event) => {
  if (event.target !== $("#alert-dialog") || state.saving) return;
  const bounds = event.target.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) event.target.close();
});
window.addEventListener("hashchange", selectView);
document.addEventListener("visibilitychange", () => { if (!document.hidden && !state.paused) refresh(); });
setInterval(() => { if (!state.paused && !document.hidden) refresh(); }, 3000);
selectView();
