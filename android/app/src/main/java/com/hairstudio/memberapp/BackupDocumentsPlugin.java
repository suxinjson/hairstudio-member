package com.hairstudio.memberapp;

import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** User-selected external documents only. No cache/private backup files, path
 * arguments, broad storage permissions, persistent URI grants or file logs. */
@CapacitorPlugin(name = "BackupDocuments")
public class BackupDocumentsPlugin extends Plugin {
    private static final int MAX_BYTES = 32 * 1024 * 1024;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Object state = new Object();
    private boolean active;
    private boolean selecting;
    private String stagedToken;
    private byte[] staged;

    private void clear() {
        synchronized (state) {
            if (staged != null) Arrays.fill(staged, (byte) 0);
            staged = null; stagedToken = null; active = false; selecting = false; DocumentOperationGate.release(this);
        }
    }
    private boolean reserve(PluginCall call) {
        synchronized (state) {
            if (active || !DocumentOperationGate.claim(this)) { call.reject("Another document operation is active", "BACKUP_FILE_BUSY"); return false; }
            active = true; return true;
        }
    }
    private Uri selected(PluginCall call, ActivityResult result) throws Exception {
        synchronized (state) {
            // A process restart loses the memory-only export bytes. Never put
            // the full backup in Capacitor's saved Activity/Bundle call data.
            if (!active || !selecting) throw new Exception("Selection interrupted");
        }
        Intent data = result.getData(); Uri uri = data == null ? null : data.getData();
        if (uri == null || !"content".equals(uri.getScheme()) || uri.getAuthority() == null) throw new Exception("External document required");
        String authority = uri.getAuthority(); authority = authority.substring(authority.lastIndexOf('@') + 1);
        if ((getContext().getPackageName() + ".fileprovider").equalsIgnoreCase(authority)) throw new Exception("External document required");
        return uri;
    }
    private String name(Uri uri) {
        try (Cursor cursor = getContext().getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                String value = cursor.getString(0);
                if (value != null && value.length() <= 255) return value;
            }
        } catch (Exception ignored) { }
        return "backup.json";
    }
    private byte[] read(Uri uri, int maxBytes) throws Exception {
        // Metadata is only an early bound; providers can omit or understate it.
        long declaredSize = -1;
        try (Cursor cursor = getContext().getContentResolver().query(uri, new String[] { OpenableColumns.SIZE }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst() && !cursor.isNull(0)) declaredSize = cursor.getLong(0);
        } catch (Exception ignored) { }
        if (declaredSize > maxBytes) throw new Exception("Document too large");
        try (InputStream input = getContext().getContentResolver().openInputStream(uri); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            if (input == null) throw new Exception("Cannot read document");
            byte[] buffer = new byte[8192]; int count, total = 0;
            while ((count = input.read(buffer)) != -1) {
                total += count; if (total > maxBytes) throw new Exception("Document too large");
                output.write(buffer, 0, count);
            }
            return output.toByteArray();
        }
    }
    private String hash(byte[] bytes) throws Exception {
        byte[] value = MessageDigest.getInstance("SHA-256").digest(bytes); StringBuilder result = new StringBuilder(64);
        for (byte item : value) result.append(String.format(Locale.ROOT, "%02x", item & 0xff));
        return result.toString();
    }
    @PluginMethod public void stage(PluginCall call) {
        if (!reserve(call)) return;
        worker.execute(() -> {
            try {
                String content = call.getString("content");
                if (content == null || content.length() == 0 || content.length() > MAX_BYTES) throw new Exception("Invalid document");
                ByteBuffer encoded = StandardCharsets.UTF_8.newEncoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).encode(CharBuffer.wrap(content));
                if (encoded.remaining() > MAX_BYTES) throw new Exception("Document too large");
                synchronized (state) {
                    staged = new byte[encoded.remaining()]; encoded.get(staged); stagedToken = UUID.randomUUID().toString();
                    call.resolve(new JSObject().put("token", stagedToken));
                }
            } catch (Exception error) { clear(); call.reject("Cannot stage backup document", "BACKUP_FILE_INVALID"); }
        });
    }
    @PluginMethod public void discard(PluginCall call) {
        synchronized (state) {
            if (selecting) { call.reject("Document picker is active", "BACKUP_FILE_BUSY"); return; }
            if (stagedToken != null && stagedToken.equals(call.getString("token"))) clear();
        }
        call.resolve(new JSObject().put("discarded", true));
    }
    @PluginMethod public void save(PluginCall call) {
        String fileName = call.getString("fileName"), token = call.getString("token");
        synchronized (state) {
            if (!active || selecting || staged == null || stagedToken == null || !stagedToken.equals(token)) { call.reject("Export capture is no longer available", "BACKUP_FILE_CAPTURE_LOST"); return; }
            if (fileName == null || !fileName.matches("[a-zA-Z0-9_-]{1,180}\\.json")) { call.reject("Invalid backup file name", "BACKUP_FILE_INVALID"); return; }
            selecting = true;
        }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/json")
            .putExtra(Intent.EXTRA_TITLE, fileName).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        getActivity().runOnUiThread(() -> {
            try { startActivityForResult(call, intent, "saveSelected"); }
            catch (Exception error) { clear(); call.reject("Cannot open document picker", "BACKUP_FILE_UNAVAILABLE"); }
        });
    }
    @ActivityCallback private void saveSelected(PluginCall call, ActivityResult result) {
        if (call == null) { clear(); return; }
        if (result.getResultCode() != Activity.RESULT_OK) { clear(); call.resolve(new JSObject().put("cancelled", true)); return; }
        worker.execute(() -> {
            try {
                Uri uri = selected(call, result); byte[] bytes;
                synchronized (state) {
                    if (staged == null || stagedToken == null || !stagedToken.equals(call.getString("token"))) throw new Exception("Export capture lost");
                    bytes = staged;
                }
                try (OutputStream output = getContext().getContentResolver().openOutputStream(uri, "wt")) {
                    if (output == null) throw new Exception("Cannot write document"); output.write(bytes); output.flush();
                }
                // Reopen after close. A completed share dialog or a private
                // cached file is not proof that an external backup was saved.
                byte[] verified = read(uri, bytes.length); String checksum = hash(bytes);
                if (verified.length != bytes.length || !MessageDigest.isEqual(MessageDigest.getInstance("SHA-256").digest(bytes), MessageDigest.getInstance("SHA-256").digest(verified))) throw new Exception("Document verification failed");
                call.resolve(new JSObject().put("status", "saved-verified").put("fileName", name(uri)).put("byteLength", bytes.length).put("sha256", checksum));
                Arrays.fill(verified, (byte) 0);
            } catch (Exception error) { call.reject("Backup document was not verified; keep the original book", "BACKUP_FILE_WRITE_FAILED"); }
            finally { clear(); }
        });
    }
    @PluginMethod public void open(PluginCall call) {
        if (maxBytes(call) < 1) { call.reject("Invalid document limit", "BACKUP_FILE_INVALID"); return; }
        if (!reserve(call)) return;
        synchronized (state) { selecting = true; }
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
            .putExtra(Intent.EXTRA_MIME_TYPES, new String[] { "application/json", "text/plain", "application/octet-stream" })
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        getActivity().runOnUiThread(() -> {
            try { startActivityForResult(call, intent, "openSelected"); }
            catch (Exception error) { clear(); call.reject("Cannot open document picker", "BACKUP_FILE_UNAVAILABLE"); }
        });
    }
    private int maxBytes(PluginCall call) {
        int limit = call.getInt("maxBytes", MAX_BYTES);
        return limit >= 1 && limit <= MAX_BYTES ? limit : -1;
    }
    @ActivityCallback private void openSelected(PluginCall call, ActivityResult result) {
        if (call == null) { clear(); return; }
        if (result.getResultCode() != Activity.RESULT_OK) { clear(); call.resolve(new JSObject().put("cancelled", true)); return; }
        worker.execute(() -> {
            try {
                Uri uri = selected(call, result); byte[] bytes = read(uri, maxBytes(call));
                String content = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
                call.resolve(new JSObject().put("content", content).put("fileName", name(uri)).put("byteLength", bytes.length).put("sha256", hash(bytes)));
                Arrays.fill(bytes, (byte) 0);
            } catch (Exception error) { call.reject("Cannot read a bounded UTF-8 backup document", "BACKUP_FILE_READ_FAILED"); }
            finally { clear(); }
        });
    }
    @Override protected void handleOnDestroy() { worker.execute(this::clear); worker.shutdown(); }
}
