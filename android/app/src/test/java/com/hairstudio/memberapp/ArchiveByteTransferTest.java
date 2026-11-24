package com.hairstudio.memberapp;

import static org.junit.Assert.*;
import java.io.*;
import java.security.MessageDigest;
import java.util.Arrays;
import org.junit.Test;

public class ArchiveByteTransferTest {
    private byte[] sample(int length) { byte[] bytes = new byte[length]; for (int i = 0; i < length; i++) bytes[i] = (byte) (i * 37 + (i >>> 3)); return bytes; }
    private ArchiveByteTransfer.Summary write(byte[] bytes, OutputStream output) throws Exception {
        try (ArchiveByteTransfer.Writer writer = new ArchiveByteTransfer.Writer(output)) {
            int sequence = 0;
            for (int at = 0; at < bytes.length; at += ArchiveByteTransfer.CHUNK_BYTES) writer.write(sequence++, Arrays.copyOfRange(bytes, at, Math.min(bytes.length, at + ArchiveByteTransfer.CHUNK_BYTES)));
            return writer.finish();
        }
    }
    @Test public void exactBytesAndReadbackAcrossChunkBoundaries() throws Exception {
        for (int length : new int[] { 0, 1, 65535, 65536, 65537, 1048583 }) {
            byte[] bytes = sample(length); ByteArrayOutputStream output = new ByteArrayOutputStream();
            ArchiveByteTransfer.Summary summary = write(bytes, output);
            assertArrayEquals(bytes, output.toByteArray()); assertEquals(length, summary.byteLength);
            assertEquals(ArchiveByteTransfer.hex(MessageDigest.getInstance("SHA-256").digest(bytes)), summary.sha256());
            try (ArchiveByteTransfer.Reader reader = new ArchiveByteTransfer.Reader(new ByteArrayInputStream(bytes))) {
                int sequence = 0; long count = 0;
                for (;;) { ArchiveByteTransfer.Chunk chunk = reader.read(sequence++); assertTrue(chunk.bytes.length <= 65536); count += chunk.bytes.length; assertEquals(count, chunk.byteLength); if (chunk.summary != null) { assertEquals(summary.sha256(), chunk.summary.sha256()); break; } }
                assertThrows(IOException.class, () -> reader.read(0));
            }
            try (ArchiveByteTransfer.Verifier verifier = new ArchiveByteTransfer.Verifier(new ByteArrayInputStream(bytes), summary)) { while (!verifier.step()) {} assertThrows(IOException.class, verifier::step); }
        }
    }
    @Test public void reorderedEmptyOversizedAndClosedWritesFail() throws Exception {
        ArchiveByteTransfer.Writer writer = new ArchiveByteTransfer.Writer(new ByteArrayOutputStream());
        assertThrows(IOException.class, () -> writer.write(1, new byte[1])); assertThrows(IOException.class, () -> writer.write(0, new byte[0]));
        assertThrows(IOException.class, () -> writer.write(0, new byte[65537])); assertEquals(1, writer.write(0, new byte[1]));
        assertThrows(IOException.class, () -> writer.write(0, new byte[1])); writer.close(); writer.close();
        assertThrows(IOException.class, () -> writer.write(1, new byte[1])); assertThrows(IOException.class, writer::finish);
    }
    @Test public void mutatedTruncatedAndExtendedReadbackFail() throws Exception {
        byte[] bytes = sample(100000); ArchiveByteTransfer.Summary summary = write(bytes, new ByteArrayOutputStream());
        byte[] changed = bytes.clone(); changed[1234] ^= 1;
        for (byte[] bad : new byte[][] { changed, Arrays.copyOf(bytes, bytes.length - 1), Arrays.copyOf(bytes, bytes.length + 1) }) {
            try (ArchiveByteTransfer.Verifier verifier = new ArchiveByteTransfer.Verifier(new ByteArrayInputStream(bad), summary)) { assertThrows(IOException.class, () -> { while (!verifier.step()) {} }); }
        }
    }
    @Test public void providerReadWriteFlushAndCloseFaultsNeverProduceVerifiedSuccess() throws Exception {
        for (String fault : new String[] { "write", "flush", "close" }) {
            OutputStream broken = new OutputStream() {
                public void write(int b) throws IOException { if (fault.equals("write")) throw new IOException("fault"); }
                public void flush() throws IOException { if (fault.equals("flush")) throw new IOException("fault"); }
                public void close() throws IOException { if (fault.equals("close")) throw new IOException("fault"); }
            };
            assertThrows(IOException.class, () -> write(sample(10), broken));
        }
        for (int result : new int[] { 0, -2 }) {
            try (ArchiveByteTransfer.Reader reader = new ArchiveByteTransfer.Reader(new InputStream() { public int read() { return result; } public int read(byte[] b) { return result; } })) { assertThrows(IOException.class, () -> reader.read(0)); }
        }
        try (ArchiveByteTransfer.Reader reader = new ArchiveByteTransfer.Reader(new ByteArrayInputStream(sample(1)))) { assertThrows(IOException.class, () -> reader.read(1)); }
    }
    @Test public void verificationWorkPerCallIsBoundedWithoutMaterializingTheWholeSource() throws Exception {
        byte[] block = sample(65536); final long length = 32L * 1024 * 1024;
        ArchiveByteTransfer.Summary summary;
        try (ArchiveByteTransfer.Writer writer = new ArchiveByteTransfer.Writer(OutputStream.nullOutputStream())) { for (int i = 0; i < length / block.length; i++) writer.write(i, block); summary = writer.finish(); }
        final long[] consumed = { 0 };
        InputStream generated = new InputStream() {
            public int read() { throw new AssertionError("unbounded single-byte input"); }
            public int read(byte[] bytes) { if (consumed[0] == length) return -1; System.arraycopy(block, 0, bytes, 0, block.length); consumed[0] += block.length; return block.length; }
        };
        try (ArchiveByteTransfer.Verifier verifier = new ArchiveByteTransfer.Verifier(generated, summary)) {
            boolean done; do { long before = consumed[0]; done = verifier.step(); assertTrue(consumed[0] - before <= 1048576); } while (!done);
        }
        assertEquals(length, consumed[0]);
    }
    @Test public void documentGateCannotBeReleasedByADifferentOwner() {
        Object first = new Object(), other = new Object();
        assertTrue(DocumentOperationGate.claim(first)); assertFalse(DocumentOperationGate.claim(other));
        DocumentOperationGate.release(other); assertFalse(DocumentOperationGate.claim(other));
        DocumentOperationGate.release(first); assertTrue(DocumentOperationGate.claim(other)); DocumentOperationGate.release(other);
    }
}
