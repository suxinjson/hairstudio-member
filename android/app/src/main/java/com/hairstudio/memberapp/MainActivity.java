package com.hairstudio.memberapp;

import com.getcapacitor.BridgeActivity;
import android.content.Context;
import android.content.res.Configuration;
import android.os.Bundle;
import android.webkit.WebView;

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
        resetWebViewTextZoom();
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        Configuration configuration = new Configuration(newConfig);
        configuration.fontScale = 1.0f;
        super.onConfigurationChanged(configuration);
        resetWebViewTextZoom();
    }

    @Override
    public void onResume() {
        super.onResume();
        // 部分系统 WebView 从设置返回时会重新应用文字缩放。
        resetWebViewTextZoom();
    }

    private void resetWebViewTextZoom() {
        if (getBridge() == null) return;
        WebView webView = getBridge().getWebView();
        if (webView != null) webView.getSettings().setTextZoom(100);
    }
}
