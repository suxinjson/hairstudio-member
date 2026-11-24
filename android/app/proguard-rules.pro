# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.

# 保留行号与必要属性，便于排查定位异常
-keepattributes SourceFile,LineNumberTable
-keepattributes *Annotation*
-keepattributes JavascriptInterface

# 1. 保护 Capacitor 核心库与插件反射调用机制
-keep public class * extends com.getcapacitor.Plugin {
    public *;
}
-keep public class * extends com.getcapacitor.BridgeActivity {
    public *;
}
-keep @com.getcapacitor.annotation.CapacitorPlugin class * {
    *;
}
-keepclassmembers class * {
    @com.getcapacitor.PluginMethod public *;
}
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# 2. 保护本项目中自定义的原生插件与数据操作类
-keep class com.hairstudio.memberapp.** { *; }
-keepclassmembers class com.hairstudio.memberapp.** { *; }

# 3. 保护 JNI 本地方法与 Bundled SQLite 引擎
-keepclasseswithmembernames class * {
    native <methods>;
}
-keep class androidx.sqlite.driver.bundled.** { *; }
-keepclassmembers class androidx.sqlite.driver.bundled.** { *; }
-keep class androidx.sqlite.SQLiteConnection { *; }
-keep class androidx.sqlite.SQLiteStatement { *; }

# 4. 忽略部分第三方库的无害警告
-dontwarn com.getcapacitor.**
-dontwarn androidx.sqlite.**
