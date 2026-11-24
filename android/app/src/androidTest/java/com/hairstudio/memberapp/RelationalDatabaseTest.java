package com.hairstudio.memberapp;

import static org.junit.Assert.*;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import java.io.File;
import java.util.Map;
import java.util.UUID;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class RelationalDatabaseTest {
    private final String[] none = new String[0];
    private File file() { return new File(ApplicationProvider.getApplicationContext().getCacheDir(), "v2-test-" + UUID.randomUUID() + ".sqlite"); }
    private void remove(File file) { for (String suffix : new String[] { "", "-wal", "-shm" }) new File(file.getPath() + suffix).delete(); }
    @Test public void independentSnapshotDoesNotBlockWriterAndKeepsExactOriginalMoney() {
        File file = file();
        try (RelationalDatabase db = new RelationalDatabase(file)) {
            db.exec("CREATE TABLE accounts(id TEXT PRIMARY KEY,cents INTEGER,note TEXT)");
            db.run("INSERT INTO accounts VALUES(?,?,?)", new String[] { "member", "9223372036854775807", null });
            String token = db.openSnapshot(); db.beginSnapshot(token);
            Map<String, String> original = db.snapshotAll(token, "SELECT * FROM accounts", none).get(0);
            assertEquals("9223372036854775807", original.get("cents")); assertNull(original.get("note"));
            db.exec("BEGIN IMMEDIATE"); db.run("UPDATE accounts SET cents=? WHERE id=?", new String[] { "-9223372036854775808", "member" }); db.exec("COMMIT");
            assertEquals("9223372036854775807", db.snapshotAll(token, "SELECT cents FROM accounts", none).get(0).get("cents"));
            assertEquals("-9223372036854775808", db.all("SELECT cents FROM accounts", none).get(0).get("cents"));
            assertThrows(RuntimeException.class, db::openSnapshot); assertThrows(RuntimeException.class, () -> db.snapshotAll("wrong", "SELECT 1", none));
            assertThrows(RuntimeException.class, () -> db.snapshotAll(token, "DELETE FROM accounts", none));
            db.closeSnapshot(token); String next = db.openSnapshot(); db.beginSnapshot(next);
            assertEquals("-9223372036854775808", db.snapshotAll(next, "SELECT cents FROM accounts", none).get(0).get("cents")); db.closeSnapshot(next);
        } finally { remove(file); }
    }
    @Test public void resultBudgetTypesAndClosedSnapshotsFailWithoutMutatingRecords() {
        File file = file();
        try {
            try (RelationalDatabase db = new RelationalDatabase(file)) {
                db.exec("CREATE TABLE records(value TEXT)"); db.run("INSERT INTO records VALUES(?)", new String[] { "retained" });
                assertThrows(RuntimeException.class, () -> db.all("SELECT CAST(1 AS REAL) AS value", none));
                assertThrows(RuntimeException.class, () -> db.all("SELECT zeroblob(1) AS value", none));
                assertThrows(RuntimeException.class, () -> db.all("SELECT 1 AS value,2 AS value", none));
                assertThrows(RuntimeException.class, () -> db.all("WITH RECURSIVE n(x) AS(SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1001) SELECT x FROM n", none));
                assertThrows(RuntimeException.class, () -> db.all("SELECT printf('%1100000s','x') AS value", none));
                assertThrows(RuntimeException.class, () -> db.all("SELECT replace(printf('%200000s','x'),' ',char(1)) AS value", none));
                String token = db.openSnapshot(); assertThrows(RuntimeException.class, () -> db.snapshotAll(token, "SELECT * FROM records", none));
            }
            try (RelationalDatabase reopened = new RelationalDatabase(file)) { assertEquals("retained", reopened.all("SELECT value FROM records", none).get(0).get("value")); }
        } finally { remove(file); }
    }
}
