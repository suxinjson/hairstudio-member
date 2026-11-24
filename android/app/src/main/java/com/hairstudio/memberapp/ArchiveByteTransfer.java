package com.hairstudio.memberapp;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;

/** Bounded byte transfer only: no JSON, paths, URI permissions or whole files. */
public final class ArchiveByteTransfer {
    public static final int CHUNK_BYTES = 64 * 1024;
    public static final long MAX_BYTES = 8L * 1024 * 1024 * 1024;
    private static MessageDigest hash() { try { return MessageDigest.getInstance("SHA-256"); } catch (NoSuchAlgorithmException error) { throw new IllegalStateException(error); } }
    public static String hex(byte[] value) { StringBuilder out = new StringBuilder(64); for (byte b : value) { out.append(Character.forDigit((b >>> 4) & 15, 16)); out.append(Character.forDigit(b & 15, 16)); } return out.toString(); }
    public static final class Summary {
        public final long byteLength;
        private final byte[] digest;
        private Summary(long byteLength, byte[] digest) { this.byteLength = byteLength; this.digest = digest.clone(); }
        public String sha256() { return hex(digest); }
    }
    public static final class Chunk {
        public final byte[] bytes;
        public final long sequence;
        public final long byteLength;
        public final Summary summary;
        private Chunk(byte[] bytes, long sequence, long byteLength, Summary summary) { this.bytes = bytes; this.sequence = sequence; this.byteLength = byteLength; this.summary = summary; }
    }
    public static final class Writer implements AutoCloseable {
        private final OutputStream output;
        private final MessageDigest hash = hash();
        private long length, sequence;
        private boolean closed;
        public Writer(OutputStream output) { if (output == null) throw new IllegalArgumentException("Missing output stream"); this.output = output; }
        public long write(long number, byte[] bytes) throws IOException {
            if (closed || number != sequence || bytes.length == 0 || bytes.length > CHUNK_BYTES || length + bytes.length > MAX_BYTES) throw new IOException("Invalid archive write sequence or size");
            output.write(bytes); hash.update(bytes); length += bytes.length; sequence++; return length;
        }
        public Summary finish() throws IOException {
            if (closed) throw new IOException("Archive writer closed");
            try { output.flush(); } finally { close(); }
            return new Summary(length, hash.digest());
        }
        @Override public void close() throws IOException { if (!closed) { closed = true; output.close(); } }
    }
    public static final class Reader implements AutoCloseable {
        private final InputStream input;
        private final MessageDigest hash = hash();
        private final byte[] buffer = new byte[CHUNK_BYTES];
        private long length, sequence;
        private boolean closed;
        public Reader(InputStream input) { if (input == null) throw new IllegalArgumentException("Missing input stream"); this.input = input; }
        public Chunk read(long number) throws IOException {
            if (closed || number != sequence) throw new IOException("Invalid archive read sequence");
            int n = input.read(buffer);
            if (n == -1) { Summary summary = new Summary(length, hash.digest()); close(); return new Chunk(new byte[0], sequence++, length, summary); }
            if (n <= 0 || length + n > MAX_BYTES) throw new IOException("Archive read stalled or exceeded size");
            hash.update(buffer, 0, n); length += n; return new Chunk(Arrays.copyOf(buffer, n), sequence++, length, null);
        }
        @Override public void close() throws IOException { if (!closed) { closed = true; try { input.close(); } finally { Arrays.fill(buffer, (byte) 0); } } }
    }
    public static final class Verifier implements AutoCloseable {
        private final Reader reader;
        private final Summary expected;
        private long sequence;
        private boolean done;
        public Verifier(InputStream input, Summary expected) { this.reader = new Reader(input); this.expected = expected; }
        public boolean step() throws IOException {
            if (done) throw new IOException("Archive verification completed");
            // One bridge operation verifies at most 1 MiB; no unbounded native
            // scan inside a single promise, even for the maximum-size file.
            for (int i = 0; i < 16; i++) {
                Chunk chunk = reader.read(sequence++);
                if (chunk.byteLength > expected.byteLength) throw new IOException("Readback longer than written archive");
                if (chunk.summary != null) {
                    done = true;
                    if (chunk.summary.byteLength != expected.byteLength || !MessageDigest.isEqual(chunk.summary.digest, expected.digest)) throw new IOException("Readback mismatch");
                    return true;
                }
            }
            return false;
        }
        @Override public void close() throws IOException { reader.close(); }
    }
}
