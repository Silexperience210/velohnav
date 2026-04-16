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
        val destLat    = call.getDouble("destLat")    ?: return call.reject("destLat requis")
        val destLng    = call.getDouble("destLng")    ?: return call.reject("destLng requis")
        val destName   = call.getString("destName")   ?: "Destination"
        val travelMode = call.getString("travelMode") ?: "bicycling"
        // Clé Maps optionnelle — OSRM ne la requiert pas, Google Directions si
        val webMapsKey = call.getString("mapsKey")?.takeIf { it.isNotBlank() && it != "null" && it.length > 10 }
        val nativeKey  = BuildConfig.MAPS_API_KEY.takeIf { it.isNotBlank() && it != "null" && it.length > 10 }
        val finalKey   = webMapsKey ?: nativeKey ?: ""
        // Note : si finalKey est vide, RouteManager utilisera OSRM (pas de clé requise)

        val intent = Intent(activity, ArNavigationActivity::class.java).apply {
            putExtra("dest_lat",    destLat)
            putExtra("dest_lng",    destLng)   // FIX: dest_lon → dest_lng (cohérence Activity)
            putExtra("dest_name",   destName)
            putExtra("travel_mode", travelMode)
            putExtra("maps_key",    finalKey)
        }
        activity.startActivity(intent)
        call.resolve()
    }
}
