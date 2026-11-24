package com.hairstudio.memberapp;

/** Both the bounded and growth document plugins share one picker/I/O slot. */
final class DocumentOperationGate {
    private static Object owner;
    static synchronized boolean claim(Object candidate) { if (owner != null) return false; owner = candidate; return true; }
    static synchronized void release(Object candidate) { if (owner == candidate) owner = null; }
}
