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

class RouteManager(private val mapsApiKey: String) {
    private val TAG = "RouteManager"

    private val httpClient by lazy {
        OkHttpClient.Builder()
            .addInterceptor(HttpLoggingInterceptor().apply { level = HttpLoggingInterceptor.Level.BASIC })
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            .build()
    }

    private val googleApi: DirectionsApiService by lazy {
        Retrofit.Builder()
            .baseUrl("https://maps.googleapis.com/maps/api/")
            .client(httpClient)
            .addConverterFactory(GsonConverterFactory.create())
            .build()
            .create(DirectionsApiService::class.java)
    }

    /**
     * Récupère un itinéraire.
     * Stratégie : OSRM (gratuit, pas de clé) en premier.
     * Fallback Google Directions uniquement si clé disponible ET OSRM échoue.
     */
    suspend fun fetchRoute(
        oLat: Double, oLng: Double,
        dLat: Double, dLng: Double,
        mode: String = "bicycling"
    ): Result<NavigationRoute> {
        // 1. Essai OSRM — gratuit, pas de clé requise, bonne couverture Luxembourg
        val osrmResult = fetchOSRM(oLat, oLng, dLat, dLng, mode)
        if (osrmResult.isSuccess) return osrmResult

        Log.w(TAG, "OSRM indisponible (${osrmResult.exceptionOrNull()?.message}), essai Google Directions")

        // 2. Fallback Google Directions — uniquement si clé configurée
        if (mapsApiKey.isBlank()) {
            return Result.failure(Exception("Itinéraire indisponible (OSRM hors ligne, clé Google Maps non configurée)"))
        }
        return fetchGoogle(oLat, oLng, dLat, dLng, mode)
    }

    // ── OSRM (router.project-osrm.org) ───────────────────────────────
    private suspend fun fetchOSRM(
        oLat: Double, oLng: Double,
        dLat: Double, dLng: Double,
        mode: String
    ): Result<NavigationRoute> {
        val profile = when (mode) { "walking" -> "foot"; "driving" -> "car"; else -> "cycling" }
        val url = "https://router.project-osrm.org/route/v1/$profile/" +
                  "$oLng,$oLat;$dLng,$dLat?overview=false&steps=true"
        return try {
            val resp = httpClient.newCall(
                okhttp3.Request.Builder().url(url).build()
            ).execute()
            if (!resp.isSuccessful) return Result.failure(Exception("OSRM HTTP ${resp.code}"))
            val body = resp.body?.string() ?: return Result.failure(Exception("OSRM empty body"))
            val json = org.json.JSONObject(body)
            if (json.getString("code") != "Ok")
                return Result.failure(Exception("OSRM: ${json.getString("code")}"))

            val leg = json.getJSONArray("routes").getJSONObject(0).getJSONArray("legs").getJSONObject(0)
            val stepsArr = leg.getJSONArray("steps")
            val steps = (0 until stepsArr.length()).map { i ->
                val s = stepsArr.getJSONObject(i)
                val maneuver = s.getJSONObject("maneuver")
                val loc = maneuver.getJSONArray("location")
                NavigationStep(
                    index          = i,
                    startLat       = loc.getDouble(1),
                    startLng       = loc.getDouble(0),
                    endLat         = loc.getDouble(1),
                    endLng         = loc.getDouble(0),
                    distanceMeters = s.getDouble("distance").toInt(),
                    durationSeconds= s.getDouble("duration").toInt(),
                    instruction    = maneuver.getString("type"),
                    maneuver       = maneuver.optString("modifier").ifEmpty { null },
                    streetName     = s.optString("name")
                )
            }
            Result.success(NavigationRoute(
                steps                = steps,
                totalDistanceMeters  = leg.getDouble("distance").toInt(),
                totalDurationSeconds = leg.getDouble("duration").toInt()
            ))
        } catch (e: Exception) {
            Log.w(TAG, "fetchOSRM error", e)
            Result.failure(e)
        }
    }

    // ── Google Directions (fallback) ──────────────────────────────────
    private suspend fun fetchGoogle(
        oLat: Double, oLng: Double,
        dLat: Double, dLng: Double,
        mode: String
    ): Result<NavigationRoute> {
        return try {
            val googleMode = when (mode) { "walking" -> "walking"; "driving" -> "driving"; else -> "bicycling" }
            val resp = googleApi.getDirections("$oLat,$oLng", "$dLat,$dLng", googleMode, "fr", mapsApiKey)
            if (resp.status != "OK")
                return Result.failure(Exception("Directions API: ${resp.status}"))
            val leg = resp.routes.first().legs.first()
            Result.success(NavigationRoute(
                steps = leg.steps.mapIndexed { i, s -> NavigationStep(i,
                    s.startLocation.lat, s.startLocation.lng,
                    s.endLocation.lat,   s.endLocation.lng,
                    s.distance.value, s.duration.value,
                    s.htmlInstructions.replace(Regex("<[^>]+>"), "").replace("&nbsp;", " ").trim(),
                    s.maneuver,
                    Regex("<b>(.*?)</b>").find(s.htmlInstructions)
                        ?.groupValues?.get(1)?.replace(Regex("<[^>]+>"), "")?.trim() ?: ""
                )},
                totalDistanceMeters  = leg.distance.value,
                totalDurationSeconds = leg.duration.value
            ))
        } catch (e: Exception) {
            Log.e(TAG, "fetchGoogle error", e)
            Result.failure(e)
        }
    }

    companion object {
        fun formatDistance(m: Int) = if (m < 1000) "${m} m" else "${"%.1f".format(m / 1000.0)} km"
        fun formatDuration(s: Int) = if (s / 60 < 60) "${s / 60} min" else "${s / 3600}h${(s % 3600) / 60}min"
    }
}
