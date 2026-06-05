package com.silexperience.velohnav.ar

import android.util.Log
import com.google.gson.annotations.SerializedName
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import com.silexperience.velohnav.data.DirectionsApiService
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import java.util.concurrent.TimeUnit

data class NavigationStep(
    val index: Int,
    val startLat: Double, val startLng: Double,
    val endLat: Double, val endLng: Double,
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
    
    companion object {
        /** "120m" ou "1.2km" */
        fun formatDistance(meters: Int): String =
            if (meters < 1000) "${meters}m" else "${"%.1f".format(meters / 1000.0)}km"

        /** "2 min" ou "1h 05" */
        fun formatDuration(seconds: Int): String {
            val m = seconds / 60
            return if (m < 60) "$m min" else "${m / 60}h ${"%02d".format(m % 60)}"
        }

        val httpClient by lazy {
            OkHttpClient.Builder()
                .addInterceptor(HttpLoggingInterceptor().apply { level = HttpLoggingInterceptor.Level.BASIC })
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(20, TimeUnit.SECONDS)
                .retryOnConnectionFailure(true)
                .build()
        }
    }

    suspend fun fetchRoute(
        oLat: Double, oLng: Double,
        dLat: Double, dLng: Double,
        mode: String = "bicycling"
    ): Result<NavigationRoute> {
        
        // Primaire : BRouter (vrais profils vélo/piéton). Le serveur OSRM public
        // ne route qu'en voiture quel que soit le profil → fallback de dépannage.
        val brouterResult = fetchBRouter(oLat, oLng, dLat, dLng, mode)
        if (brouterResult.isSuccess) return brouterResult
        Log.w(TAG, "BRouter failed: ${brouterResult.exceptionOrNull()?.message}")

        val osrmResult = fetchOSRM(oLat, oLng, dLat, dLng, mode)
        if (osrmResult.isSuccess) return osrmResult

        Log.w(TAG, "OSRM failed: ${osrmResult.exceptionOrNull()?.message}")

        if (mapsApiKey.isBlank() || mapsApiKey == "null" || mapsApiKey.length < 10) {
            return Result.failure(Exception("Itinéraire indisponible (BRouter + OSRM HS). Configurez une clé Google Maps dans OPT."))
        }

        return fetchGoogle(oLat, oLng, dLat, dLng, mode)
    }

    // ── BRouter (vélo réel, gratuit, sans clé) ──────────────────────
    private suspend fun fetchBRouter(
        oLat: Double, oLng: Double,
        dLat: Double, dLng: Double,
        mode: String
    ): Result<NavigationRoute> {
        val profile = when (mode) {
            "walking" -> "hiking-beta"
            "driving" -> "car-fast"
            else -> "trekking"
        }
        return try {
            // %7C = '|' encodé (séparateur de waypoints BRouter). timode=2 → voicehints.
            val lonlats = "$oLng,$oLat%7C$dLng,$dLat"
            val url = "https://brouter.de/brouter?lonlats=$lonlats&profile=$profile" +
                "&alternativeidx=0&format=geojson&timode=2"
            val request = okhttp3.Request.Builder()
                .url(url)
                .header("User-Agent", "VelohNav/1.0")
                .build()
            val response = withContext(Dispatchers.IO) { httpClient.newCall(request).execute() }
            if (!response.isSuccessful) return Result.failure(Exception("BRouter HTTP ${response.code}"))
            val body = response.body?.string() ?: return Result.failure(Exception("BRouter: réponse vide"))
            val gson = com.google.gson.Gson()
            val res = gson.fromJson(body, BrouterResponse::class.java)
            val feature = res.features.firstOrNull()
                ?: return Result.failure(Exception("BRouter: aucune feature"))
            val coords = feature.geometry.coordinates
            if (coords.isEmpty()) return Result.failure(Exception("BRouter: géométrie vide"))
            val props = feature.properties
            val totalDist = props.trackLength?.toIntOrNull() ?: 0
            val totalTime = props.totalTime?.toIntOrNull() ?: 0
            val steps = buildBrouterSteps(coords, props.voicehints ?: emptyList(), totalDist, totalTime)
            if (steps.isEmpty()) return Result.failure(Exception("BRouter: aucune étape"))
            Result.success(NavigationRoute(steps, totalDist, totalTime))
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    // Construit les étapes de nav depuis la géométrie + les voicehints BRouter.
    // Chaque voicehint pointe un index de la polyline ([lng,lat,elev]) = point de
    // virage. On segmente la route entre points de virage successifs.
    private fun buildBrouterSteps(
        coords: List<List<Double>>,
        hints: List<List<Double>>,
        totalDist: Int,
        totalTime: Int
    ): List<NavigationStep> {
        fun lat(i: Int) = coords[i.coerceIn(0, coords.size - 1)][1]
        fun lng(i: Int) = coords[i.coerceIn(0, coords.size - 1)][0]

        // Indices des points de virage (depuis les voicehints) + destination finale.
        val turns = hints.map { h ->
            val idx = (h.getOrNull(0) ?: 0.0).toInt().coerceIn(0, coords.size - 1)
            val angle = h.getOrNull(4) ?: 0.0
            Pair(idx, angle)
        }.toMutableList()
        if (turns.isEmpty() || turns.last().first < coords.size - 1) {
            turns.add(Pair(coords.size - 1, 0.0))
        }

        val steps = mutableListOf<NavigationStep>()
        var prevIdx = 0
        for ((i, turn) in turns.withIndex()) {
            val (endIdx, angle) = turn
            var d = 0.0
            var j = prevIdx
            while (j < endIdx) {
                d += GeospatialManager.distanceMeters(lat(j), lng(j), lat(j + 1), lng(j + 1))
                j++
            }
            val frac = if (totalDist > 0) d / totalDist else 0.0
            val man = angleToManeuver(angle)
            steps.add(
                NavigationStep(
                    index = i,
                    startLat = lat(prevIdx), startLng = lng(prevIdx),
                    endLat = lat(endIdx), endLng = lng(endIdx),
                    distanceMeters = d.toInt(),
                    durationSeconds = (totalTime * frac).toInt(),
                    instruction = man, maneuver = man, streetName = ""
                )
            )
            prevIdx = endIdx
        }
        return steps
    }

    // Angle de virage BRouter → modifier (négatif = gauche, positif = droite).
    private fun angleToManeuver(angle: Double): String {
        val abs = kotlin.math.abs(angle)
        if (abs < 18) return "straight"
        val side = if (angle < 0) "left" else "right"
        return when {
            abs >= 160 -> "uturn"
            abs >= 110 -> "sharp $side"
            abs < 40 -> "slight $side"
            else -> side
        }
    }

    private suspend fun fetchOSRM(
        oLat: Double, oLng: Double,
        dLat: Double, dLng: Double,
        mode: String
    ): Result<NavigationRoute> {
        val profile = when (mode) {
            "walking" -> "foot"
            "driving" -> "car"
            else -> "bicycle"
        }
        
        return try {
            val url = "https://router.project-osrm.org/route/v1/$profile/$oLng,$oLat;$dLng,$dLat?overview=false&steps=true"
            val request = okhttp3.Request.Builder()
                .url(url)
                .header("User-Agent", "VelohNav/1.0")
                .build()
            val response = withContext(Dispatchers.IO) { httpClient.newCall(request).execute() }
            
            if (!response.isSuccessful) return Result.failure(Exception("OSRM HTTP ${response.code}"))
            
            val body = response.body?.string() ?: return Result.failure(Exception("Empty"))
            val gson = com.google.gson.Gson()
            val result = gson.fromJson(body, OsrmResponse::class.java)
            
            if (result.code != "Ok") return Result.failure(Exception("OSRM: ${result.code}"))

            // Guard : vérifier que la réponse a bien des routes/legs avant .first()
            if (result.routes.isEmpty()) return Result.failure(Exception("OSRM: aucune route"))
            val route = result.routes.first()
            if (route.legs.isEmpty()) return Result.failure(Exception("OSRM: aucun leg"))
            val leg = route.legs.first()
            val rawSteps = leg.steps
            val steps = rawSteps.mapIndexed { i, step ->
                // OSRM : maneuver.location = début du step (point de virage entrant).
                // Pour endLat/endLng, on prend le début du step suivant si disponible,
                // sinon on utilise la destination finale (dLat, dLng).
                val nextStep = rawSteps.getOrNull(i + 1)
                val (eLat, eLng) = if (nextStep != null)
                    Pair(nextStep.maneuver.location[1], nextStep.maneuver.location[0])
                else
                    Pair(dLat, dLng)
                NavigationStep(
                    index = i,
                    startLat = step.maneuver.location[1],
                    startLng = step.maneuver.location[0],
                    endLat = eLat,
                    endLng = eLng,
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
        oLat: Double, oLng: Double,
        dLat: Double, dLng: Double,
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
            
            val resp = service.getDirections("$oLat,$oLng", "$dLat,$dLng", gMode, "fr", mapsApiKey)
            
            if (resp.status != "OK") {
                val msg = when(resp.status) {
                    "REQUEST_DENIED" -> "Clé Google invalide. Vérifiez: 1) Directions API activée 2) Billing configuré 3) Clé correcte dans OPT."
                    "ZERO_RESULTS" -> "Aucun itinéraire trouvé."
                    else -> "API: ${resp.status}"
                }
                return Result.failure(Exception(msg))
            }
            
            val leg = resp.routes.first().legs.first()
            Result.success(NavigationRoute(
                steps = leg.steps.mapIndexed { i, s -> 
                    NavigationStep(
                        i, s.startLocation.lat, s.startLocation.lng,
                        s.endLocation.lat, s.endLocation.lng,
                        s.distance.value, s.duration.value,
                        s.htmlInstructions.replace(Regex("<[^>]+>"), ""),
                        s.maneuver, ""
                    )
                },
                totalDistanceMeters = leg.distance.value,
                totalDurationSeconds = leg.duration.value
            ))
        } catch (e: Exception) {
            Result.failure(Exception("Erreur: ${e.message}"))
        }
    }
    
    data class OsrmResponse(val code: String, val routes: List<OsrmRoute>)
    data class OsrmRoute(val legs: List<OsrmLeg>)
    data class OsrmLeg(val steps: List<OsrmStep>, val distance: Double, val duration: Double)
    data class OsrmStep(val distance: Double, val duration: Double, val name: String, val maneuver: OsrmManeuver)
    data class OsrmManeuver(val location: List<Double>, val type: String, val modifier: String?)

    // ── BRouter GeoJSON ─────────────────────────────────────────────
    data class BrouterResponse(val features: List<BrouterFeature> = emptyList())
    data class BrouterFeature(val geometry: BrouterGeometry, val properties: BrouterProps)
    data class BrouterGeometry(val coordinates: List<List<Double>> = emptyList()) // [lng,lat,elev]
    data class BrouterProps(
        @SerializedName("track-length") val trackLength: String? = null,
        @SerializedName("total-time") val totalTime: String? = null,
        val voicehints: List<List<Double>>? = null // [pointIndex, command, exit, distance, angle]
    )
}
