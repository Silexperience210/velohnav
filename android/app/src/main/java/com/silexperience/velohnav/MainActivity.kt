package com.silexperience.velohnav

import android.os.Bundle
import com.getcapacitor.BridgeActivity
import com.silexperience.velohnav.ar.ArNavigationPlugin
import com.silexperience.velohnav.llm.LocalLlmPlugin

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(ArNavigationPlugin::class.java)
        registerPlugin(DeviceMemoryPlugin::class.java)
        registerPlugin(LocalLlmPlugin::class.java)
        super.onCreate(savedInstanceState)
        // Page isolée (COOP/COEP) : fils multiples pour le modèle local (CrossOriginIsolation).
        bridge.setWebViewClient(IsolatingWebViewClient(bridge))
    }
}
