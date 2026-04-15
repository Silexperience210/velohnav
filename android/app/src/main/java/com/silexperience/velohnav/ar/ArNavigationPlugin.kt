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
        // Clé Google Maps transmise depuis le localStorage web — prioritaire sur BuildConfig
        val mapsKey    = call.getString("mapsKey")    ?: BuildConfig.MAPS_API_KEY ?: ""

        val intent = Intent(activity, ArNavigationActivity::class.java).apply {
            putExtra("dest_lat",    destLat)
            putExtra("dest_lng",    destLng)
            putExtra("dest_name",   destName)
            putExtra("travel_mode", travelMode)
            putExtra("maps_key",    mapsKey)
        }
        activity.startActivity(intent)
        call.resolve()
    }
}
