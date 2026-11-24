package com.hairstudio.memberapp;

import androidx.sqlite.SQLiteConnection;
import androidx.sqlite.SQLiteStatement;
import androidx.sqlite.driver.bundled.BundledSQLiteDriver;
import java.io.File;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** One bundled SQLite engine for both physical connections. Framework SQLite
 * transaction emulation is deliberately not used for the read-only snapshot.
 * All methods execute on the plugin's single worker, never on the UI thread. */
public final class RelationalDatabase implements AutoCloseable {
    public static final int MAX_RESULT_BYTES = 1024 * 1024;
    private final BundledSQLiteDriver driver = new BundledSQLiteDriver();
    private SQLiteConnection writer;
    private SQLiteConnection reader;
    private String snapshotToken;
    private boolean snapshotBegun;
    private final String path;

    public RelationalDatabase(File file) {
        path = file.getAbsolutePath();
        writer = driver.open(path, 0x00000002 | 0x00000004); // READWRITE | CREATE
        try {
            exec(writer, "PRAGMA journal_mode=WAL");
            exec(writer, "PRAGMA foreign_keys=ON");
            exec(writer, "PRAGMA synchronous=FULL");
            exec(writer, "PRAGMA busy_timeout=5000");
            if (!"wal".equals(scalar(writer, "PRAGMA journal_mode")) || !"1".equals(scalar(writer, "PRAGMA foreign_keys")) || !"2".equals(scalar(writer, "PRAGMA synchronous"))) throw new IllegalStateException("Required SQLite durability unavailable");
        } catch (RuntimeException error) { writer.close(); writer = null; throw error; }
    }
    private SQLiteConnection writer() { if (writer == null) throw new IllegalStateException("SQLite is closed"); return writer; }
    private SQLiteConnection snapshot(String token) {
        writer();
        if (reader == null || snapshotToken == null || !snapshotToken.equals(token)) throw new IllegalStateException("Snapshot is no longer available");
        return reader;
    }
    private static void exec(SQLiteConnection connection, String sql) {
        try (SQLiteStatement statement = connection.prepare(sql)) { while (statement.step()) { /* Drain PRAGMA results too. */ } }
    }
    private static String scalar(SQLiteConnection connection, String sql) {
        try (SQLiteStatement statement = connection.prepare(sql)) { if (!statement.step()) throw new IllegalStateException("Missing SQLite result"); return statement.getText(0); }
    }
    private static void bind(SQLiteStatement statement, String[] values) {
        if (values.length > 128) throw new IllegalArgumentException("Too many SQL parameters");
        for (int i = 0; i < values.length; i++) { if (values[i] == null) statement.bindNull(i + 1); else statement.bindText(i + 1, values[i]); }
    }
    private static int jsonBytes(String text) {
        if (text == null) return 4;
        int size = 2;
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (c < 32) size += 6;
            else if (c == '"' || c == '\\' || c == '/') size += 2;
            else if (c < 128) size++;
            else if (c < 2048) size += 2;
            else if (Character.isHighSurrogate(c) && i + 1 < text.length() && Character.isLowSurrogate(text.charAt(i + 1))) { size += 4; i++; }
            else size += 3;
            if (size > MAX_RESULT_BYTES) throw new IllegalArgumentException("SQLite value exceeds bridge budget");
        }
        return size;
    }
    private static List<Map<String, String>> rows(SQLiteConnection connection, String sql, String[] values, int maximum) {
        List<Map<String, String>> rows = new ArrayList<>(); int bytes = 16;
        try (SQLiteStatement statement = connection.prepare(sql)) {
            bind(statement, values);
            while (statement.step()) {
                if (rows.size() >= maximum) throw new IllegalArgumentException("Unbounded SQLite query");
                bytes += 3;
                Map<String, String> row = new LinkedHashMap<>();
                for (int i = 0; i < statement.getColumnCount(); i++) {
                    int type = statement.getColumnType(i); String value;
                    if (type == 5) value = null;
                    else if (type == 1) value = Long.toString(statement.getLong(i));
                    else if (type == 3) value = statement.getText(i);
                    else throw new IllegalArgumentException("Unexpected REAL or BLOB in relational query");
                    String column = statement.getColumnName(i);
                    bytes += jsonBytes(column) + jsonBytes(value) + 2;
                    if (bytes > MAX_RESULT_BYTES) throw new IllegalArgumentException("SQLite result exceeds bridge budget");
                    if (row.containsKey(column)) throw new IllegalArgumentException("Ambiguous SQLite result columns");
                    row.put(column, value);
                }
                rows.add(row);
            }
        }
        return rows;
    }
    public void exec(String sql) { exec(writer(), sql); }
    public long run(String sql, String[] values) {
        SQLiteConnection connection = writer();
        try (SQLiteStatement statement = connection.prepare(sql)) { bind(statement, values); if (statement.step()) throw new IllegalArgumentException("Unexpected row in write result"); }
        return Long.parseLong(scalar(connection, "SELECT changes()"));
    }
    public List<Map<String, String>> all(String sql, String[] values) { return rows(writer(), sql, values, 1000); }
    public String openSnapshot() {
        writer(); if (reader != null) throw new IllegalStateException("A snapshot is already active");
        reader = driver.open(path, 0x00000001); // READONLY: never CREATE a missing book.
        try {
            exec(reader, "PRAGMA query_only=ON"); exec(reader, "PRAGMA busy_timeout=5000");
            if (!"wal".equals(scalar(reader, "PRAGMA journal_mode"))) throw new IllegalStateException("Snapshot requires WAL");
            snapshotToken = UUID.randomUUID().toString(); snapshotBegun = false; return snapshotToken;
        } catch (RuntimeException error) { reader.close(); reader = null; snapshotToken = null; throw error; }
    }
    public void beginSnapshot(String token) {
        SQLiteConnection connection = snapshot(token); if (snapshotBegun) throw new IllegalStateException("Snapshot already begun");
        exec(connection, "BEGIN DEFERRED"); snapshotBegun = true;
    }
    public List<Map<String, String>> snapshotAll(String token, String sql, String[] values) {
        SQLiteConnection connection = snapshot(token); if (!snapshotBegun) throw new IllegalStateException("Snapshot has not begun");
        String command = sql.trim().toUpperCase(java.util.Locale.ROOT);
        if (!command.startsWith("SELECT ") && !command.equals("PRAGMA FOREIGN_KEY_CHECK")) throw new IllegalArgumentException("Snapshot query must be read-only");
        return rows(connection, sql, values, 1000);
    }
    public void closeSnapshot(String token) {
        if (reader == null) return;
        SQLiteConnection connection = snapshot(token);
        try { if (snapshotBegun) exec(connection, "ROLLBACK"); }
        finally { try { connection.close(); } finally { reader = null; snapshotToken = null; snapshotBegun = false; } }
    }
    @Override public void close() {
        try { if (reader != null) closeSnapshot(snapshotToken); }
        finally { if (writer != null) { try { try { exec(writer, "ROLLBACK"); } catch (RuntimeException ignored) {} } finally { try { writer.close(); } finally { writer = null; } } } }
    }
}
