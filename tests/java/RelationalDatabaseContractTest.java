package com.hairstudio.memberapp;

import static org.junit.Assert.*;
import java.io.File;
import java.nio.file.Files;
import org.junit.Test;

/** Desktop execution of the exact Android helper with the same bundled SQLite
 * release's JVM native build. This does not exercise Android JNI or lifecycle. */
public class RelationalDatabaseContractTest {
    private final String[] none = new String[0];
    private void remove(File file) { for (String suffix : new String[] { "", "-wal", "-shm" }) new File(file.getPath() + suffix).delete(); file.getParentFile().delete(); }
    private File file() throws Exception { return Files.createTempDirectory("member-native-contract-").resolve("book.sqlite").toFile(); }
    @Test public void nativeEngineSnapshotAllowsWritesAndPersistsExactBigints() throws Exception {
        File file = file();
        try {
            try (RelationalDatabase db = new RelationalDatabase(file)) {
                db.exec("CREATE TABLE accounts(id TEXT PRIMARY KEY,cents INTEGER,note TEXT)");
                db.run("INSERT INTO accounts VALUES(?,?,?)", new String[] { "one", "9223372036854775807", null });
                String token = db.openSnapshot(); db.beginSnapshot(token);
                assertEquals("9223372036854775807", db.snapshotAll(token, "SELECT cents FROM accounts", none).get(0).get("cents"));
                db.exec("BEGIN IMMEDIATE"); db.run("UPDATE accounts SET cents=?", new String[] { "-9223372036854775808" }); db.exec("COMMIT");
                assertEquals("9223372036854775807", db.snapshotAll(token, "SELECT cents FROM accounts", none).get(0).get("cents"));
                assertEquals("-9223372036854775808", db.all("SELECT cents FROM accounts", none).get(0).get("cents"));
                assertNull(db.all("SELECT note FROM accounts", none).get(0).get("note"));
                assertThrows(RuntimeException.class, db::openSnapshot); db.closeSnapshot(token);
                String next = db.openSnapshot(); db.beginSnapshot(next); assertEquals("-9223372036854775808", db.snapshotAll(next, "SELECT cents FROM accounts", none).get(0).get("cents"));
            }
            try (RelationalDatabase reopened = new RelationalDatabase(file)) { assertEquals("-9223372036854775808", reopened.all("SELECT cents FROM accounts", none).get(0).get("cents")); }
        } finally { remove(file); }
    }
    @Test public void readerIsPhysicallyReadOnlyAndRequiresCorrectTokenAndExplicitTransaction() throws Exception {
        File file = file(); try (RelationalDatabase db = new RelationalDatabase(file)) {
            db.exec("CREATE TABLE retained(value TEXT)"); db.run("INSERT INTO retained VALUES(?)", new String[] { "original" }); String token = db.openSnapshot();
            assertThrows(RuntimeException.class, () -> db.snapshotAll(token, "SELECT * FROM retained", none)); db.beginSnapshot(token);
            assertThrows(RuntimeException.class, () -> db.beginSnapshot(token)); assertThrows(RuntimeException.class, () -> db.snapshotAll("wrong", "SELECT 1", none));
            assertThrows(RuntimeException.class, () -> db.snapshotAll(token, "DELETE FROM retained", none));
            assertThrows(RuntimeException.class, () -> db.snapshotAll(token, "PRAGMA query_only=OFF", none));
            assertEquals("original", db.snapshotAll(token, "SELECT * FROM retained", none).get(0).get("value"));
            db.closeSnapshot(token); assertThrows(RuntimeException.class, () -> db.snapshotAll(token, "SELECT 1", none));
        } finally { remove(file); }
    }
    @Test public void resultBudgetCountsJsonEscapingAndRejectsUnboundedRowsAndLossyTypes() throws Exception {
        File file = file(); try (RelationalDatabase db = new RelationalDatabase(file)) {
            for (String sql : new String[] { "SELECT 1.5 AS value", "SELECT zeroblob(1) AS value", "SELECT 1 AS same,2 AS same", "SELECT printf('%1100000s','x') AS value", "SELECT replace(printf('%200000s','x'),' ',char(1)) AS value", "WITH RECURSIVE n(x) AS(SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1001) SELECT x FROM n" }) assertThrows(sql, RuntimeException.class, () -> db.all(sql, none));
            assertEquals(1000, db.all("WITH RECURSIVE n(x) AS(SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000) SELECT x FROM n", none).size());
            assertEquals("中文😀", db.all("SELECT '中文😀' AS value", none).get(0).get("value"));
        } finally { remove(file); }
    }
    @Test public void writeAndRollbackKeepForeignKeysAndFullDurability() throws Exception {
        File file = file(); try (RelationalDatabase db = new RelationalDatabase(file)) {
            assertEquals("wal", db.all("PRAGMA journal_mode", none).get(0).get("journal_mode"));
            assertEquals("1", db.all("PRAGMA foreign_keys", none).get(0).get("foreign_keys"));
            assertEquals("2", db.all("PRAGMA synchronous", none).get(0).get("synchronous"));
            db.exec("CREATE TABLE parent(id TEXT PRIMARY KEY)"); db.exec("CREATE TABLE child(parent TEXT REFERENCES parent(id))");
            assertThrows(RuntimeException.class, () -> db.run("INSERT INTO child VALUES(?)", new String[] { "missing" }));
            db.exec("BEGIN IMMEDIATE"); assertEquals(1, db.run("INSERT INTO parent VALUES(?)", new String[] { "one" })); db.exec("ROLLBACK");
            assertEquals("0", db.all("SELECT count(*) AS n FROM parent", none).get(0).get("n"));
        } finally { remove(file); }
    }
}
