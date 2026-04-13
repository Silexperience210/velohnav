package com.silexperience.velohnav.ar

import android.util.Log
import com.silexperience.velohnav.data.DirectionsApiService
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import java.util.concurrent.TimeUnit

data class NavigationStep(
    val index: Int,
    val startLat: Double, val startLng: Double,
    val endLat: Double,   val endLng: Double,
    val distanceMeters: Int, val durationSeconds: Int,
    val instruction: String, val maneuver: String?, val streetName: String
)
data class NavigationRoute(
    val steps: List<NavigationStep>,
    val totalDistanceMeters: Int,
    val totalDurationSeconds: Int
)

class RouteManager(private val apiKey: String) {
    private val TAG = "RouteManager"
    private val api: DirectionsApiService by lazy {
        Retrofit.Builder()
            .baseUrl("https://maps.googleapis.com/maps/api/")
            .client(OkHttpClient.Builder()
                .addInterceptor(HttpLoggingInterceptor().apply { level = HttpLoggingInterceptor.Level.BASIC })
                .connectTimeout(10, TimeUnit.SECONDS).readTimeout(10, TimeUnit.SECONDS).build())
            .addConverterFactory(GsonConverterFactory.create()).build()
            .create(DirectionsApiService::class.java)
    }

    suspend fun fetchRoute(oLat: Double, oLng: Double, dLat: Double, dLng: Double, mode: String = "bicycling"): Result<NavigationRoute> {
        return try {
            val resp = api.getDirections("$oLat,$oLng", "$dLat,$dLng", mode, "fr", apiKey)
            if (resp.status != "OK") return Result.failure(Exception("Directions API: ${resp.status}"))
            val leg = resp.routes.first().legs.first()
            Result.success(NavigationRoute(
                steps = leg.steps.mapIndexed { i, s -> NavigationStep(i,
                    s.startLocation.lat, s.startLocation.lng,
                    s.endLocation.lat, s.endLocation.lng,
                    s.distance.value, s.duration.value,
                    s.htmlInstructions.replace(Regex("<[^>]+>"),"").replace("&nbsp;"," ").trim(),
                    s.maneuver,
                    Regex("<b>(.*?)</b>").find(s.htmlInstructions)?.groupValues?.get(1)?.replace(Regex("<[^>]+>"),"")?.trim() ?: ""
                )},
                totalDistanceMeters = leg.distance.value,
                totalDurationSeconds = leg.duration.value
            ))
        } catch (e: Exception) { Log.e(TAG, "fetchRoute", e); Result.failure(e) }
    }

    companion object {
        fun formatDistance(m: Int) = if (m < 1000) "${m} m" else "${"%.1f".format(m/1000.0)} km"
        fun formatDuration(s: Int) = if (s/60 < 60) "${s/60} min" else "${s/3600}h${(s%3600)/60}min"
    }
}
