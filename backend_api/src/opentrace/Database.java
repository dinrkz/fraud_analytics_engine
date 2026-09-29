package opentrace;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;

final class Database {
    private final String url;
    private final Properties properties = new Properties();

    Database() {
        url = "jdbc:postgresql://" + env("DB_HOST", "localhost") + ":" + env("DB_PORT", "55432")
                + "/" + env("DB_NAME", "opentrace");
        properties.setProperty("user", env("DB_USER", "opentrace"));
        properties.setProperty("password", env("DB_PASSWORD", "opentrace_local"));
        properties.setProperty("connectTimeout", "3");
        properties.setProperty("socketTimeout", "12");
        properties.setProperty("ApplicationName", "opentrace-api");
    }

    Connection open() throws SQLException {
        return DriverManager.getConnection(url, properties);
    }

    static String env(String name, String fallback) {
        String value = System.getenv(name);
        return value == null || value.isBlank() ? fallback : value;
    }

    static List<Map<String, Object>> query(Connection connection, String sql, Object... parameters)
            throws SQLException {
        try (var statement = connection.prepareStatement(sql)) {
            statement.setQueryTimeout(8);
            for (int i = 0; i < parameters.length; i++) statement.setObject(i + 1, parameters[i]);
            try (ResultSet result = statement.executeQuery()) {
                List<Map<String, Object>> rows = new ArrayList<>();
                int columns = result.getMetaData().getColumnCount();
                while (result.next()) {
                    Map<String, Object> row = new LinkedHashMap<>();
                    for (int column = 1; column <= columns; column++) {
                        Object value = result.getObject(column);
                        if (value instanceof Timestamp timestamp) value = timestamp.toInstant().toString();
                        row.put(result.getMetaData().getColumnLabel(column), value);
                    }
                    rows.add(row);
                }
                return rows;
            }
        }
    }

    static Map<String, Object> one(Connection connection, String sql, Object... parameters)
            throws SQLException {
        return query(connection, sql, parameters).getFirst();
    }
}
