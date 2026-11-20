-keep class org.mozilla.javascript.** { *; }
-keep class org.mozilla.classfile.ClassFileWriter
-dontwarn org.mozilla.javascript.tools.**
-dontwarn org.schabi.newpipe.**
-keep class org.schabi.newpipe.** { *; }
-keep class com.hualee.lame.** { *; }
-keep class fi.iki.elonen.** { *; }
-keep class androidx.media3.** { *; }
-dontwarn androidx.media3.**
-keepclassmembers class com.sunify.mobile.MainActivity$SunifyAndroidBridge {
    @android.webkit.JavascriptInterface <methods>;
}
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
