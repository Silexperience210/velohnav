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
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.google.ar.core.Config
import com.google.ar.core.TrackingState
import io.github.sceneview.ar.ARSceneView
import kotlinx.coroutines.launch
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

    private val permLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { results ->
        if (results.all { it.value }) startAr()
        else {
            Toast.makeText(this, "Caméra et localisation requis", Toast.LENGTH_LONG).show()
            finish()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Restaurer depuis savedInstanceState ou Intent
        pendingDestLat    = savedInstanceState?.getDouble("dest_lat")    ?: intent.getDoubleExtra("dest_lat", 0.0)
        pendingDestLng    = savedInstanceState?.getDouble("dest_lng")    ?: intent.getDoubleExtra("dest_lng", 0.0)
        pendingDestName   = savedInstanceState?.getString("dest_name")   ?: intent.getStringExtra("dest_name")   ?: "Destination"
        pendingTravelMode = savedInstanceState?.getString("travel_mode") ?: intent.getStringExtra("travel_mode") ?: "bicycling"
        pendingMapsKey    = savedInstanceState?.getString("maps_key")    ?: intent.getStringExtra("maps_key")    ?: ""

        if (pendingDestLat == 0.0) {
            Toast.makeText(this, "Destination invalide", Toast.LENGTH_SHORT).show()
            finish(); return
        }

        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }

        setContent {
            VelohNavArTheme {
                val state by viewModel.navState.collectAsState()
                Box(Modifier.fillMaxSize()) {
                    AndroidView(
                        factory = { ctx ->
                            ARSceneView(
                                context = ctx,
                                sessionConfiguration = { _, config ->
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
                        },
                        modifier = Modifier.fillMaxSize()
                    )
                    // HUD navigation — composant dédié (NavigationHud.kt)
                    NavigationHud(state = state, onClose = { finish() })
                }
            }
        }

        // Observer les erreurs pour les afficher aussi en Toast
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                viewModel.navState.collect { s ->
                    if (s.status == NavStatus.ERROR && s.errorMessage != null)
                        Toast.makeText(this@ArNavigationActivity, s.errorMessage, Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putDouble("dest_lat",    pendingDestLat)
        outState.putDouble("dest_lng",    pendingDestLng)
        outState.putString("dest_name",   pendingDestName)
        outState.putString("travel_mode", pendingTravelMode)
        outState.putString("maps_key",    pendingMapsKey)
    }

    private fun checkPermissions(onGranted: () -> Unit) {
        val perms = arrayOf(Manifest.permission.CAMERA, Manifest.permission.ACCESS_FINE_LOCATION)
        if (perms.all { ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED })
            onGranted()
        else
            permLauncher.launch(perms)
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
        arView = null
    }
}
