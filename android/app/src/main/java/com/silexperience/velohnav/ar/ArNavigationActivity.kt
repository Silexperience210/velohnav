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
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
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

class ArNavigationActivity : ComponentActivity() {
    private val viewModel: ArNavigationViewModel by viewModels()
    private var arView: ARSceneView? = null
    private var destLat: Double = 0.0
    private var destLng: Double = 0.0
    private var destName: String = ""
    private var travelMode: String = ""
    private var mapsKey: String = ""

    private val permLauncher = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { results ->
        if (results.all { it.value }) startAr() else { 
            Toast.makeText(this, "Permissions requises", Toast.LENGTH_LONG).show()
            finish() 
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        
        destLat = savedInstanceState?.getDouble("dest_lat") ?: intent.getDoubleExtra("dest_lat", 0.0)
        destLng = savedInstanceState?.getDouble("dest_lng") ?: intent.getDoubleExtra("dest_lng", 0.0)
        destName = savedInstanceState?.getString("dest_name") ?: intent.getStringExtra("dest_name") ?: "Destination"
        travelMode = savedInstanceState?.getString("travel_mode") ?: intent.getStringExtra("travel_mode") ?: "bicycling"
        mapsKey = savedInstanceState?.getString("maps_key") ?: intent.getStringExtra("maps_key") ?: ""

        if (destLat == 0.0) {
            Toast.makeText(this, "Destination invalide", Toast.LENGTH_SHORT).show()
            finish()
            return
        }

        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
        }

        setContent {
            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    val state by viewModel.navState.collectAsState()
                    Box(modifier = Modifier.fillMaxSize()) {
                        AndroidView(
                            factory = { ctx ->
                                ARSceneView(
                                    context = ctx,
                                    sessionConfiguration = { session, config ->
                                        config.geospatialMode = Config.GeospatialMode.ENABLED
                                        config.lightEstimationMode = Config.LightEstimationMode.ENVIRONMENTAL_HDR
                                        config.planeFindingMode = Config.PlaneFindingMode.DISABLED
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
                                        viewModel.initializeNavigation(v, destLat, destLng, destName, travelMode, mapsKey)
                                    }
                                }
                            }, 
                            modifier = Modifier.fillMaxSize()
                        )
                        HudContent(state = state, onClose = { finish() })
                    }
                }
            }
        }

        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                viewModel.navState.collect { state ->
                    if (state.status == NavStatus.ERROR && state.errorMessage != null) {
                        Toast.makeText(this@ArNavigationActivity, state.errorMessage, Toast.LENGTH_LONG).show()
                    }
                }
            }
        }
    }

    @Composable
    fun HudContent(state: NavState, onClose: () -> Unit) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(16.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Text(
                text = when (state.status) {
                    NavStatus.IDLE -> "Prêt"
                    NavStatus.LOCATING -> "Localisation GPS..."
                    NavStatus.ROUTING -> "Calcul itinéraire..."
                    NavStatus.LOCALIZING -> "Localisation AR..."
                    NavStatus.NAVIGATING -> "Navigation AR active (${state.stepIndex + 1}/${state.totalSteps})"
                    NavStatus.ARRIVED -> "Destination atteinte !"
                    NavStatus.ERROR -> "Erreur: ${state.errorMessage ?: "Inconnue"}"
                },
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.primary
            )
            
            state.currentStep?.let { step ->
                Text(
                    text = step.instruction,
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.padding(top = 8.dp)
                )
                Text(
                    text = "${state.distanceToNextTurnMeters.toInt()}m",
                    style = MaterialTheme.typography.bodyLarge
                )
            }
            
            Button(onClick = onClose, modifier = Modifier.padding(top = 16.dp)) {
                Text("✕ Fermer")
            }
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putDouble("dest_lat", destLat)
        outState.putDouble("dest_lng", destLng)
        outState.putString("dest_name", destName)
        outState.putString("travel_mode", travelMode)
        outState.putString("maps_key", mapsKey)
    }

    private fun checkPermissions(onGranted: () -> Unit) {
        val perms = arrayOf(Manifest.permission.CAMERA, Manifest.permission.ACCESS_FINE_LOCATION)
        if (perms.all { ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED }) {
            onGranted()
        } else {
            permLauncher.launch(perms)
        }
    }

    private fun startAr() {
        arView?.let { viewModel.initializeNavigation(it, destLat, destLng, destName, travelMode, mapsKey) }
    }

    override fun onDestroy() {
        super.onDestroy()
        viewModel.cleanup()
        arView = null
    }
}
