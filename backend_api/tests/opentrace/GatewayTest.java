package opentrace;

import java.math.BigDecimal;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Dependency-free boundary tests, run with java -ea. SQL is tested end-to-end. */
public final class GatewayTest {
    public static void main(String[] args) {
        equal("reviewed", StatusPayload.parse(" { \"status\" : \"reviewed\" } \n"));
        equal("new", StatusPayload.parse("{\"st\\u0061tus\":\"n\\u0065w\"}"));
        for (String invalid : List.of("", "null", "[]", "{}", "{\"status\":null}",
                "{\"status\":true}", "{\"status\":\"approved\"}",
                "{\"status\":\"new\",\"status\":\"dismissed\"}",
                "{\"status\":\"new\",\"extra\":1}", "{\"status\":\"new\"} trailing",
                "{\"status\":\"new\",}", "{\"status\":\"n\new\"}",
                "{\"status\":\"\\x6eew\"}", "{\"status\":\"new\"}\u00a0")) {
            reject(() -> StatusPayload.parse(invalid));
        }
        equal("\"quote\\\"slash\\\\line\\n\\u0000\"", Json.stringify("quote\"slash\\line\n\0"));
        equal("123.45", Json.stringify(new BigDecimal("123.45")));
        equal("[true,false,null]", Json.stringify(new Object[]{true, false, null}));
        Map<String, Object> object = new LinkedHashMap<>();
        object.put("value", 42L);
        object.put("empty", null);
        equal("{\"value\":42,\"empty\":null}", Json.stringify(object));
        reject(() -> Json.stringify(Double.NaN));
        reject(() -> Json.stringify(Double.POSITIVE_INFINITY));
        equal("hello world+%", Main.parseQuery("search=hello+world%2B%25").get("search"));
        equal("", Main.parseQuery("search=").get("search"));
        reject(() -> Main.parseQuery("limit=1&limit=2"));
        reject(() -> Main.parseQuery("search=%xy"));
        reject(() -> Main.parseQuery("x=" + "a".repeat(4096)));
        System.out.println("Gateway boundary tests passed (status parsing, JSON, query validation).");
    }

    private static void equal(Object expected, Object actual) {
        if (!expected.equals(actual)) throw new AssertionError("Expected " + expected + " but got " + actual);
    }

    private static void reject(Runnable action) {
        try { action.run(); }
        catch (IllegalArgumentException expected) { return; }
        throw new AssertionError("Expected invalid input to be rejected");
    }
}
