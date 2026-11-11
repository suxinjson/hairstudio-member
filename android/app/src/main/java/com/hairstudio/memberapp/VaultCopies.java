package com.hairstudio.memberapp;

import java.util.LinkedHashMap;
import java.util.Map;

/** Commits redundant encrypted copies together, retiring any copy that could not be refreshed. */
final class VaultCopies {
    static final class Encrypted {
        final String data;
        final String iv;
        Encrypted(String data, String iv) { this.data = data; this.iv = iv; }
    }
    interface Backend {
        Encrypted encrypt(String prefix, String value) throws Exception;
        String read(String prefix) throws Exception;
        // Null entries remove the old ciphertext. All entries must commit atomically.
        void commit(Map<String, Encrypted> entries) throws Exception;
    }
    private final Backend backend;
    VaultCopies(Backend backend) { this.backend = backend; }

    synchronized void write(String primary, String backup, String value) throws Exception {
        Map<String, Encrypted> entries = new LinkedHashMap<>();
        boolean written = false;
        for (String prefix : new String[] { primary, backup }) {
            Encrypted encrypted = null;
            try { encrypted = backend.encrypt(prefix, value); } catch (Exception ignored) {}
            entries.put(prefix, encrypted);
            written |= encrypted != null;
        }
        if (!written) throw new Exception("No vault key is available");
        // A successful backup must never coexist with a readable stale primary.
        backend.commit(entries);
    }

    synchronized String read(String primary, String backup) throws Exception {
        boolean failed = false;
        for (String prefix : new String[] { primary, backup }) {
            try {
                String value = backend.read(prefix);
                if (value != null) return value;
            } catch (Exception ignored) { failed = true; }
        }
        if (failed) throw new Exception("Vault copies are unreadable");
        return null;
    }
}
