package com.silexperience.velohnav.ar

import android.content.Intent
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Plugin Capacitor — bridge entre le WebView VelohNav et l'AR Activity native.
 *
 * Utilisation depuis JavaScript/TypeScript :
 *
 *   import { registerPlugin } from '@capacitor/core';
 *   const ArNavigation = registerPlugin('ArNavigation');
 *   await ArNavigation.startNavigation({
 *     destLat: 49.5994, destLng: 6.1448,
 *     destName: "Gare de Luxembourg", travelMode: "bicycling"
 *   });
 */
@CapacitorPlugin(name = "ArNavigation")
class ArNavigationPlugin : Plugin() {

    @PluginMethod
    fun startNavigation(call: PluginCall) {
        val destLat   = call.getDouble("destLat")   ?: return call.reject("destLat requis")
        val destLng   = call.getDouble("destLng")   ?: return call.reject("destLng requis")
        val destName  = call.getString("destName")  ?: "Destination"
        val travelMode = call.getString("travelMode") ?: "bicycling"

        val intent = Intent(activity, ArNavigationActivity::class.java).apply {
            putExtra("dest_lat",    destLat)
            putExtra("dest_lng",    destLng)
            putExtra("dest_name",   destName)
            putExtra("travel_mode", travelMode)
        }
        activity.startActivity(intent)
        call.resolve()
    }
}
