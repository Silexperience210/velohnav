package com.silexperience.velohnav.ar

import android.util.Log
import com.silexperience.velohnav.data.DirectionsApiService
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import java.util.concurrent.TimeUnit

data class NavigationStep(val index: Int, val startLat: Double, val startLng: Double, val endLat: Double, val endLng: Double, val distanceMeters: Int, val durationSeconds: Int, val instruction: String, val maneuver: String?, val streetName: String)
data class NavigationRoute(val steps: List<NavigationStep>, val totalDistanceMeters: Int, val totalDurationSeconds: Int)

class RouteManager(private val mapsApiKey: String) {
    private val TAG = "RouteManager"
    companion object {
        private val httpClient by lazy {
            OkHttpClient.Builder()
                .addInterceptor(HttpLoggingInterceptor().apply { level = HttpLoggingInterceptor.Level.BASIC })
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(20, TimeUnit.SECONDS)
                .retryOnConnectionFailure(true)
                .build()
        }
    }

    suspend fun fetchRoute(oLat: Double, oLng: Double, dLat: Double, dLng: Double, mode: String = "bicycling"): Result<NavigationRoute> {
        val osrmResult = fetchOSRM(oLat, oLng, dLat, dLng, mode)
        if (osrmResult.isSuccess) return osrmResult
        Log.w(TAG, "OSRM failed: ${osrmResult.exceptionOrNull()?.message}")
        if (mapsApiKey.isBlank() || mapsApiKey.length < 10) {
            return Result.failure(Exception("OSRM hors ligne. Configurez une clé Google Maps dans OPT."))
        }
        return fetchGoogle(oLat, oLng, dLat, dLng, mode)
    }

    private suspend fun fetchOSRM(oLat: Double, oLng: Double, dLat: Double, dLng: Double, mode: String): Result<NavigationRoute> {
        val profile = if (mode == "walking") "foot" else "bike"
        return try {
            val url = "https://router.project-osrm.org/route/v1/$profile/$oLng,$oLat;$dLng,$dLat?overview=false&steps=true"
            val request = okhttp3.Request.Builder().url(url).header("User-Agent", "VelohNav/1.0").build()
            val response = httpClient.newCall(request).execute()
            if (!response.isSuccessful) return Result.failure(Exception("OSRM HTTP ${response.code}"))
            val body = response.body?.string() ?: return Result.failure(Exception("Empty"))
            val json = org.json.JSONObject(body)
            if (json.getString("code") != "Ok") return Result.failure(Exception("OSRM: ${json.getString("code")}"))
            val leg = json.getJSONArray("routes").getJSONObject(0).getJSONArray("legs").getJSONObject(0)
            val stepsArr = leg.getJSONArray("steps")
            val steps = (0 until stepsArr.length()).map { i ->
                val s = stepsArr.getJSONObject(i)
                val m = s.getJSONObject("maneuver")
                val loc = m.getJSONArray("location")
                NavigationStep(i, loc.getDouble(1), loc.getDouble(0), loc.getDouble(1), loc.getDouble(0), s.getDouble("distance").toInt(), s.getDouble("duration").toInt(), s.optString("name").ifBlank { m.getString("type") }, m.optString("modifier").ifEmpty { null }, s.optString("name"))
            }
            Result.success(NavigationRoute(steps, leg.getDouble("distance").toInt(), leg.getDouble("duration").toInt()))
        } catch (e: Exception) { Result.failure(e) }
    }

    private suspend fun fetchGoogle(oLat: Double, oLng: Double, dLat: Double, dLng: Double, mode: String): Result<NavigationRoute> {
        return try {
            val retrofit = Retrofit.Builder().baseUrl("https://maps.googleapis.com/maps/api/").client(httpClient).addConverterFactory(GsonConverterFactory.create()).build()
            val service = retrofit.create(DirectionsApiService::class.java)
            val gMode = if (mode == "walking") "walking" else "bicycling"
            val resp = service.getDirections("$oLat,$oLng", "$dLat,$dLng", gMode, "fr", mapsApiKey)
            if (resp.status != "OK") {
                val msg = when(resp.status) {
                    "REQUEST_DENIED" -> "Clé Google invalide. Vérifiez: 1) Directions API activée 2) Billing configuré"
                    else -> "API: ${resp.status}"
                }
                return Result.failure(Exception(msg))
            }
            val leg = resp.routes.first().legs.first()
            Result.success(NavigationRoute(leg.steps.mapIndexed { i, s -> NavigationStep(i, s.startLocation.lat, s.startLocation.lng, s.endLocation.lat, s.endLocation.lng, s.distance.value, s.duration.value, s.htmlInstructions.replace(Regex("<[^>]+>"), ""), s.maneuver, "") }, leg.distance.value, leg.duration.value))
        } catch (e: Exception) { Result.failure(Exception("Erreur: ${e.message}")) }
    }
}
