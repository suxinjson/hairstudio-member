package com.hairstudio.memberapp;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;

/** Growth backups use only a user-selected external descriptor. The picker
 * saves no book, SQL, path, URI argument, persistent grant or private file. */
@CapacitorPlugin(name = "ArchiveDocuments")
public class ArchiveDocumentsPlugin extends Plugin {
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final ExecutorService canceller = Executors.newSingleThreadExecutor();
    private final Object state = new Object();
    private boolean active, selecting, destroyed;
    private volatile boolean cancelled;
    private String token, kind;
    private Uri uri;
    private CancellationSignal cancellation;
    private volatile ParcelFileDescriptor descriptor;
    private ArchiveByteTransfer.Writer writer;
    private ArchiveByteTransfer.Reader reader;
    private ArchiveByteTransfer.Verifier verifier;
    private ArchiveByteTransfer.Summary written;

    private boolean reserve(PluginCall call, String mode) {
        synchronized (state) {
            if (destroyed) { call.reject("Archive capture is unavailable", "ARCHIVE_FILE_CAPTURE_LOST"); return false; }
            if (active || !DocumentOperationGate.claim(this)) { call.reject("Another document operation is active", "BACKUP_FILE_BUSY"); return false; }
            active = true; selecting = true; cancelled = false; token = UUID.randomUUID().toString(); kind = mode; cancellation = new CancellationSignal(); return true;
        }
    }
    private boolean captured(PluginCall call) {
        synchronized (state) {
            if (!active || selecting || token == null || !token.equals(call.getString("token"))) { call.reject("Archive capture is unavailable", "ARCHIVE_FILE_CAPTURE_LOST"); return false; }
            return true;
        }
    }
    private void check() throws Exception { if (cancelled) throw new Exception("Archive cancelled"); }
    private void cleanup() {
        try { if (writer != null) writer.close(); } catch (Exception ignored) {} finally { writer = null; }
        try { if (reader != null) reader.close(); } catch (Exception ignored) {} finally { reader = null; }
        try { if (verifier != null) verifier.close(); } catch (Exception ignored) {} finally { verifier = null; }
        try { if (descriptor != null) descriptor.close(); } catch (Exception ignored) {} finally { descriptor = null; }
        synchronized (state) { uri = null; written = null; token = null; kind = null; cancellation = null; active = false; selecting = false; DocumentOperationGate.release(this); }
    }
    private void cleanup(String expected) { synchronized (state) { if (!java.util.Objects.equals(token, expected)) return; } cleanup(); }
    private interface Task { JSObject run() throws Exception; }
    private void submit(PluginCall call, Runnable task) {
        try { worker.execute(task); }
        catch (RejectedExecutionException error) { call.reject("Archive capture is unavailable", "ARCHIVE_FILE_CAPTURE_LOST"); }
    }
    private void dispatch(PluginCall call, Task task) {
        if (!captured(call)) return;
        String expected = call.getString("token");
        submit(call, () -> {
            synchronized (state) { if (!java.util.Objects.equals(token, expected)) { call.reject("Archive capture is unavailable", "ARCHIVE_FILE_CAPTURE_LOST"); return; } }
            try { check(); JSObject result = task.run(); check(); call.resolve(result); }
            // Provider errors, URIs and member content never enter logs or the
            // JS exception. An incomplete external document is never verified.
            catch (Exception error) { cleanup(expected); call.reject("Archive document operation failed", "ARCHIVE_FILE_IO_FAILED"); }
        });
    }
    private ParcelFileDescriptor open(String mode) throws Exception {
        check(); ParcelFileDescriptor value = getContext().getContentResolver().openFileDescriptor(uri, mode, cancellation);
        if (value == null) throw new Exception("Missing external descriptor"); descriptor = value; check(); return value;
    }
    private void launch(PluginCall call, Intent intent) {
        getActivity().runOnUiThread(() -> {
            try { startActivityForResult(call, intent, "archiveSelected"); }
            catch (Exception error) { cleanup(); call.reject("Cannot open document picker", "BACKUP_FILE_UNAVAILABLE"); }
        });
    }
    @PluginMethod public void create(PluginCall call) {
        String fileName = call.getString("fileName");
        if (fileName == null || !fileName.matches("[a-zA-Z0-9_-]{1,180}\\.ndjson")) { call.reject("Invalid archive name", "ARCHIVE_FILE_INVALID"); return; }
        if (!reserve(call, "write")) return;
        launch(call, new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/x-ndjson")
            .putExtra(Intent.EXTRA_TITLE, fileName).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION));
    }
    @PluginMethod public void choose(PluginCall call) {
        if (!reserve(call, "read")) return;
        launch(call, new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
            .putExtra(Intent.EXTRA_MIME_TYPES, new String[] { "application/x-ndjson", "application/json", "text/plain", "application/octet-stream" })
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION));
    }
    @ActivityCallback private void archiveSelected(PluginCall call, ActivityResult result) {
        if (call == null) { cleanup(); return; }
        if (result.getResultCode() != Activity.RESULT_OK || cancelled) { cleanup(); call.resolve(new JSObject().put("cancelled", true)); return; }
        try {
            synchronized (state) {
                if (!active || !selecting || token == null) throw new Exception("Selection interrupted");
                Intent data = result.getData(); Uri selected = data == null ? null : data.getData();
                if (selected == null || !"content".equals(selected.getScheme()) || selected.getAuthority() == null) throw new Exception("External document required");
                String authority = selected.getAuthority(); authority = authority.substring(authority.lastIndexOf('@') + 1);
                if ((getContext().getPackageName() + ".fileprovider").equalsIgnoreCase(authority)) throw new Exception("External document required");
                uri = selected; selecting = false;
                // No provider I/O in the picker callback. Each later operation
                // has a JS deadline/cancel path before a DB transaction waits.
                call.resolve(new JSObject().put("token", token).put("fileName", "member-book.ndjson"));
            }
        } catch (Exception error) { cleanup(); call.reject("Archive selection interrupted", "ARCHIVE_FILE_CAPTURE_LOST"); }
    }
    @PluginMethod public void beginWrite(PluginCall call) {
        dispatch(call, () -> {
            if (!"write".equals(kind) || writer != null || written != null) throw new Exception("Invalid writer state");
            writer = new ArchiveByteTransfer.Writer(new ParcelFileDescriptor.AutoCloseOutputStream(open("wt")));
            return new JSObject().put("sequence", 0).put("byteLength", 0);
        });
    }
    @PluginMethod public void writeChunk(PluginCall call) {
        dispatch(call, () -> {
            String encoded = call.getString("data");
            if (writer == null || encoded == null || encoded.length() == 0 || encoded.length() > ((ArchiveByteTransfer.CHUNK_BYTES + 2) / 3) * 4) throw new Exception("Invalid write block");
            byte[] bytes = Base64.decode(encoded, Base64.NO_WRAP);
            if (!Base64.encodeToString(bytes, Base64.NO_WRAP).equals(encoded)) throw new Exception("Noncanonical block");
            int sequence = call.getInt("sequence", -1); long length = writer.write(sequence, bytes);
            return new JSObject().put("sequence", sequence).put("byteLength", length);
        });
    }
    @PluginMethod public void beginVerify(PluginCall call) {
        dispatch(call, () -> {
            if (writer == null || written != null) throw new Exception("Missing archive writer");
            written = writer.finish(); writer = null; descriptor = null;
            verifier = new ArchiveByteTransfer.Verifier(new ParcelFileDescriptor.AutoCloseInputStream(open("r")), written);
            return new JSObject().put("verifying", true).put("byteLength", written.byteLength).put("sha256", written.sha256());
        });
    }
    @PluginMethod public void verifyChunk(PluginCall call) {
        dispatch(call, () -> {
            if (verifier == null) throw new Exception("Missing archive verifier");
            boolean done = verifier.step(); check();
            if (!done) return new JSObject().put("verified", false);
            JSObject result = new JSObject().put("status", "saved-verified").put("fileName", "member-book.ndjson").put("byteLength", written.byteLength).put("sha256", written.sha256());
            cleanup(); return result;
        });
    }
    @PluginMethod public void beginRead(PluginCall call) {
        dispatch(call, () -> {
            if (!"read".equals(kind) || reader != null) throw new Exception("Invalid reader state");
            reader = new ArchiveByteTransfer.Reader(new ParcelFileDescriptor.AutoCloseInputStream(open("r")));
            return new JSObject().put("sequence", 0).put("byteLength", 0);
        });
    }
    @PluginMethod public void readChunk(PluginCall call) {
        dispatch(call, () -> {
            if (reader == null) throw new Exception("Missing archive reader");
            ArchiveByteTransfer.Chunk chunk = reader.read(call.getInt("sequence", -1));
            JSObject result = new JSObject().put("sequence", chunk.sequence).put("byteLength", chunk.byteLength).put("done", chunk.summary != null);
            if (chunk.summary == null) result.put("data", Base64.encodeToString(chunk.bytes, Base64.NO_WRAP));
            else { result.put("sha256", chunk.summary.sha256()); reader = null; descriptor = null; }
            return result;
        });
    }
    @PluginMethod public void close(PluginCall call) {
        if (!captured(call)) return;
        String expected = call.getString("token");
        submit(call, () -> { cleanup(expected); call.resolve(new JSObject().put("closed", true)); });
    }
    @PluginMethod public void cancel(PluginCall call) {
        synchronized (state) {
            String requested = call.getString("token");
            if (destroyed || !active || cancelled || (requested != null || !selecting) && !java.util.Objects.equals(token, requested)) { call.resolve(new JSObject().put("cancelRequested", false)); return; }
            cancelled = true;
            // Never queue cancellation behind a stalled provider read/write.
            CancellationSignal signal = cancellation; ParcelFileDescriptor fd = descriptor;
            canceller.execute(() -> { try { if (signal != null) signal.cancel(); } catch (Exception ignored) {} try { if (fd != null) fd.close(); } catch (Exception ignored) {} });
            String expected = token;
            if (!selecting) worker.execute(() -> cleanup(expected));
        }
        call.resolve(new JSObject().put("cancelRequested", true));
    }
    @Override protected void handleOnDestroy() {
        synchronized (state) {
            if (destroyed) return;
            destroyed = true;
            cancelled = true; CancellationSignal signal = cancellation; ParcelFileDescriptor fd = descriptor;
            canceller.execute(() -> { try { if (signal != null) signal.cancel(); } catch (Exception ignored) {} try { if (fd != null) fd.close(); } catch (Exception ignored) {} });
        }
        worker.execute(this::cleanup); worker.shutdown(); canceller.shutdown();
    }
}
