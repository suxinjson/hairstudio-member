package com.hairstudio.memberapp;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;

import android.content.res.Configuration;
import androidx.lifecycle.Lifecycle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
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

    private void assertAppFontSizes(MainActivity activity) {
        assertEquals(1.0f, activity.getResources().getConfiguration().fontScale, 0.0f);
        assertNotNull(activity.getBridge());
        assertEquals(100, activity.getBridge().getWebView().getSettings().getTextZoom());
    }
}
