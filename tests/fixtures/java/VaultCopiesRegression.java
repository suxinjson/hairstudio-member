package com.hairstudio.memberapp;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

public class VaultCopiesRegression {
    private static final class Backend implements VaultCopies.Backend {
        final Map<String, VaultCopies.Encrypted> disk = new HashMap<>();
        final Set<String> unavailableKeys = new HashSet<>();
        final Set<String> unreadable = new HashSet<>();
        boolean failCommit;
        int commits;
        @Override public VaultCopies.Encrypted encrypt(String prefix, String value) throws Exception {
            if (unavailableKeys.contains(prefix)) throw new Exception("Keystore unavailable");
            return new VaultCopies.Encrypted(value, "iv");
        }
        @Override public String read(String prefix) throws Exception {
            if (unreadable.contains(prefix)) throw new Exception("Unreadable ciphertext");
            VaultCopies.Encrypted value = disk.get(prefix);
            return value == null ? null : value.data;
        }
        @Override public void commit(Map<String, VaultCopies.Encrypted> entries) throws Exception {
            if (failCommit) throw new Exception("Disk full");
            commits++;
            for (Map.Entry<String, VaultCopies.Encrypted> entry : entries.entrySet()) {
                if (entry.getValue() == null) disk.remove(entry.getKey());
                else disk.put(entry.getKey(), entry.getValue());
            }
        }
    }
    private interface Action { void run() throws Exception; }
    private static void rejects(Action action) throws Exception {
        try { action.run(); } catch (Exception expected) { return; }
        throw new AssertionError("Expected failure");
    }
    public static void main(String[] args) throws Exception {
        for (String primary : new String[] { "", "access-" }) {
            String backup = primary.isEmpty() ? "session-backup-" : "access-backup-";
            Backend backend = new Backend();
            VaultCopies vault = new VaultCopies(backend);
            assert vault.read(primary, backup) == null;
            vault.write(primary, backup, "old");
            assert backend.commits == 1 : "Both copies must commit together";

            backend.unavailableKeys.add(primary);
            vault.write(primary, backup, "disabled");
            assert !backend.disk.containsKey(primary) : "Stale primary must be retired";
            vault = new VaultCopies(backend);
            assert vault.read(primary, backup).equals("disabled") : "Restart restored stale authorization";

            backend.unavailableKeys.clear();
            vault.write(primary, backup, "both-current");
            backend.unavailableKeys.add(backup);
            vault.write(primary, backup, "new-session");
            assert !backend.disk.containsKey(backup) : "Stale backup must be retired";
            backend.unreadable.add(primary);
            final VaultCopies current = vault;
            rejects(() -> current.read(primary, backup));
            backend.unreadable.clear();

            backend.unavailableKeys.add(primary);
            int commits = backend.commits;
            rejects(() -> current.write(primary, backup, "lost"));
            assert backend.commits == commits;
            assert current.read(primary, backup).equals("new-session");

            backend.unavailableKeys.clear();
            backend.failCommit = true;
            rejects(() -> current.write(primary, backup, "not-saved"));
            assert new VaultCopies(backend).read(primary, backup).equals("new-session");

            backend.failCommit = false;
            current.write(primary, backup, "repaired");
            backend.unreadable.add(primary);
            assert new VaultCopies(backend).read(primary, backup).equals("repaired");
            backend.unreadable.add(backup);
            rejects(() -> current.read(primary, backup));
        }
        System.out.println("Session and authorization vault fault scenarios passed");
    }
}
