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
            p.horizontalAccuracy, p.headingAccuracy,
            p.horizontalAccuracy < 5.0 && p.headingAccuracy < 15.0
        )
    }

    /**
     * Place une flèche de navigation à la position [data].
     *
     * TODO (ARCore 1.40+): migrer vers resolveAnchorOnRooftopAsync (API callback/Future)
     * pour une meilleure précision en milieu urbain dense (Luxembourg-Ville).
     * La migration requiert une refacto du ViewModel pour gérer le Future<Anchor>.
     */
    @Suppress("DEPRECATION")
    fun placeArrowAnchor(earth: Earth, data: TerrainAnchorData): TerrainAnchorData {
        val rad  = Math.toRadians(data.bearingDegrees.toDouble())
        val half = rad / 2.0
        return try {
            val anchor = earth.resolveAnchorOnTerrain(
                data.latitude, data.longitude, 0.5,
                0f, sin(half).toFloat(), 0f, cos(half).toFloat()
            )
            Log.d(TAG, "Anchor créé step=${data.stepIndex} bearing=${data.bearingDegrees}°")
            data.copy(anchor = anchor)
        } catch (e: Exception) {
            Log.e(TAG, "placeArrowAnchor error: ${e.message}")
            data
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

// Extension : migration vers resolveAnchorOnRooftopAsync (ARCore 1.40+)
// Utilisation : appeler placeArrowAnchorAsync depuis une coroutine ViewModel
// La méthode retourne null si le Future échoue ou si l'état de tracking est invalide.
//
// TODO: Remplacer placeArrowAnchor() par cette fonction dans ArNavigationViewModel.placeArrow()
//       une fois que la gestion de Future<Anchor> sera intégrée dans le ViewModel.
//
// fun GeospatialManager.placeArrowAnchorAsync(
//     earth: Earth, data: TerrainAnchorData,
//     scope: CoroutineScope
// ): TerrainAnchorData {
//     val rad = Math.toRadians(data.bearingDegrees.toDouble()); val half = rad / 2.0
//     return try {
//         val future = earth.resolveAnchorOnRooftopAsync(
//             data.latitude, data.longitude, 0.5,
//             0f, sin(half).toFloat(), 0f, cos(half).toFloat()
//         )
//         // future.resultCode : ResolveAnchorOnRooftopFuture.ResultCode
//         data.copy(anchor = future.result?.takeIf {
//             future.resultCode == Earth.ResolveAnchorOnRooftopFuture.ResultCode.SUCCESS
//         })
//     } catch (e: Exception) { Log.e("GeoMgr", "RooftopAsync error", e); data }
// }
