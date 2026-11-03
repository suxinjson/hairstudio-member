package com.hairstudio.memberapp;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.content.res.Configuration;
import android.os.Build;
import android.view.View;
import android.view.WindowManager;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.lifecycle.Lifecycle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class FontScalingTest {
    @Test
    public void startupAndRecreationKeepAppFontSizes() {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(this::assertAppFontSizes);
            scenario.recreate();
            scenario.onActivity(this::assertAppFontSizes);
        }
    }

    @Test
    public void fontConfigurationChangeResetsZoomAndPreservesDeviceConfiguration() {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity -> {
                Configuration incoming = new Configuration(activity.getResources().getConfiguration());
                incoming.fontScale = 2.0f;
                activity.getBridge().getWebView().getSettings().setTextZoom(200);

                activity.onConfigurationChanged(incoming);

                assertAppFontSizes(activity);
                Configuration actual = activity.getResources().getConfiguration();
                assertEquals(incoming.densityDpi, actual.densityDpi);
                assertEquals(incoming.orientation, actual.orientation);
                assertEquals(incoming.getLocales(), actual.getLocales());
                assertEquals(2.0f, incoming.fontScale, 0.0f);
            });
        }
    }

    @Test
    public void returningToAppResetsSystemWebViewTextZoom() {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.moveToState(Lifecycle.State.CREATED);
            scenario.onActivity(activity -> activity.getBridge().getWebView().getSettings().setTextZoom(250));
            scenario.moveToState(Lifecycle.State.RESUMED);
            scenario.onActivity(this::assertAppFontSizes);
        }
    }

    @Test
    public void regainingFocusRestoresReadableSystemBars() {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity -> {
                WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(activity.getWindow(), activity.getWindow().getDecorView());
                controller.setAppearanceLightStatusBars(false);
                controller.setAppearanceLightNavigationBars(false);
                activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
                activity.onWindowFocusChanged(true);
                assertReadableSystemBars(activity);
            });
        }
    }

    @Test
    public void webViewportStaysInsideSystemBars() {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            InstrumentationRegistry.getInstrumentation().waitForIdleSync();
            scenario.onActivity(activity -> {
                View decor = activity.getWindow().getDecorView();
                WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(decor);
                assertNotNull(insets);
                Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
                View webView = activity.getBridge().getWebView();
                int[] location = new int[2];
                webView.getLocationInWindow(location);
                assertTrue(webView.getHeight() > 0);
                assertTrue(location[0] >= bars.left);
                assertTrue(location[1] >= bars.top);
                assertTrue(location[0] + webView.getWidth() <= decor.getWidth() - bars.right);
                assertTrue(location[1] + webView.getHeight() <= decor.getHeight() - bars.bottom);
            });
        }
    }

    private void assertAppFontSizes(MainActivity activity) {
        assertEquals(1.0f, activity.getResources().getConfiguration().fontScale, 0.0f);
        assertNotNull(activity.getBridge());
        assertEquals(100, activity.getBridge().getWebView().getSettings().getTextZoom());
        assertReadableSystemBars(activity);
    }

    private void assertReadableSystemBars(MainActivity activity) {
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(activity.getWindow(), activity.getWindow().getDecorView());
        assertTrue(controller.isAppearanceLightStatusBars());
        if (Build.VERSION.SDK_INT >= 26) assertTrue(controller.isAppearanceLightNavigationBars());
        assertEquals(0, activity.getWindow().getAttributes().flags & WindowManager.LayoutParams.FLAG_FULLSCREEN);
    }
}
