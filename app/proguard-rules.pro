-keep class org.mozilla.javascript.** { *; }
-keep class org.mozilla.classfile.ClassFileWriter
-dontwarn org.mozilla.javascript.tools.**
-keepclassmembers class com.sunify.mobile.MainActivity$SunifyAndroidBridge {
    @android.webkit.JavascriptInterface <methods>;
}
