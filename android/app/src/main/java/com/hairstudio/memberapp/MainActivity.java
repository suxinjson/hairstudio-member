package com.hairstudio.memberapp;

import com.getcapacitor.BridgeActivity;
import android.content.Context;
import android.content.res.Configuration;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.WebView;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

public class MainActivity extends BridgeActivity {
    @Override
    protected void attachBaseContext(Context base) {
        // 简易/老人模式下保持应用现有字号；复制配置，仅调整应用内字体缩放。
        // 保留设备显示密度、语言等配置，不修改系统设置。
        Configuration configuration = new Configuration(base.getResources().getConfiguration());
        configuration.fontScale = 1.0f;
        super.attachBaseContext(base.createConfigurationContext(configuration));
    }

    @Override public void onCreate(Bundle savedInstanceState) {
        registerPlugin(CloudDevicePlugin.class);
        super.onCreate(savedInstanceState);
        installSafeViewport();
        resetSystemBars();
        resetWebViewTextZoom();
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        Configuration configuration = new Configuration(newConfig);
        configuration.fontScale = 1.0f;
        super.onConfigurationChanged(configuration);
        resetSystemBars();
        resetWebViewTextZoom();
    }

    @Override
    public void onResume() {
        super.onResume();
        resetSystemBars();
        // 部分系统 WebView 从设置返回时会重新应用文字缩放。
        resetWebViewTextZoom();
    }

    @Override public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) resetSystemBars();
    }

    private void installSafeViewport() {
        // Android 15 强制 edge-to-edge；所有版本统一由原生层预留实际系统栏尺寸。
        // 包含横屏刘海和输入法，WebView 内的固定按钮始终位于系统导航栏上方。
        View content = findViewById(android.R.id.content);
        content.setBackgroundColor(Color.WHITE);
        ViewCompat.setOnApplyWindowInsetsListener(content, (view, windowInsets) -> {
            Insets bars = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets keyboard = windowInsets.getInsets(WindowInsetsCompat.Type.ime());
            view.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, keyboard.bottom));
            return WindowInsetsCompat.CONSUMED;
        });
        ViewCompat.requestApplyInsets(content);
    }

    @SuppressWarnings("deprecation")
    private void resetSystemBars() {
        Window window = getWindow();
        WindowCompat.setDecorFitsSystemWindows(window, false);
        window.clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        window.getDecorView().setBackgroundColor(Color.WHITE);
        window.setStatusBarColor(Color.WHITE);
        window.setNavigationBarColor(Build.VERSION.SDK_INT >= 26 ? Color.WHITE : Color.rgb(15, 23, 42));
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, window.getDecorView());
        controller.setAppearanceLightStatusBars(true);
        controller.setAppearanceLightNavigationBars(Build.VERSION.SDK_INT >= 26);
        controller.show(WindowInsetsCompat.Type.systemBars());
        if (Build.VERSION.SDK_INT >= 29) {
            window.setStatusBarContrastEnforced(false);
            window.setNavigationBarContrastEnforced(false);
        }
        View content = findViewById(android.R.id.content);
        if (content != null) ViewCompat.requestApplyInsets(content);
    }

    private void resetWebViewTextZoom() {
        if (getBridge() == null) return;
        WebView webView = getBridge().getWebView();
        if (webView != null) webView.getSettings().setTextZoom(100);
    }
}
