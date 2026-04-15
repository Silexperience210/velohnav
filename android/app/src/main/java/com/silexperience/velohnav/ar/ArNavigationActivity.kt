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
    private var arView: ARSceneView? = null

    private var pendingDestLat: Double = 0.0
    private var pendingDestLng: Double = 0.0
    private var pendingDestName: String = "Destination"
    private var pendingTravelMode: String = "bicycling"
    private var pendingMapsKey: String = ""

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
        pendingDestLat    = intent.getDoubleExtra("dest_lat", 0.0)
        pendingDestLng    = intent.getDoubleExtra("dest_lng", 0.0)
        pendingDestName   = intent.getStringExtra("dest_name") ?: "Destination"
        pendingTravelMode = intent.getStringExtra("travel_mode") ?: "bicycling"
        // Clé Maps transmise depuis le localStorage web via le plugin Capacitor
        pendingMapsKey    = intent.getStringExtra("maps_key") ?: ""

        if (pendingDestLat == 0.0) {
            Toast.makeText(this, "Destination invalide", Toast.LENGTH_SHORT).show()
            finish(); return
        }

        setContent {
            VelohNavArTheme {
                val state by viewModel.navState.collectAsState()
                Box(Modifier.fillMaxSize()) {
                    AndroidView(factory = { ctx ->
                        ARSceneView(
                            context = ctx,
                            sessionConfiguration = { session, config ->
                                config.geospatialMode      = Config.GeospatialMode.ENABLED
                                config.lightEstimationMode = Config.LightEstimationMode.ENVIRONMENTAL_HDR
                                config.planeFindingMode    = Config.PlaneFindingMode.DISABLED
                            }
                        ).also { v ->
                            arView = v
                            v.onSessionUpdated = { session, frame ->
                                session.earth?.let { e ->
                                    if (e.trackingState == TrackingState.TRACKING)
                                        viewModel.onEarthTracking(e, frame)
                                }
                            }
                            checkPermissions {
                                viewModel.initializeNavigation(
                                    v, pendingDestLat, pendingDestLng,
                                    pendingDestName, pendingTravelMode, pendingMapsKey
                                )
                            }
                        }
                    }, Modifier.fillMaxSize())
                    NavigationHud(state = state, onClose = { finish() })
                }
            }
        }
    }

    private fun checkPermissions(onGranted: () -> Unit) {
        val perms = arrayOf(Manifest.permission.CAMERA, Manifest.permission.ACCESS_FINE_LOCATION)
        if (perms.all { ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED }) onGranted()
        else permLauncher.launch(perms)
    }

    private fun startAr() {
        val v = arView ?: return
        viewModel.initializeNavigation(
            v, pendingDestLat, pendingDestLng,
            pendingDestName, pendingTravelMode, pendingMapsKey
        )
    }

    override fun onDestroy() {
        super.onDestroy()
        viewModel.cleanup()
    }
}
