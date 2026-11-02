package com.hairstudio.memberapp;

import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.net.ssl.HttpsURLConnection;

@CapacitorPlugin(name = "CloudDevice")
public class CloudDevicePlugin extends Plugin {
    private static final String KEY_ALIAS = "member-cloud-session-v1";
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private SharedPreferences preferences() { return getContext().getSharedPreferences("member_cloud_vault", 0); }
    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (!store.containsAlias(KEY_ALIAS)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build());
            generator.generateKey();
        }
        return (SecretKey) store.getKey(KEY_ALIAS, null);
    }
    @PluginMethod public void saveSession(PluginCall call) {
        try {
            String session = call.getString("session");
            if (session == null || session.length() > 4096) throw new Exception();
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key());
            String data = Base64.encodeToString(cipher.doFinal(session.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP);
            String iv = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP);
            if (!preferences().edit().putString("data", data).putString("iv", iv).commit()) throw new Exception();
            call.resolve();
        } catch (Exception error) { call.reject("安全会话保存失败，请重试登录"); }
    }
    @PluginMethod public void loadSession(PluginCall call) {
        try {
            String data = preferences().getString("data", null);
            if (data == null) { call.resolve(new JSObject().put("session", null)); return; }
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(preferences().getString("iv", ""), Base64.NO_WRAP)));
            String session = new String(cipher.doFinal(Base64.decode(data, Base64.NO_WRAP)), StandardCharsets.UTF_8);
            call.resolve(new JSObject().put("session", session));
        } catch (Exception error) {
            preferences().edit().clear().commit();
            call.resolve(new JSObject().put("session", null));
        }
    }
    @PluginMethod public void clearSession(PluginCall call) {
        if (preferences().edit().clear().commit()) call.resolve();
        else call.reject("清除安全会话失败，请重试");
    }
    private String hash(byte[] bytes) throws Exception { return hex(MessageDigest.getInstance("SHA-256").digest(bytes)); }
    private String hex(byte[] bytes) { StringBuilder text = new StringBuilder(); for (byte value : bytes) text.append(String.format("%02x", value & 255)); return text.toString(); }
    private int signingFlags() { return Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES; }
    @SuppressWarnings("deprecation") private String[] certificates(PackageInfo info) throws Exception {
        if (Build.VERSION.SDK_INT >= 28 && info.signingInfo == null) throw new Exception("安装包缺少有效签名");
        Signature[] signatures = Build.VERSION.SDK_INT >= 28 ? info.signingInfo.getApkContentsSigners() : info.signatures;
        if (signatures == null || signatures.length == 0) throw new Exception("安装包缺少签名");
        String[] hashes = new String[signatures.length];
        for (int i = 0; i < signatures.length; i++) hashes[i] = hash(signatures[i].toByteArray());
        Arrays.sort(hashes); return hashes;
    }
    @SuppressWarnings("deprecation") private long version(PackageInfo info) { return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode; }
    private void verifyApk(File apk, String expectedHash, long expectedVersion) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream input = new FileInputStream(apk)) { byte[] buffer = new byte[65536]; int count; while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count); }
        if (!hex(digest.digest()).equals(expectedHash)) throw new Exception("安装包完整性校验失败，请重新下载");
        PackageManager manager = getContext().getPackageManager();
        PackageInfo installed = manager.getPackageInfo(getContext().getPackageName(), signingFlags());
        PackageInfo candidate = manager.getPackageArchiveInfo(apk.getAbsolutePath(), signingFlags());
        if (candidate == null || !installed.packageName.equals(candidate.packageName)) throw new Exception("安装包包名不匹配");
        if (version(candidate) != expectedVersion || version(candidate) <= version(installed)) throw new Exception("更新版本号无效或低于当前版本");
        if (candidate.applicationInfo == null || candidate.applicationInfo.minSdkVersion > Build.VERSION.SDK_INT) throw new Exception("此更新不支持当前安卓版本");
        if (!Arrays.equals(certificates(installed), certificates(candidate))) throw new Exception("安装包签名与当前应用不一致");
    }
    private File updateFile(String name) throws Exception {
        if (name == null || !name.matches("[a-f0-9]{64}\\.apk")) throw new Exception("更新文件名无效");
        File directory = new File(getContext().getCacheDir(), "updates");
        if (!directory.exists() && !directory.mkdirs()) throw new Exception("无法创建更新缓存");
        return new File(directory, name);
    }
    @PluginMethod public void downloadUpdate(PluginCall call) {
        worker.execute(() -> {
            File temporary = null; HttpsURLConnection connection = null;
            try {
                URL url = new URL(call.getString("url", "")), origin = new URL(call.getString("serverOrigin", ""));
                if (!"https".equals(url.getProtocol()) || !url.getHost().equals(origin.getHost()) || url.getPort() != origin.getPort() ||
                    url.getUserInfo() != null || !url.getPath().matches("/api/v1/updates/files/[a-f0-9]{64}\\.apk")) throw new Exception("更新下载地址不可信");
                String expectedHash = call.getString("sha256", "");
                long expectedVersion = call.getData().optLong("versionCode", -1);
                long expectedSize = call.getData().optLong("size", -1);
                if (!expectedHash.matches("[a-f0-9]{64}") || expectedVersion < 1 || expectedSize <= 0 || expectedSize > 250L * 1024 * 1024) throw new Exception("更新清单无效");
                File target = updateFile(expectedHash + ".apk");
                temporary = new File(target.getParentFile(), UUID.randomUUID() + ".part");
                connection = (HttpsURLConnection) url.openConnection();
                connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(15000); connection.setReadTimeout(30000);
                connection.setRequestProperty("Authorization", "Bearer " + call.getString("accessToken", ""));
                if (connection.getResponseCode() != 200) throw new Exception("更新下载失败，请联网后重新登录并重试");
                if (connection.getContentLengthLong() != expectedSize) throw new Exception("更新文件大小不一致");
                long total = 0, previousProgress = -1;
                try (InputStream input = connection.getInputStream(); FileOutputStream output = new FileOutputStream(temporary)) {
                    byte[] buffer = new byte[65536]; int count;
                    while ((count = input.read(buffer)) != -1) {
                        total += count; if (total > expectedSize) throw new Exception("更新文件超过预期大小");
                        output.write(buffer, 0, count);
                        long progress = total * 100 / expectedSize;
                        if (progress != previousProgress) { notifyListeners("downloadProgress", new JSObject().put("progress", progress)); previousProgress = progress; }
                    }
                    output.getFD().sync();
                }
                if (total != expectedSize) throw new Exception("下载中断，请重新下载");
                verifyApk(temporary, expectedHash, expectedVersion);
                if (target.exists() && !target.delete()) throw new Exception("无法替换更新缓存");
                if (!temporary.renameTo(target)) throw new Exception("无法保存更新文件");
                call.resolve(new JSObject().put("fileName", target.getName()).put("verified", true));
            } catch (Exception error) {
                if (temporary != null) temporary.delete();
                call.reject(error.getMessage() == null ? "更新下载失败，请重试" : error.getMessage());
            } finally { if (connection != null) connection.disconnect(); }
        });
    }
    @PluginMethod public void installUpdate(PluginCall call) {
        worker.execute(() -> {
            try {
                String hash = call.getString("sha256", ""); long expectedVersion = call.getData().optLong("versionCode", -1);
                File apk = updateFile(call.getString("fileName"));
                if (!hash.matches("[a-f0-9]{64}") || expectedVersion < 1 || !apk.isFile()) throw new Exception("请先下载并校验更新");
                verifyApk(apk, hash, expectedVersion);
                getActivity().runOnUiThread(() -> {
                    try {
                        if (Build.VERSION.SDK_INT >= 26 && !getContext().getPackageManager().canRequestPackageInstalls()) {
                            getActivity().startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName())));
                            call.resolve(new JSObject().put("status", "permission-required")); return;
                        }
                        Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
                        Intent intent = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive");
                        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        getActivity().startActivity(intent);
                        call.resolve(new JSObject().put("status", "installer-opened"));
                    } catch (Exception error) { call.reject("无法打开安装界面，请重试"); }
                });
            } catch (Exception error) { call.reject(error.getMessage()); }
        });
    }
    @Override protected void handleOnDestroy() { worker.shutdownNow(); }
}
