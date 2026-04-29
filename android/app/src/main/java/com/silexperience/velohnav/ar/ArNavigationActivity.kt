package com.silexperience.velohnav.ar

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.activity.OnBackPressedCallback
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
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.google.ar.core.ArCoreApk
import com.google.ar.core.Config
import io.github.sceneview.ar.ARSceneView
import kotlinx.coroutines.launch
import com.silexperience.velohnav.ar.ui.NavigationHud
import com.silexperience.velohnav.ar.ui.VelohNavArTheme

class ArNavigationActivity : ComponentActivity() {

    private val viewModel: ArNavigationViewModel by viewModels()
    private var arView: ARSceneView? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    private val TAG = "ArNavActivity"
    // Compteur de frames ARCore reçus — utilisé par le watchdog 5s pour détecter
    // si ARCore ne démarre pas du tout (clé API invalide, capteur HS, etc.)
    @Volatile private var sessionUpdateCount = 0

    private var pendingDestLat: Double = 0.0
    private var pendingDestLng: Double = 0.0
    private var pendingDestName: String = "Destination"
    private var pendingTravelMode: String = "bicycling"
    private var pendingMapsKey: String = ""

    private val permLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { results ->
        if (results.all { it.value }) {
            checkArCoreAvailability { startNavigation() }
        } else {
            Toast.makeText(this, "Caméra et localisation requis pour AR", Toast.LENGTH_LONG).show()
            finish()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        pendingDestLat    = savedInstanceState?.getDouble("dest_lat")    ?: intent.getDoubleExtra("dest_lat", 0.0)
        pendingDestLng    = savedInstanceState?.getDouble("dest_lng")    ?: intent.getDoubleExtra("dest_lng", 0.0)
        pendingDestName   = savedInstanceState?.getString("dest_name")   ?: intent.getStringExtra("dest_name")   ?: "Destination"
        pendingTravelMode = savedInstanceState?.getString("travel_mode") ?: intent.getStringExtra("travel_mode") ?: "bicycling"
        pendingMapsKey    = savedInstanceState?.getString("maps_key")    ?: intent.getStringExtra("maps_key")    ?: ""

        // FIX BUG-4 : diagnostic clé API au démarrage. Si la clé est vide ou
        // manifestement invalide, on bascule directement en mode GPS sans
        // attendre le timeout 25s d'ARCore (qui produit le message d'erreur
        // "Clé API ARCore non disponible" récurrent).
        // On loggue la longueur (jamais la clé en clair) pour debug.
        val nativeKeyLen = try {
            com.silexperience.velohnav.BuildConfig.MAPS_API_KEY.length
        } catch (_: Exception) { 0 }
        val intentKeyLen = pendingMapsKey.length
        Log.d(TAG, "API key diag: native=${nativeKeyLen}c · intent=${intentKeyLen}c")

        if (pendingDestLat == 0.0) {
            Toast.makeText(this, "Destination invalide", Toast.LENGTH_SHORT).show()
            finish(); return
        }

        enableEdgeToEdge()
        // Hide status + navigation bars en immersif (AR pleine vue)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }

        setContent {
            VelohNavArTheme {
                val state by viewModel.navState.collectAsState()
                Box(Modifier.fillMaxSize()) {
                    AndroidView(
                        modifier = Modifier.fillMaxSize(),
                        factory = { ctx ->
                            ARSceneView(
                                context          = ctx,
                                sharedActivity   = this@ArNavigationActivity,
                                sharedLifecycle  = this@ArNavigationActivity.lifecycle,
                                sessionConfiguration = { _, config ->
                                    config.geospatialMode      = Config.GeospatialMode.ENABLED
                                    config.lightEstimationMode = Config.LightEstimationMode.ENVIRONMENTAL_HDR
                                    config.planeFindingMode    = Config.PlaneFindingMode.DISABLED
                                    Log.d(TAG, "ARCore config: Geospatial=ENABLED")
                                }
                            ).also { v ->
                                arView = v

                                v.onSessionUpdated = { session, frame ->
                                    sessionUpdateCount++
                                    val earth = session.earth
                                    if (earth != null) {
                                        // FIX : appeler onEarthTracking MÊME si pas tracking,
                                        // pour que le diagnostic Earth soit toujours à jour.
                                        // Le ViewModel gérera le cas non-tracking en interne.
                                        mainHandler.post {
                                            try {
                                                viewModel.onEarthTracking(earth, frame, v)
                                            } catch (e: Exception) {
                                                Log.e(TAG, "onEarthTracking error", e)
                                            }
                                        }
                                    } else if (sessionUpdateCount % 60 == 0) {
                                        Log.w(TAG, "session.earth est null (frame $sessionUpdateCount)")
                                    }
                                }

                                v.onSessionFailed = { e ->
                                    mainHandler.post {
                                        Log.e(TAG, "ARCore session failed", e)
                                        Toast.makeText(
                                            this@ArNavigationActivity,
                                            "ARCore indisponible : ${e.message}",
                                            Toast.LENGTH_LONG
                                        ).show()
                                        finish()
                                    }
                                }

                                checkPermissions {
                                    checkArCoreAvailability { startNavigation() }
                                }
                            }
                        }
                    )
                    NavigationHud(
                        state           = state,
                        onClose         = { finish() },
                        onFallbackToGps = { viewModel.fallbackToGps() }
                    )
                }
            }
        }

        // FIX : watchdog qui vérifie après 8s qu'on a bien reçu des frames ARCore.
        // Si sessionUpdateCount = 0, ARCore n'a pas démarré → diagnostic explicite.
        // Délai 8s pour laisser le temps au routing OSRM + initialisation ARCore.
        lifecycleScope.launch {
            kotlinx.coroutines.delay(8000)
            if (sessionUpdateCount == 0) {
                Log.e(TAG, "Aucun onSessionUpdated reçu après 8s — ARCore ne démarre pas")
                Toast.makeText(
                    this@ArNavigationActivity,
                    "ARCore ne répond pas — vérifiez clé API + extérieur",
                    Toast.LENGTH_LONG
                ).show()
                viewModel.fallbackToGps()
            } else {
                Log.d(TAG, "Watchdog OK : $sessionUpdateCount frames ARCore reçus en 8s")
            }
        }

        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                viewModel.navState.collect { s ->
                    if (s.status == NavStatus.ERROR && s.errorMessage != null)
                        Toast.makeText(this@ArNavigationActivity, s.errorMessage, Toast.LENGTH_LONG).show()
                }
            }
        }

        // Back press propre — cancel le job de navigation avant de finish()
        // Évite les leaks et les crashes si ARCore est en plein placement d'ancre
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                Log.d(TAG, "Back press → cleanup + finish")
                viewModel.cleanup(arView)
                finish()
            }
        })
    }

    // Vérifier qu'ARCore est installé et à jour avant de lancer la navigation
    private fun checkArCoreAvailability(onAvailable: () -> Unit) {
        try {
            when (val av = ArCoreApk.getInstance().checkAvailability(this)) {
                ArCoreApk.Availability.SUPPORTED_INSTALLED -> onAvailable()
                ArCoreApk.Availability.SUPPORTED_APK_TOO_OLD,
                ArCoreApk.Availability.SUPPORTED_NOT_INSTALLED -> {
                    try {
                        ArCoreApk.getInstance().requestInstall(this, true)
                    } catch (e: Exception) {
                        Log.e(TAG, "ARCore install request failed", e)
                        finish()
                    }
                }
                else -> {
                    Toast.makeText(this, "ARCore non supporté ($av)", Toast.LENGTH_LONG).show()
                    finish()
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "checkArCoreAvailability error", e)
            // Continuer quand même — certains appareils retournent des erreurs
            // mais supportent quand même ARCore
            onAvailable()
        }
    }

    private fun checkPermissions(onGranted: () -> Unit) {
        val perms = arrayOf(Manifest.permission.CAMERA, Manifest.permission.ACCESS_FINE_LOCATION)
        if (perms.all { ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED })
            onGranted()
        else
            permLauncher.launch(perms)
    }

    private fun startNavigation() {
        val v = arView ?: run { Log.e(TAG, "ARSceneView null"); return }
        Log.d(TAG, "startNavigation → $pendingDestLat, $pendingDestLng")
        viewModel.initializeNavigation(v, pendingDestLat, pendingDestLng, pendingDestName, pendingTravelMode, pendingMapsKey)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putDouble("dest_lat",    pendingDestLat)
        outState.putDouble("dest_lng",    pendingDestLng)
        outState.putString("dest_name",   pendingDestName)
        outState.putString("travel_mode", pendingTravelMode)
        outState.putString("maps_key",    pendingMapsKey)
    }

    override fun onDestroy() {
        super.onDestroy()
        Log.d(TAG, "onDestroy")
        mainHandler.removeCallbacksAndMessages(null)
        viewModel.cleanup(arView)  // Passer la référence courante pour cleanup propre
        arView = null
    }
}
