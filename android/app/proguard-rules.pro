# ── Retrofit + Gson ─────────────────────────────────────────────────────────
-keepattributes Signature
-keepattributes *Annotation*
-keep class retrofit2.** { *; }
-keepclasseswithmembers class * {
    @retrofit2.http.* <methods>;
}
-keep class com.google.gson.** { *; }
-keep class * implements com.google.gson.TypeAdapterFactory
-keep class * implements com.google.gson.JsonSerializer
-keep class * implements com.google.gson.JsonDeserializer
# Conserver les data classes Kotlin sérialisées par Gson
-keep class com.silexperience.velohnav.data.** { *; }
-keep class com.silexperience.velohnav.ar.Navigation* { *; }

# ── ARCore ────────────────────────────────────────────────────────────────────
-keep class com.google.ar.** { *; }
-dontwarn com.google.ar.**

# ── SceneView ─────────────────────────────────────────────────────────────────
-keep class io.github.sceneview.** { *; }
-dontwarn io.github.sceneview.**

# ── OkHttp ────────────────────────────────────────────────────────────────────
-dontwarn okhttp3.**
-dontwarn okio.**
-keep class okhttp3.** { *; }
-keep interface okhttp3.** { *; }

# ── Capacitor ─────────────────────────────────────────────────────────────────
-keep class com.getcapacitor.** { *; }
-keep @com.getcapacitor.annotation.CapacitorPlugin class * { *; }
-keepclassmembers class * {
    @com.getcapacitor.PluginMethod *;
}

# ── Kotlin coroutines ─────────────────────────────────────────────────────────
-keepnames class kotlinx.coroutines.internal.MainDispatcherFactory {}
-keepnames class kotlinx.coroutines.CoroutineExceptionHandler {}
-dontwarn kotlinx.coroutines.**
