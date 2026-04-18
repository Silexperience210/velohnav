package com.silexperience.velohnav

import android.os.Bundle
import com.getcapacitor.BridgeActivity
import com.silexperience.velohnav.ar.ArNavigationPlugin

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(ArNavigationPlugin::class.java)
        super.onCreate(savedInstanceState)
    }
}
