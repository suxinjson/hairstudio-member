package com.hairstudio.memberapp;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.List;
import java.util.Map;
import org.json.JSONObject;

/** One private v2 database and one worker. Money never crosses the
 * JS bridge as a double. No caller-controlled database or backup file paths. */
@CapacitorPlugin(name = "RelationalSqlite")
public class RelationalSqlitePlugin extends Plugin {
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private RelationalDatabase database;

    private RelationalDatabase db() throws Exception {
        if (database == null) throw new Exception("SQLite is not open");
        return database;
    }
    private String sql(PluginCall call) throws Exception {
        String sql = call.getString("sql");
        if (sql == null || sql.length() == 0 || sql.length() > 65536) throw new Exception("Invalid SQL request");
        return sql;
    }
    private String[] parameters(PluginCall call) throws Exception {
        JSArray input = call.getArray("parameters", new JSArray());
        if (input.length() > 128) throw new Exception("Too many SQL parameters");
        String[] values = new String[input.length()];
        for (int i = 0; i < input.length(); i++) {
            Object value = input.get(i);
            if (value == JSONObject.NULL) values[i] = null;
            else if (value instanceof String) values[i] = (String) value;
            else throw new Exception("SQL parameters must be text or null");
        }
        return values;
    }
    private interface Task { JSObject run() throws Exception; }
    private void dispatch(PluginCall call, Task task) {
        try { worker.execute(() -> {
            try { call.resolve(task.run()); }
            // SQL and bound values can contain private member information.
            // Return a stable failure code, never log SQL, values or DB errors.
            catch (Exception error) { call.reject("SQLite operation failed", "SQLITE_OPERATION_FAILED"); }
            catch (LinkageError error) { call.reject("SQLite native runtime unavailable", "SQLITE_RUNTIME_UNAVAILABLE"); }
        }); } catch (RejectedExecutionException error) { call.reject("SQLite is closed", "SQLITE_OPERATION_FAILED"); }
    }
    @PluginMethod public void open(PluginCall call) {
        dispatch(call, () -> {
            if (database != null) throw new Exception("SQLite connection already owned");
            File file = getContext().getDatabasePath("member-relational-v2.sqlite");
            File parent = file.getParentFile();
            if (parent == null || (!parent.exists() && !parent.mkdirs())) throw new Exception("Cannot create database directory");
            database = new RelationalDatabase(file);
            return new JSObject().put("opened", true);
        });
    }
    @PluginMethod public void exec(PluginCall call) {
        dispatch(call, () -> {
            db().exec(sql(call));
            return new JSObject().put("success", true);
        });
    }
    @PluginMethod public void run(PluginCall call) {
        dispatch(call, () -> {
            return new JSObject().put("changes", db().run(sql(call), parameters(call)));
        });
    }
    @PluginMethod public void all(PluginCall call) {
        dispatch(call, () -> result(db().all(sql(call), parameters(call))));
    }
    private JSObject result(List<Map<String, String>> values) {
        JSArray rows = new JSArray();
        for (Map<String, String> value : values) {
            JSObject row = new JSObject();
            for (Map.Entry<String, String> entry : value.entrySet()) row.put(entry.getKey(), entry.getValue() == null ? JSONObject.NULL : entry.getValue());
            rows.put(row);
        }
        return new JSObject().put("rows", rows);
    }
    private String token(PluginCall call) throws Exception {
        String value = call.getString("token");
        if (value == null || !value.matches("[a-f0-9-]{36}")) throw new Exception("Invalid snapshot token");
        return value;
    }
    @PluginMethod public void openSnapshot(PluginCall call) {
        dispatch(call, () -> new JSObject().put("token", db().openSnapshot()));
    }
    @PluginMethod public void snapshotExec(PluginCall call) {
        dispatch(call, () -> {
            if (!"BEGIN".equalsIgnoreCase(sql(call).trim())) throw new Exception("Invalid snapshot command");
            db().beginSnapshot(token(call)); return new JSObject().put("success", true);
        });
    }
    @PluginMethod public void snapshotAll(PluginCall call) {
        dispatch(call, () -> result(db().snapshotAll(token(call), sql(call), parameters(call))));
    }
    @PluginMethod public void closeSnapshot(PluginCall call) {
        dispatch(call, () -> { db().closeSnapshot(token(call)); return new JSObject().put("closed", true); });
    }
    private void closeDatabase() {
        if (database != null) {
            try { database.close(); } finally { database = null; }
        }
    }
    @PluginMethod public void close(PluginCall call) {
        dispatch(call, () -> { closeDatabase(); return new JSObject().put("closed", true); });
    }
    @Override protected void handleOnDestroy() {
        worker.execute(() -> { try { closeDatabase(); } catch (Exception ignored) {} });
        worker.shutdown();
    }
}
