package com.silexperience.velohnav.ar

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.google.ar.core.Config
import com.google.ar.core.TrackingState
import io.github.sceneview.ar.ARSceneView
import com.silexperience.velohnav.ar.ui.NavigationHud
import com.silexperience.velohnav.ar.ui.VelohNavArTheme

class ArNavigationActivity : ComponentActivity() {
    private val viewModel: ArNavigationViewModel by viewModels()
    private lateinit var arView: ARSceneView

    private val permLauncher = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { results ->
        if (results.all { it.value }) startAr()
        else { Toast.makeText(this, "Caméra et localisation requis", Toast.LENGTH_LONG).show(); finish() }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
        val destLat = intent.getDoubleExtra("dest_lat", 0.0)
        val destLng = intent.getDoubleExtra("dest_lng", 0.0)
        val destName = intent.getStringExtra("dest_name") ?: "Destination"
        val mode = intent.getStringExtra("travel_mode") ?: "bicycling"
        if (destLat == 0.0) { Toast.makeText(this, "Destination invalide", Toast.LENGTH_SHORT).show(); finish(); return }

        setContent {
            VelohNavArTheme {
                val state by viewModel.navState.collectAsState()
                Box(Modifier.fillMaxSize()) {
                    AndroidView(factory = { ctx ->
                        ARSceneView(ctx).also { v ->
                            arView = v
                            v.onSessionConfiguration = { _, config ->
                                config.geospatialMode = Config.GeospatialMode.ENABLED
                                config.lightEstimationMode = Config.LightEstimationMode.ENVIRONMENTAL_HDR
                                config.planeFindingMode = Config.PlaneFindingMode.DISABLED
                            }
                            v.onSessionUpdated = { session, frame ->
                                session.earth?.let { e ->
                                    if (e.trackingState == TrackingState.TRACKING)
                                        viewModel.onEarthTracking(e, frame)
                                }
                            }
                            checkPermissions { viewModel.initializeNavigation(v, destLat, destLng, destName, mode) }
                        }
                    }, Modifier.fillMaxSize())
                    NavigationHud(state=state, onClose={ finish() })
                }
            }
        }
    }

    private fun checkPermissions(onGranted: () -> Unit) {
        val perms = arrayOf(Manifest.permission.CAMERA, Manifest.permission.ACCESS_FINE_LOCATION)
        if (perms.all { ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED }) onGranted()
        else permLauncher.launch(perms)
    }
    private fun startAr() { /* permissions ok */ }
    override fun onResume()  { super.onResume();  if (::arView.isInitialized) arView.resume() }
    override fun onPause()   { super.onPause();   if (::arView.isInitialized) arView.pause() }
    override fun onDestroy() { super.onDestroy(); if (::arView.isInitialized) arView.destroy(); viewModel.cleanup() }
}
