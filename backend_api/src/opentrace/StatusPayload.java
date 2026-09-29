package opentrace;

import java.util.Set;

/** Deliberately accepts only the one string property supported by PATCH. */
final class StatusPayload {
    private static final Set<String> STATUSES = Set.of("new", "reviewed", "dismissed");
    private final String text;
    private int position;

    private StatusPayload(String text) { this.text = text; }

    static String parse(String text) {
        StatusPayload parser = new StatusPayload(text);
        parser.expect('{');
        if (!parser.string().equals("status")) throw invalid();
        parser.expect(':');
        String status = parser.string();
        parser.expect('}');
        parser.whitespace();
        if (parser.position != text.length() || !STATUSES.contains(status)) throw invalid();
        return status;
    }

    private String string() {
        expect('"');
        StringBuilder result = new StringBuilder();
        while (position < text.length()) {
            char c = text.charAt(position++);
            if (c == '"') return result.toString();
            if (c < 0x20) throw invalid();
            if (c != '\\') {
                result.append(c);
                continue;
            }
            if (position >= text.length()) throw invalid();
            char escaped = text.charAt(position++);
            switch (escaped) {
                case '"', '\\', '/' -> result.append(escaped);
                case 'b' -> result.append('\b');
                case 'f' -> result.append('\f');
                case 'n' -> result.append('\n');
                case 'r' -> result.append('\r');
                case 't' -> result.append('\t');
                case 'u' -> {
                    if (position + 4 > text.length()) throw invalid();
                    int code = 0;
                    for (int i = 0; i < 4; i++) {
                        char hex = text.charAt(position++);
                        if (!(hex >= '0' && hex <= '9') && !(hex >= 'a' && hex <= 'f')
                                && !(hex >= 'A' && hex <= 'F')) throw invalid();
                        code = code * 16 + Character.digit(hex, 16);
                    }
                    result.append((char) code);
                }
                default -> throw invalid();
            }
        }
        throw invalid();
    }

    private void expect(char expected) {
        whitespace();
        if (position >= text.length() || text.charAt(position++) != expected) throw invalid();
    }

    private void whitespace() {
        while (position < text.length() && " \r\n\t".indexOf(text.charAt(position)) >= 0) position++;
    }

    private static IllegalArgumentException invalid() {
        return new IllegalArgumentException("Body must contain only status: new, reviewed, or dismissed");
    }
}
