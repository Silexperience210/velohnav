package com.silexperience.velohnav.ar

import android.content.Intent
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.silexperience.velohnav.BuildConfig

@CapacitorPlugin(name = "ArNavigation")
class ArNavigationPlugin : Plugin() {

    @PluginMethod(returnType = PluginMethod.RETURN_PROMISE)
    fun startNavigation(call: PluginCall) {
        android.util.Log.d("ArNavPlugin", "startNavigation appelé")
        android.util.Log.d("ArNavPlugin", "  destLat  = ${call.getDouble("destLat")}")
        android.util.Log.d("ArNavPlugin", "  destLng  = ${call.getDouble("destLng")}")
        android.util.Log.d("ArNavPlugin", "  destName = ${call.getString("destName")}")
        android.util.Log.d("ArNavPlugin", "  activity = $activity")

        val destLat    = call.getDouble("destLat")    ?: run {
            android.util.Log.e("ArNavPlugin", "REJECT: destLat manquant")
            return call.reject("destLat requis")
        }
        val destLng    = call.getDouble("destLng")    ?: run {
            android.util.Log.e("ArNavPlugin", "REJECT: destLng manquant")
            return call.reject("destLng requis")
        }
        val destName   = call.getString("destName")   ?: "Destination"
        val travelMode = call.getString("travelMode") ?: "bicycling"
        val webMapsKey = call.getString("mapsKey")?.takeIf { it.isNotBlank() && it != "null" && it.length > 10 }
        val nativeKey  = BuildConfig.MAPS_API_KEY.takeIf { it.isNotBlank() && it != "null" && it.length > 10 }
        val finalKey   = webMapsKey ?: nativeKey ?: ""

        android.util.Log.d("ArNavPlugin", "  → startActivity ArNavigationActivity")

        // Préparer l'intent sur le thread courant
        val intent = Intent(activity, ArNavigationActivity::class.java).apply {
            putExtra("dest_lat",    destLat)
            putExtra("dest_lng",    destLng)
            putExtra("dest_name",   destName)
            putExtra("travel_mode", travelMode)
            putExtra("maps_key",    finalKey)
        }

        // Résoudre la Promise Capacitor immédiatement (sur le thread Capacitor)
        call.resolve()
        android.util.Log.d("ArNavPlugin", "  call.resolve() OK")

        // Lancer l'Activity sur le main thread (UI thread obligatoire)
        activity.runOnUiThread {
            try {
                android.widget.Toast.makeText(activity, "AR Nav → $destName", android.widget.Toast.LENGTH_SHORT).show()
                activity.startActivity(intent)
                android.util.Log.d("ArNavPlugin", "  startActivity OK")
            } catch (e: Exception) {
                android.util.Log.e("ArNavPlugin", "  startActivity FAILED: ${e.message}", e)
            }
        }
    }
}
