package com.silexperience.velohnav.ar

import android.content.Intent
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.silexperience.velohnav.BuildConfig

@CapacitorPlugin(name = "ArNavigation")
class ArNavigationPlugin : Plugin() {
    @PluginMethod
    fun startNavigation(call: PluginCall) {
        val destLat = call.getDouble("destLat") ?: return call.reject("destLat requis")
        val destLng = call.getDouble("destLng") ?: return call.reject("destLng requis")
        val destName = call.getString("destName") ?: "Destination"
        val travelMode = call.getString("travelMode") ?: "bicycling"
        
        val webMapsKey = call.getString("mapsKey")?.takeIf { it.isNotBlank() && !it.contains("null") && it.length > 10 }
        val nativeKey = BuildConfig.MAPS_API_KEY.takeIf { it.isNotBlank() && it != "null" && it.length > 10 }
        
        if (webMapsKey == null && nativeKey == null) {
            return call.reject("NO_API_KEY", "Clé Google Maps manquante. Allez dans OPT pour la configurer.")
        }
        
        val finalKey = webMapsKey ?: nativeKey!!
        val intent = Intent(activity, ArNavigationActivity::class.java).apply {
            putExtra("dest_lat", destLat)
            putExtra("dest_lon", destLng)
            putExtra("dest_name", destName)
            putExtra("travel_mode", travelMode)
            putExtra("maps_key", finalKey)
        }
        activity.startActivity(intent)
        call.resolve()
    }
}
