package com.silexperience.velohnav.ar

import android.util.Log
import com.google.ar.core.Anchor
import com.google.ar.core.Earth
import com.google.ar.core.Frame
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlin.math.*

data class VpsAccuracy(
    val horizontalMeters: Double,
    val headingDegrees: Double,
    val isReliable: Boolean
) { val label get() = "±${"%.1f".format(horizontalMeters)}m" }

data class TerrainAnchorData(
    val stepIndex: Int,
    val latitude: Double,
    val longitude: Double,
    val bearingDegrees: Float,
    val anchor: Anchor? = null
)

/**
 * État Earth ARCore — utilisé pour diagnostiquer pourquoi VPS ne converge pas.
 * Mappe sur com.google.ar.core.Earth.EarthState avec un message user-friendly.
 */
data class EarthDiagnostic(
    val state: Earth.EarthState,
    val isTracking: Boolean,
    val message: String
)

class GeospatialManager {
    private val TAG = "GeospatialManager"
    private val _accuracy = MutableStateFlow<VpsAccuracy?>(null)
    val accuracy: StateFlow<VpsAccuracy?> = _accuracy

    // Diagnostic Earth — pour identifier les blocages VPS (clé API manquante, etc.)
    private val _diagnostic = MutableStateFlow<EarthDiagnostic?>(null)
    val diagnostic: StateFlow<EarthDiagnostic?> = _diagnostic

    // Compteurs pour debug — combien de frames reçus, combien avec accuracy valide
    private var frameCount = 0
    private var accuracyOkCount = 0

    // Appelé depuis le main thread (via mainHandler.post dans Activity)
    fun onFrame(earth: Earth, frame: Frame) {
        frameCount++
        try {
            val earthState = earth.earthState
            val isTracking = earth.trackingState == com.google.ar.core.TrackingState.TRACKING

            // Diagnostic — toujours mettre à jour, même si on ne peut pas lire le pose
            _diagnostic.value = EarthDiagnostic(
                state = earthState,
                isTracking = isTracking,
                message = when (earthState) {
                    Earth.EarthState.ENABLED ->
                        if (isTracking) "Tracking actif" else "En attente de tracking"
                    Earth.EarthState.ERROR_INTERNAL ->
                        "Erreur interne ARCore — redémarrer l'app"
                    Earth.EarthState.ERROR_NOT_AUTHORIZED ->
                        "Clé API ARCore non autorisée — bascule en mode GPS. " +
                        "Pour activer ARCore Geospatial : Google Cloud Console → " +
                        "API ARCore activée + restriction Android (package + SHA-1)"
                    Earth.EarthState.ERROR_RESOURCE_EXHAUSTED ->
                        "Quota Geospatial dépassé — patienter ou augmenter quota GCP"
                    Earth.EarthState.ERROR_GEOSPATIAL_MODE_DISABLED ->
                        "Geospatial désactivé dans la session"
                    Earth.EarthState.ERROR_APK_VERSION_TOO_OLD ->
                        "ARCore obsolète — mettre à jour Google Play Services for AR"
                    else -> "État Earth inconnu : $earthState"
                }
            )

            // Si pas tracking ou pas enabled, pas la peine d'essayer de lire le pose
            if (!isTracking || earthState != Earth.EarthState.ENABLED) {
                if (frameCount % 60 == 0) {
                    Log.w(TAG, "Earth state=$earthState tracking=$isTracking " +
                              "frames=$frameCount accuracyOk=$accuracyOkCount")
                }
                return
            }

            val p = earth.cameraGeospatialPose
            accuracyOkCount++
            _accuracy.value = VpsAccuracy(
                p.horizontalAccuracy,
                p.headingAccuracy,
                p.horizontalAccuracy < 5.0 && p.headingAccuracy < 15.0
            )
            if (frameCount % 60 == 0) {
                Log.d(TAG, "VPS pose: horiz=±${p.horizontalAccuracy}m head=±${p.headingAccuracy}° " +
                          "lat=${p.latitude} lng=${p.longitude}")
            }
        } catch (e: Exception) {
            Log.w(TAG, "onFrame error (frame=$frameCount): ${e.message}", e)
        }
    }

    // Appelé depuis le main thread — resolveAnchorOnTerrain est thread-safe
    @Suppress("DEPRECATION")
    fun placeArrowAnchor(earth: Earth, data: TerrainAnchorData): TerrainAnchorData {
        val rad  = Math.toRadians(data.bearingDegrees.toDouble())
        val half = rad / 2.0
        return try {
            val anchor = earth.resolveAnchorOnTerrain(
                data.latitude, data.longitude, 1.5, // 1.5m : meilleure visibilité, évite z-fighting
                0f, sin(half).toFloat(), 0f, cos(half).toFloat()
            )
            Log.d(TAG, "Anchor OK step=${data.stepIndex} bearing=${data.bearingDegrees}°")
            data.copy(anchor = anchor)
        } catch (e: Exception) {
            Log.e(TAG, "placeArrowAnchor step=${data.stepIndex}: ${e.message}")
            data
        }
    }

    fun cleanup() {
        _accuracy.value = null
        _diagnostic.value = null
        frameCount = 0
        accuracyOkCount = 0
    }

    companion object {
        fun computeBearing(fromLat: Double, fromLng: Double, toLat: Double, toLng: Double): Float {
            val la1 = Math.toRadians(fromLat); val la2 = Math.toRadians(toLat)
            val dL  = Math.toRadians(toLng - fromLng)
            val y   = sin(dL) * cos(la2)
            val x   = cos(la1) * sin(la2) - sin(la1) * cos(la2) * cos(dL)
            return ((Math.toDegrees(atan2(y, x)) + 360) % 360).toFloat()
        }

        fun distanceMeters(lat1: Double, lng1: Double, lat2: Double, lng2: Double): Double {
            val R  = 6_371_000.0
            val p1 = Math.toRadians(lat1); val p2 = Math.toRadians(lat2)
            val dp = Math.toRadians(lat2 - lat1); val dl = Math.toRadians(lng2 - lng1)
            val a  = sin(dp / 2).pow(2) + cos(p1) * cos(p2) * sin(dl / 2).pow(2)
            return R * 2 * atan2(sqrt(a), sqrt(1 - a))
        }
    }
}
