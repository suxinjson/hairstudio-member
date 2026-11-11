package com.hairstudio.memberapp;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.content.res.Resources;
import android.content.res.TypedArray;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.Drawable;
import android.util.TypedValue;
import android.view.ContextThemeWrapper;
import android.widget.PopupWindow;
import android.widget.TextView;
import androidx.lifecycle.Lifecycle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class NativeThemeTest {
    @Test
    public void launchToRuntimeOverlayClearsViewBackground() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        Resources.Theme theme = context.getResources().newTheme();
        theme.applyStyle(R.style.AppTheme_NoActionBarLaunch, true);
        theme.applyStyle(R.style.AppTheme_NoActionBar, true);
        assertTransparentDefault(theme);
    }

    @Test
    public void activityApplicationAndWebViewUseCleanThemeAcrossLifecycle() {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(this::assertRuntimeTheme);
            scenario.recreate();
            scenario.onActivity(this::assertRuntimeTheme);
            scenario.moveToState(Lifecycle.State.CREATED);
            scenario.moveToState(Lifecycle.State.RESUMED);
            scenario.onActivity(this::assertRuntimeTheme);
        }
    }

    @Test
    public void popupAndActionModeSurfacesHaveTransparentCornersAndNoBitmap() {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity -> {
                PopupWindow popup = new PopupWindow(activity);
                assertCompactSurface(popup.getBackground());
                for (int attribute : new int[] {
                    android.R.attr.popupMenuStyle, android.R.attr.listPopupWindowStyle,
                    androidx.appcompat.R.attr.popupMenuStyle, androidx.appcompat.R.attr.listPopupWindowStyle
                }) {
                    ContextThemeWrapper context = new ContextThemeWrapper(activity, style(activity, attribute));
                    TypedArray attributes = context.obtainStyledAttributes(new int[] { android.R.attr.popupBackground });
                    try { assertCompactSurface(attributes.getDrawable(0)); }
                    finally { attributes.recycle(); }
                }
                TypedArray attributes = activity.obtainStyledAttributes(new int[] {
                    android.R.attr.actionModeBackground, androidx.appcompat.R.attr.actionModeBackground
                });
                try {
                    assertCompactSurface(attributes.getDrawable(0));
                    assertCompactSurface(attributes.getDrawable(1));
                } finally { attributes.recycle(); }
            });
        }
    }

    @Test
    public void platformAndAppCompatDialogsDoNotInheritLaunchArtwork() {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity -> {
                android.app.AlertDialog platform = new android.app.AlertDialog.Builder(activity)
                    .setTitle("系统确认").setMessage("确认内容保持清晰，外层没有白色图片背景。")
                    .setPositiveButton("确认", null).setNegativeButton("取消", null).create();
                try {
                    platform.show();
                    assertTransparentDefault(platform.getContext().getTheme());
                    assertCompactSurface(platform.getWindow().getDecorView().getBackground());
                } finally { platform.dismiss(); }
                androidx.appcompat.app.AlertDialog compat = new androidx.appcompat.app.AlertDialog.Builder(activity)
                    .setTitle("应用确认").setItems(new String[] { "选项一", "选项二" }, null)
                    .setNegativeButton("取消", null).create();
                try {
                    compat.show();
                    assertTransparentDefault(compat.getContext().getTheme());
                    assertCompactSurface(compat.getWindow().getDecorView().getBackground());
                } finally { compat.dismiss(); }
            });
        }
    }

    private void assertRuntimeTheme(MainActivity activity) {
        assertTransparentDefault(activity.getTheme());
        assertTransparentDefault(activity.getApplication().getTheme());
        assertTransparentDefault(activity.getBridge().getWebView().getContext().getTheme());
        // A fresh child View must not pick up the old full-screen splash bitmap.
        Drawable background = new TextView(activity).getBackground();
        assertTrue(background == null || background instanceof ColorDrawable);
        if (background instanceof ColorDrawable) assertEquals(Color.TRANSPARENT, ((ColorDrawable) background).getColor());
    }

    private void assertTransparentDefault(Resources.Theme theme) {
        TypedValue value = new TypedValue();
        assertTrue(theme.resolveAttribute(android.R.attr.background, value, true));
        assertTrue(value.type >= TypedValue.TYPE_FIRST_COLOR_INT && value.type <= TypedValue.TYPE_LAST_COLOR_INT);
        assertEquals(Color.TRANSPARENT, value.data);
    }

    private int style(Context context, int attribute) {
        TypedValue value = new TypedValue();
        assertTrue(context.getTheme().resolveAttribute(attribute, value, true));
        assertTrue(value.resourceId != 0);
        return value.resourceId;
    }

    private void assertCompactSurface(Drawable drawable) {
        assertNotNull(drawable);
        Bitmap bitmap = Bitmap.createBitmap(240, 160, Bitmap.Config.ARGB_8888);
        try {
            drawable.setBounds(0, 0, bitmap.getWidth(), bitmap.getHeight());
            drawable.draw(new Canvas(bitmap));
            assertEquals("The outside corner must be transparent", 0, Color.alpha(bitmap.getPixel(0, 0)));
            int center = bitmap.getPixel(120, 80);
            assertTrue("Menu content must be readable and translucent", Color.alpha(center) > 0 && Color.alpha(center) < 255);
            assertEquals("Use the menu surface, never launch artwork", 0xF8, Color.red(center), 1);
            assertEquals(0xFA, Color.green(center), 1);
            assertEquals(0xF9, Color.blue(center), 1);
        } finally { bitmap.recycle(); }
    }
}
