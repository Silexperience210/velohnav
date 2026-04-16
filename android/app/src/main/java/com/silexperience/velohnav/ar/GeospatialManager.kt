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

class GeospatialManager {
    private val TAG = "GeospatialManager"
    private val _accuracy = MutableStateFlow<VpsAccuracy?>(null)
    val accuracy: StateFlow<VpsAccuracy?> = _accuracy

    fun onFrame(earth: Earth, frame: Frame) {
        val p = earth.cameraGeospatialPose
        _accuracy.value = VpsAccuracy(
            horizontalMeters = p.horizontalAccuracy,
            headingDegrees   = p.headingAccuracy,
            isReliable       = p.horizontalAccuracy < 5.0 && p.headingAccuracy < 15.0
        )
    }

    /**
     * Place une ancre de navigation sur la géométrie terrain.
     *
     * Migration ARCore 1.40+ :
     *   - Ancien (déprécié)  : earth.resolveAnchorOnTerrain(lat, lng, alt, qx, qy, qz, qw)
     *   - Nouveau (1.40+)    : earth.createAnchor(pose) avec AltitudeMode.RELATIVE_TO_TERRAIN
     *
     * Le quaternion Y-axis encode le bearing (cap) de la flèche de navigation.
     * Formule : angle = bearing_rad / 2  →  quat = (0, sin(angle), 0, cos(angle))
     */
    fun placeArrowAnchor(earth: Earth, data: TerrainAnchorData): TerrainAnchorData {
        val bearingRad = Math.toRadians(data.bearingDegrees.toDouble())
        val half = bearingRad / 2.0
        val qx = 0f
        val qy = sin(half).toFloat()
        val qz = 0f
        val qw = cos(half).toFloat()

        return try {
            // ARCore 1.40+ : createAnchor avec GeospatialPose — altitude relative au terrain
            val geoPose = earth.getGeospatialPose()
            val anchor = earth.createAnchor(
                data.latitude, data.longitude,
                /* altitudeAboveTerrain = */ 0.5,   // 50cm au-dessus du sol
                qx, qy, qz, qw
            )
            Log.d(TAG, "Anchor terrain step=${data.stepIndex} acc=${_accuracy.value?.label}")
            data.copy(anchor = anchor)
        } catch (e: Exception) {
            // Fallback si la nouvelle API n'est pas disponible (anciens devices ARCore < 1.40)
            try {
                @Suppress("DEPRECATION")
                val anchor = earth.resolveAnchorOnTerrain(
                    data.latitude, data.longitude, 0.5, qx, qy, qz, qw
                )
                Log.d(TAG, "Anchor terrain (fallback legacy) step=${data.stepIndex}")
                data.copy(anchor = anchor)
            } catch (e2: Exception) {
                Log.e(TAG, "placeArrowAnchor failed: ${e2.message}")
                data
            }
        }
    }

    fun cleanup() { _accuracy.value = null }

    companion object {
        fun computeBearing(fromLat: Double, fromLng: Double, toLat: Double, toLng: Double): Float {
            val la1 = Math.toRadians(fromLat); val la2 = Math.toRadians(toLat)
            val dL  = Math.toRadians(toLng - fromLng)
            val y = sin(dL) * cos(la2)
            val x = cos(la1) * sin(la2) - sin(la1) * cos(la2) * cos(dL)
            return ((Math.toDegrees(atan2(y, x)) + 360) % 360).toFloat()
        }

        fun distanceMeters(lat1: Double, lng1: Double, lat2: Double, lng2: Double): Double {
            val R = 6_371_000.0
            val p1 = Math.toRadians(lat1); val p2 = Math.toRadians(lat2)
            val dp = Math.toRadians(lat2 - lat1); val dl = Math.toRadians(lng2 - lng1)
            val a = sin(dp / 2).pow(2) + cos(p1) * cos(p2) * sin(dl / 2).pow(2)
            return R * 2 * atan2(sqrt(a), sqrt(1 - a))
        }
    }
}
