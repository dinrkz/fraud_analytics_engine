package opentrace;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URLDecoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.SQLException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/** Small Java 21 HTTP gateway. Analytics is performed by Python; SQL reads stay here. */
public final class Main {
    private final Database database = new Database();
    private final HttpClient engineClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3))
            .followRedirects(HttpClient.Redirect.NEVER).build();
    private final String engineUrl = Database.env("ENGINE_URL", "http://localhost:8000").replaceAll("/+$", "");
    private final Path staticRoot;

    private Main() throws IOException {
        String directory = System.getenv("STATIC_DIR");
        staticRoot = directory == null || directory.isBlank() ? null : Path.of(directory).toRealPath();
    }

    public static void main(String[] args) throws IOException {
        Main application = new Main();
        int port = Integer.parseInt(Database.env("API_PORT", "8080"));
        String host = Database.env("API_HOST", "127.0.0.1");
        HttpServer server = HttpServer.create(new InetSocketAddress(host, port), 64);
        var executor = new ThreadPoolExecutor(4, 16, 30, TimeUnit.SECONDS,
                new ArrayBlockingQueue<>(128), new ThreadPoolExecutor.CallerRunsPolicy());
        server.setExecutor(executor);
        server.createContext("/", application::handle);
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            server.stop(2);
            executor.shutdown();
        }));
        server.start();
        System.out.println("OpenTrace Java API listening on " + host + ":" + port);
    }

    private void handle(HttpExchange exchange) throws IOException {
        try {
            exchange.getResponseHeaders().set("X-Content-Type-Options", "nosniff");
            exchange.getResponseHeaders().set("Referrer-Policy", "same-origin");
            String path = exchange.getRequestURI().getPath();
            String method = exchange.getRequestMethod();
            if (path.startsWith("/engine/")) {
                proxyEngine(exchange);
            } else if (path.equals("/healthz")) {
                requireMethod(method, "GET");
                respond(exchange, 200, Map.of("status", "ok", "service", "opentrace-api"));
            } else if (path.equals("/api/health")) {
                requireMethod(method, "GET");
                respond(exchange, 200, health());
            } else if (path.equals("/api/stats")) {
                requireMethod(method, "GET");
                respond(exchange, 200, stats(parameters(exchange)));
            } else if (path.equals("/api/transactions")) {
                requireMethod(method, "GET");
                respond(exchange, 200, transactions(parameters(exchange)));
            } else if (path.equals("/api/fraud-alerts")) {
                requireMethod(method, "GET");
                respond(exchange, 200, alerts(parameters(exchange)));
            } else if (path.matches("/api/fraud-alerts/[1-9][0-9]*")) {
                requireMethod(method, "PATCH");
                long id;
                try { id = Long.parseLong(path.substring(path.lastIndexOf('/') + 1)); }
                catch (NumberFormatException error) { throw new IllegalArgumentException("Invalid alert id"); }
                respond(exchange, 200, updateAlert(id, readStatus(exchange)));
            } else if (path.equals("/api/rules")) {
                requireMethod(method, "GET");
                try (Connection connection = database.open()) {
                    respond(exchange, 200, Map.of("items", Database.query(connection, """
                        SELECT code, name, description, enabled, threshold, window_seconds AS "windowSeconds"
                        FROM rules ORDER BY code
                        """)));
                }
            } else if (!path.startsWith("/api/") && staticRoot != null) {
                serveStatic(exchange, path);
            } else {
                throw new HttpError(404, "Endpoint not found");
            }
        } catch (HttpError error) {
            if (error.status == 405) exchange.getResponseHeaders().set("Allow", error.allowedMethod);
            respond(exchange, error.status, Map.of("error", error.getMessage()));
        } catch (IllegalArgumentException error) {
            respond(exchange, 400, Map.of("error", error.getMessage() == null ? "Invalid request" : error.getMessage()));
        } catch (SQLException error) {
            System.err.println("Database request failed (SQLSTATE " + error.getSQLState() + ")");
            respond(exchange, 503, Map.of("error", "Database temporarily unavailable"));
        } catch (Exception error) {
            System.err.println("Request failed: " + error.getClass().getSimpleName());
            respond(exchange, 500, Map.of("error", "Internal server error"));
        } finally {
            exchange.close();
        }
    }

    private Map<String, Object> health() {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("status", "degraded");
        result.put("database", "down");
        result.put("engine", "down");
        result.put("lastHeartbeatAt", null);
        result.put("processedEvents", 0);
        result.put("generatorRunning", false);
        try (Connection connection = database.open()) {
            Database.one(connection, "SELECT 1");
            result.put("database", "up");
            List<Map<String, Object>> rows = Database.query(connection, """
                SELECT last_heartbeat_at AS "lastHeartbeatAt", processed_events AS "processedEvents",
                       generator_running AS "generatorRunning",
                       (last_heartbeat_at >= now() - interval '30 seconds' AND last_error IS NULL) AS alive
                FROM engine_state WHERE id = 1
                """);
            if (!rows.isEmpty()) {
                Map<String, Object> row = rows.getFirst();
                result.put("lastHeartbeatAt", row.get("lastHeartbeatAt"));
                result.put("processedEvents", row.get("processedEvents"));
                result.put("generatorRunning", row.get("generatorRunning"));
                if (Boolean.TRUE.equals(row.get("alive"))) {
                    result.put("engine", "up");
                    result.put("status", "ok");
                }
            }
        } catch (SQLException error) {
            System.err.println("Health database check failed (SQLSTATE " + error.getSQLState() + ")");
        }
        return result;
    }

    private Map<String, Object> stats(Map<String, String> parameters) throws SQLException {
        int minutes = minutes(parameters);
        int bucket = minutes <= 60 ? 1 : minutes <= 360 ? 5 : 30;
        try (Connection connection = database.open()) {
            snapshot(connection);
            Map<String, Object> result = Database.one(connection, """
                SELECT count(*) AS "totalTransactions", COALESCE(sum(amount), 0) AS "totalVolume",
                       COALESCE(round(avg(amount), 2), 0) AS "averageAmount",
                       count(*) FILTER (WHERE is_flagged) AS "flaggedTransactions",
                       COALESCE(round(100.0 * count(*) FILTER (WHERE is_flagged) / NULLIF(count(*), 0), 2), 0) AS "fraudRate",
                       count(DISTINCT sender_id) AS "activeUsers",
                       round(count(*)::numeric / ?, 2) AS "transactionsPerMinute",
                       max(created_at) AS "lastEventAt"
                FROM transactions WHERE created_at >= now() - (? * interval '1 minute') AND created_at <= now()
                """, minutes, minutes);
            result.put("openAlerts", Database.one(connection, """
                SELECT count(*) AS total FROM fraud_alerts a JOIN transactions t ON t.id = a.transaction_id
                WHERE a.status = 'new' AND t.created_at >= now() - (? * interval '1 minute') AND t.created_at <= now()
                """, minutes).get("total"));
            result.put("series", Database.query(connection, """
                WITH bounds AS (
                    SELECT now() AS finish, now() - (? * interval '1 minute') AS start,
                           (? * interval '1 minute') AS step
                ), buckets AS (
                    SELECT generate_series(date_bin(step, start, timestamptz '2000-01-01'),
                                           date_bin(step, finish, timestamptz '2000-01-01'), step) AS time FROM bounds
                ), tx AS (
                    SELECT date_bin(b.step, t.created_at, timestamptz '2000-01-01') AS time,
                           count(*) AS transactions, sum(t.amount) AS volume
                    FROM transactions t CROSS JOIN bounds b WHERE t.created_at BETWEEN b.start AND b.finish
                    GROUP BY 1
                ), flags AS (
                    SELECT date_bin(b.step, t.created_at, timestamptz '2000-01-01') AS time, count(*) AS alerts
                    FROM fraud_alerts a JOIN transactions t ON t.id = a.transaction_id CROSS JOIN bounds b
                    WHERE t.created_at BETWEEN b.start AND b.finish GROUP BY 1
                )
                SELECT buckets.time, COALESCE(tx.transactions, 0) AS transactions,
                       COALESCE(flags.alerts, 0) AS alerts, COALESCE(tx.volume, 0) AS volume
                FROM buckets LEFT JOIN tx USING (time) LEFT JOIN flags USING (time) ORDER BY buckets.time
                """, minutes, bucket));
            result.put("countries", Database.query(connection, """
                SELECT country, count(*) AS transactions, COALESCE(sum(amount), 0) AS volume
                FROM transactions WHERE created_at >= now() - (? * interval '1 minute') AND created_at <= now()
                GROUP BY country ORDER BY transactions DESC, country LIMIT 10
                """, minutes));
            result.put("rules", Database.query(connection, """
                SELECT r.code, r.name, COALESCE(counts.alerts, 0) AS alerts
                FROM rules r LEFT JOIN (
                    SELECT a.rule_code, count(*) AS alerts FROM transactions t
                    JOIN fraud_alerts a ON a.transaction_id = t.id
                    WHERE t.created_at >= now() - (? * interval '1 minute') AND t.created_at <= now()
                    GROUP BY a.rule_code
                ) counts ON counts.rule_code = r.code
                ORDER BY alerts DESC, r.code
                """, minutes));
            result.put("windowMinutes", minutes);
            result.put("bucketMinutes", bucket);
            connection.commit();
            return result;
        }
    }

    private Map<String, Object> transactions(Map<String, String> parameters) throws SQLException {
        int limit = integer(parameters, "limit", 25, 1, 200);
        int offset = integer(parameters, "offset", 0, 0, 1_000_000);
        String risk = choice(parameters, "risk", "all", Set.of("all", "flagged"));
        List<Object> values = new ArrayList<>(List.of(minutes(parameters)));
        String where = " WHERE t.created_at >= now() - (? * interval '1 minute') AND t.created_at <= now()";
        if (risk.equals("flagged")) where += " AND t.is_flagged";
        String search = search(parameters);
        if (!search.isEmpty()) {
            where += " AND (t.event_id::text ILIKE ? OR t.sender_id::text ILIKE ? OR t.merchant ILIKE ? OR t.country ILIKE ?)";
            for (int i = 0; i < 4; i++) values.add(like(search));
        }
        try (Connection connection = database.open()) {
            snapshot(connection);
            Object total = Database.one(connection, "SELECT count(*) AS total FROM transactions t" + where,
                    values.toArray()).get("total");
            values.add(limit);
            values.add(offset);
            List<Map<String, Object>> items = Database.query(connection, """
                SELECT t.id, t.event_id AS "eventId", t.sender_id AS "senderId", t.receiver_id AS "receiverId",
                       t.amount, t.currency, t.country, t.merchant, t.created_at AS "createdAt", t.risk_score AS "riskScore",
                       CASE WHEN t.is_flagged THEN 'flagged' ELSE 'clear' END AS status,
                       host(t.sender_ip) AS "senderIp"
                FROM transactions t
                """ + where + " ORDER BY t.created_at DESC, t.id DESC LIMIT ? OFFSET ?", values.toArray());
            connection.commit();
            return Map.of("items", items, "total", total);
        }
    }

    private Map<String, Object> alerts(Map<String, String> parameters) throws SQLException {
        int limit = integer(parameters, "limit", 25, 1, 200);
        int offset = integer(parameters, "offset", 0, 0, 1_000_000);
        String status = choice(parameters, "status", "all", Set.of("all", "new", "reviewed", "dismissed"));
        List<Object> values = new ArrayList<>(List.of(minutes(parameters)));
        String where = " WHERE t.created_at >= now() - (? * interval '1 minute') AND t.created_at <= now()";
        if (!status.equals("all")) {
            where += " AND a.status = ?";
            values.add(status);
        }
        String search = search(parameters);
        if (!search.isEmpty()) {
            where += " AND (t.event_id::text ILIKE ? OR t.sender_id::text ILIKE ? OR r.name ILIKE ? OR t.country ILIKE ?)";
            for (int i = 0; i < 4; i++) values.add(like(search));
        }
        String from = " FROM fraud_alerts a JOIN transactions t ON t.id = a.transaction_id JOIN rules r ON r.code = a.rule_code";
        try (Connection connection = database.open()) {
            snapshot(connection);
            Object total = Database.one(connection, "SELECT count(*) AS total" + from + where, values.toArray()).get("total");
            values.add(limit);
            values.add(offset);
            List<Map<String, Object>> items = Database.query(connection, """
                SELECT a.id, a.transaction_id AS "transactionId", t.event_id AS "eventId", a.rule_code AS "ruleCode",
                       r.name AS "ruleName", a.risk_score AS "riskScore", a.description, a.status,
                       a.detected_at AS "detectedAt", t.amount, t.currency, t.country, t.sender_id AS "senderId"
                """ + from + where + " ORDER BY a.detected_at DESC, a.id DESC LIMIT ? OFFSET ?", values.toArray());
            connection.commit();
            return Map.of("items", items, "total", total);
        }
    }

    private Map<String, Object> updateAlert(long id, String status) throws SQLException {
        try (Connection connection = database.open()) {
            List<Map<String, Object>> rows = Database.query(connection,
                    "UPDATE fraud_alerts SET status = ? WHERE id = ? RETURNING id, status", status, id);
            if (rows.isEmpty()) throw new HttpError(404, "Alert not found");
            return rows.getFirst();
        }
    }

    private static void snapshot(Connection connection) throws SQLException {
        connection.setReadOnly(true);
        connection.setTransactionIsolation(Connection.TRANSACTION_REPEATABLE_READ);
        connection.setAutoCommit(false);
    }

    private static String readStatus(HttpExchange exchange) throws IOException {
        String contentType = exchange.getRequestHeaders().getFirst("Content-Type");
        if (contentType == null || !contentType.split(";", 2)[0].trim().equalsIgnoreCase("application/json"))
            throw new HttpError(415, "Content-Type must be application/json");
        byte[] bytes = exchange.getRequestBody().readNBytes(1025);
        if (bytes.length > 1024) throw new HttpError(413, "Request body exceeds 1024 bytes");
        try {
            String body = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
            return StatusPayload.parse(body);
        } catch (CharacterCodingException error) {
            throw new IllegalArgumentException("Request body must use UTF-8");
        }
    }

    static Map<String, String> parseQuery(String raw) {
        Map<String, String> result = new HashMap<>();
        if (raw == null || raw.isEmpty()) return result;
        if (raw.length() > 4096) throw new IllegalArgumentException("Query string is too long");
        for (String field : raw.split("&")) {
            String[] pair = field.split("=", 2);
            String key = URLDecoder.decode(pair[0], StandardCharsets.UTF_8);
            String value = pair.length == 2 ? URLDecoder.decode(pair[1], StandardCharsets.UTF_8) : "";
            if (result.putIfAbsent(key, value) != null) throw new IllegalArgumentException("Duplicate query parameter: " + key);
        }
        return result;
    }

    private static Map<String, String> parameters(HttpExchange exchange) {
        return parseQuery(exchange.getRequestURI().getRawQuery());
    }

    private static int minutes(Map<String, String> parameters) { return integer(parameters, "minutes", 60, 1, 1440); }

    private static int integer(Map<String, String> values, String key, int fallback, int minimum, int maximum) {
        if (!values.containsKey(key)) return fallback;
        try {
            int value = Integer.parseInt(values.get(key));
            if (value < minimum || value > maximum) throw new NumberFormatException();
            return value;
        } catch (NumberFormatException error) {
            throw new IllegalArgumentException(key + " must be an integer from " + minimum + " to " + maximum);
        }
    }

    private static String choice(Map<String, String> values, String key, String fallback, Set<String> allowed) {
        String value = values.getOrDefault(key, fallback);
        if (!allowed.contains(value)) throw new IllegalArgumentException("Invalid " + key);
        return value;
    }

    private static String search(Map<String, String> parameters) {
        String value = parameters.getOrDefault("search", "").strip();
        if (value.length() > 100 || value.indexOf('\0') >= 0) throw new IllegalArgumentException("Invalid search text (maximum 100 characters)");
        return value;
    }

    private static String like(String value) {
        return "%" + value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%";
    }

    private static void requireMethod(String actual, String expected) {
        if (!actual.equals(expected)) throw new HttpError(405, "Method not allowed", expected);
    }

    private void proxyEngine(HttpExchange exchange) throws IOException {
        if (!Set.of("GET", "HEAD", "POST").contains(exchange.getRequestMethod()))
            throw new HttpError(405, "Method not allowed", "GET, HEAD, POST");
        byte[] body = exchange.getRequestBody().readNBytes(1_048_577);
        if (body.length > 1_048_576) throw new HttpError(413, "Engine request exceeds 1 MiB");
        String upstreamPath = exchange.getRequestURI().getRawPath().substring("/engine".length());
        String query = exchange.getRequestURI().getRawQuery();
        URI target = URI.create(engineUrl + upstreamPath + (query == null ? "" : "?" + query));
        HttpRequest.Builder builder = HttpRequest.newBuilder(target).timeout(Duration.ofSeconds(15))
                .method(exchange.getRequestMethod(), body.length == 0
                        ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofByteArray(body));
        for (String name : List.of("Content-Type", "Accept")) {
            String value = exchange.getRequestHeaders().getFirst(name);
            if (value != null) builder.header(name, value);
        }
        try {
            HttpResponse<java.io.InputStream> response = engineClient.send(builder.build(), HttpResponse.BodyHandlers.ofInputStream());
            byte[] responseBody;
            try (var stream = response.body()) { responseBody = stream.readNBytes(2_097_153); }
            if (responseBody.length > 2_097_152) throw new HttpError(502, "Engine response exceeds 2 MiB");
            exchange.getResponseHeaders().set("Content-Type", response.headers().firstValue("Content-Type").orElse("application/json"));
            exchange.getResponseHeaders().set("Cache-Control", "no-store");
            if (exchange.getRequestMethod().equals("HEAD") || response.statusCode() == 204 || response.statusCode() == 304) {
                exchange.sendResponseHeaders(response.statusCode(), -1);
            } else {
                exchange.sendResponseHeaders(response.statusCode(), responseBody.length);
                exchange.getResponseBody().write(responseBody);
            }
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new HttpError(503, "Engine request interrupted");
        } catch (IOException error) {
            throw new HttpError(502, "Analytics engine temporarily unavailable");
        }
    }

    private void serveStatic(HttpExchange exchange, String path) throws IOException {
        if (!Set.of("GET", "HEAD").contains(exchange.getRequestMethod()))
            throw new HttpError(405, "Method not allowed", "GET, HEAD");
        Path file;
        try { file = staticRoot.resolve(path.substring(1)).normalize(); }
        catch (java.nio.file.InvalidPathException error) { throw new HttpError(400, "Invalid path"); }
        if (!file.startsWith(staticRoot)) throw new HttpError(403, "Forbidden path");
        if (Files.isDirectory(file)) file = file.resolve("index.html");
        if (!Files.isRegularFile(file)) throw new HttpError(404, "File not found");
        file = file.toRealPath();
        if (!file.startsWith(staticRoot)) throw new HttpError(403, "Forbidden path");
        String name = file.getFileName().toString();
        String type = name.endsWith(".html") ? "text/html; charset=utf-8"
                : name.endsWith(".js") ? "text/javascript; charset=utf-8"
                : name.endsWith(".css") ? "text/css; charset=utf-8"
                : name.endsWith(".svg") ? "image/svg+xml"
                : name.endsWith(".png") ? "image/png"
                : name.endsWith(".ico") ? "image/x-icon"
                : name.endsWith(".woff2") ? "font/woff2"
                : name.endsWith(".json") ? "application/json; charset=utf-8" : "application/octet-stream";
        exchange.getResponseHeaders().set("Content-Type", type);
        exchange.getResponseHeaders().set("Cache-Control", "no-cache");
        if (exchange.getRequestMethod().equals("HEAD")) {
            exchange.getResponseHeaders().set("Content-Length", Long.toString(Files.size(file)));
            exchange.sendResponseHeaders(200, -1);
        } else {
            exchange.sendResponseHeaders(200, Files.size(file));
            Files.copy(file, exchange.getResponseBody());
        }
    }

    private static void respond(HttpExchange exchange, int status, Object body) throws IOException {
        byte[] bytes = Json.stringify(body).getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        exchange.getResponseHeaders().set("Cache-Control", "no-store");
        exchange.sendResponseHeaders(status, bytes.length);
        exchange.getResponseBody().write(bytes);
    }

    private static final class HttpError extends RuntimeException {
        final int status;
        final String allowedMethod;
        HttpError(int status, String message) { this(status, message, ""); }
        HttpError(int status, String message, String allowedMethod) {
            super(message);
            this.status = status;
            this.allowedMethod = allowedMethod;
        }
    }
}
