package com.silexperience.velohnav.ar

import android.util.Log
import com.google.gson.Gson
import com.silexperience.velohnav.data.DirectionsApiService
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import java.util.concurrent.TimeUnit

data class NavigationStep(
    val index: Int,
    val startLat: Double, 
    val startLng: Double,
    val endLat: Double, 
    val endLng: Double,
    val distanceMeters: Int, 
    val durationSeconds: Int,
    val instruction: String, 
    val maneuver: String?, 
    val streetName: String
)

data class NavigationRoute(
    val steps: List<NavigationStep>,
    val totalDistanceMeters: Int,
    val totalDurationSeconds: Int
)

class RouteManager(private val mapsApiKey: String) {
    private val TAG = "RouteManager"
    
    companion object {
        val httpClient by lazy {
            OkHttpClient.Builder()
                .addInterceptor(HttpLoggingInterceptor().apply { level = HttpLoggingInterceptor.Level.BASIC })
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(20, TimeUnit.SECONDS)
                .retryOnConnectionFailure(true)
                .build()
        }
        val gson = Gson()
    }

    suspend fun fetchRoute(
        oLat: Double, 
        oLng: Double,
        dLat: Double, 
        dLng: Double,
        mode: String = "bicycling"
    ): Result<NavigationRoute> {
        
        val osrmResult = fetchOSRM(oLat, oLng, dLat, dLng, mode)
        if (osrmResult.isSuccess) return osrmResult
        
        Log.w(TAG, "OSRM failed, trying Google")

        if (mapsApiKey.isBlank() || mapsApiKey == "null" || mapsApiKey.length < 10) {
            return Result.failure(Exception("OSRM indisponible. Configurez une clé Google Maps dans OPT."))
        }

        return fetchGoogle(oLat, oLng, dLat, dLng, mode)
    }

    private suspend fun fetchOSRM(
        oLat: Double, 
        oLng: Double,
        dLat: Double, 
        dLng: Double,
        mode: String
    ): Result<NavigationRoute> {
        return try {
            val profile = when (mode) {
                "walking" -> "foot"
                "driving" -> "car"
                else -> "bike"
            }
            
            val url = "https://router.project-osrm.org/route/v1/$profile/$oLng,$oLat;$dLng,$dLat?overview=false&steps=true"
            val request = okhttp3.Request.Builder()
                .url(url)
                .header("User-Agent", "VelohNav/1.0")
                .build()
                
            val response = httpClient.newCall(request).execute()
            
            if (!response.isSuccessful) {
                return Result.failure(Exception("OSRM HTTP ${response.code}"))
            }
            
            val body = response.body?.string() ?: return Result.failure(Exception("Empty"))
            val result = gson.fromJson(body, OsrmResponse::class.java)
            
            if (result.code != "Ok") {
                return Result.failure(Exception("OSRM: ${result.code}"))
            }

            val leg = result.routes.first().legs.first()
            val steps = leg.steps.mapIndexed { i, step ->
                NavigationStep(
                    index = i,
                    startLat = step.maneuver.location[1],
                    startLng = step.maneuver.location[0],
                    endLat = step.maneuver.location[1],
                    endLng = step.maneuver.location[0],
                    distanceMeters = step.distance.toInt(),
                    durationSeconds = step.duration.toInt(),
                    instruction = step.name.ifEmpty { step.maneuver.type },
                    maneuver = step.maneuver.modifier,
                    streetName = step.name
                )
            }
            
            Result.success(NavigationRoute(steps, leg.distance.toInt(), leg.duration.toInt()))
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    private suspend fun fetchGoogle(
        oLat: Double, 
        oLng: Double,
        dLat: Double, 
        dLng: Double,
        mode: String
    ): Result<NavigationRoute> {
        return try {
            val retrofit = Retrofit.Builder()
                .baseUrl("https://maps.googleapis.com/maps/api/")
                .client(httpClient)
                .addConverterFactory(GsonConverterFactory.create())
                .build()
                
            val service = retrofit.create(DirectionsApiService::class.java)
            val gMode = when (mode) {
                "walking" -> "walking"
                "driving" -> "driving"
                else -> "bicycling"
            }
            
            val resp = service.getDirections(
                origin = "$oLat,$oLng",
                destination = "$dLat,$dLng",
                mode = gMode,
                language = "fr",
                apiKey = mapsApiKey
            )
            
            if (resp.status != "OK") {
                val msg = when(resp.status) {
                    "REQUEST_DENIED" -> "Clé Google invalide. Vérifiez Directions API activée et billing configuré."
                    "ZERO_RESULTS" -> "Aucun itinéraire trouvé."
                    else -> "API: ${resp.status}"
                }
                return Result.failure(Exception(msg))
            }
            
            val leg = resp.routes.first().legs.first()
            val steps = leg.steps.mapIndexed { i, s ->
                NavigationStep(
                    i,
                    s.startLocation.lat, 
                    s.startLocation.lng,
                    s.endLocation.lat, 
                    s.endLocation.lng,
                    s.distance.value, 
                    s.duration.value,
                    s.htmlInstructions.replace(Regex("<[^>]+>"), ""),
                    s.maneuver,
                    ""
                )
            }
            Result.success(NavigationRoute(steps, leg.distance.value, leg.duration.value))
        } catch (e: Exception) {
            Result.failure(Exception("Erreur Google: ${e.message}"))
        }
    }
    
    // Classes internes pour Gson
    data class OsrmResponse(val code: String, val routes: List<OsrmRoute>)
    data class OsrmRoute(val legs: List<OsrmLeg>)
    data class OsrmLeg(val steps: List<OsrmStep>, val distance: Double, val duration: Double)
    data class OsrmStep(val distance: Double, val duration: Double, val name: String, val maneuver: OsrmManeuver)
    data class OsrmManeuver(val location: List<Double>, val type: String, val modifier: String?)
}
