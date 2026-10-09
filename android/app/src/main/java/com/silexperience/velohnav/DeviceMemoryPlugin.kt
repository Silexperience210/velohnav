package com.silexperience.velohnav

import android.app.ActivityManager
import android.content.Context
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Mémoire du système, lue avant de charger le modèle IA local (src/ai/deviceMemory.js).
 * Le WebView ne voit que navigator.deviceMemory (RAM totale, arrondie) : insuffisant
 * pour savoir si ~1,5 Go peuvent être alloués sans que le système tue l'application.
 */
@CapacitorPlugin(name = "DeviceMemory")
class DeviceMemoryPlugin : Plugin() {

    @PluginMethod(returnType = PluginMethod.RETURN_PROMISE)
    fun info(call: PluginCall) {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val mi = ActivityManager.MemoryInfo()
        am.getMemoryInfo(mi)
        val ret = JSObject()
        // Long → Double : nombres JS (précis jusqu'à 2^53 octets)
        ret.put("availBytes", mi.availMem.toDouble())
        ret.put("totalBytes", mi.totalMem.toDouble())
        ret.put("thresholdBytes", mi.threshold.toDouble())
        ret.put("lowMemory", mi.lowMemory)
        call.resolve(ret)
    }
}
