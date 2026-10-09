package com.silexperience.velohnav.ar

import android.Manifest
import android.content.pm.PackageManager
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
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
import androidx.compose.runtime.LaunchedEffect
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
import java.util.concurrent.atomic.AtomicInteger

class ArNavigationActivity : ComponentActivity(), SensorEventListener {

    private val viewModel: ArNavigationViewModel by viewModels()
    private var arView: ARSceneView? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    private val TAG = "ArNavActivity"
    // Compteur de frames ARCore reçus — utilisé par le watchdog 8s pour détecter
    // si ARCore ne démarre pas du tout (clé API invalide, capteur HS, etc.)
    // AtomicInteger pour garantir l'atomicité de l'incrément cross-thread.
    private val sessionUpdateCount = AtomicInteger(0)

    private var pendingDestLat: Double = 0.0
    private var pendingDestLng: Double = 0.0
    private var pendingDestName: String = "Destination"
    private var pendingTravelMode: String = "bicycling"
    private var pendingMapsKey: String = ""
    // Langue de l'interface web (fr/en) et guidage web actif derrière l'activité
    private var lang: String = "fr"
    private var webGuidance: Boolean = false
    private val s: ArStrings get() = ArStrings.of(lang)
    // Installation d'ARCore demandée : reprise au retour (onResume)
    private var installRequested = false
    private var afterInstall: (() -> Unit)? = null
    private var availabilityTries = 0

    // Boussole native : capteur de rotation (gyroscope + accéléromètre +
    // magnétomètre fusionnés), lu pour l'axe de la CAMÉRA, pas le haut de l'écran.
    private val sensorManager by lazy { getSystemService(SENSOR_SERVICE) as SensorManager }
    private val rotationMatrix = FloatArray(9)
    private val rotationD = DoubleArray(9)

    private val permLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { results ->
        if (results.all { it.value }) {
            checkArCoreAvailability { startNavigation() }
        } else {
            Toast.makeText(this, s.permissionsRequired, Toast.LENGTH_LONG).show()
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
        lang              = intent.getStringExtra("lang") ?: "fr"
        webGuidance       = intent.getBooleanExtra("web_guidance", false)

        // Diagnostic clé API au démarrage : on loggue la longueur (jamais la clé
        // en clair). Sans clé, Geospatial n'est pas demandé et l'AR au sol suffit ;
        // avec une clé refusée (ERROR_NOT_AUTHORIZED, voir permanentEarthError), seul
        // le bonus manque.
        val nativeKeyLen = try {
            com.silexperience.velohnav.BuildConfig.MAPS_API_KEY.length
        } catch (_: Exception) { 0 }
        val intentKeyLen = pendingMapsKey.length
        Log.d(TAG, "API key diag: native=${nativeKeyLen}c · intent=${intentKeyLen}c")
        // ARCore lit la clé du manifest (= BuildConfig), jamais celle de l'intent
        // (qui ne sert qu'au calcul d'itinéraire Google).
        viewModel.apiKeyPresent = nativeKeyLen > 10

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
                                sessionConfiguration = { session, config ->
                                    // AR au sol : plans horizontaux pour l'essai d'impact (avant :
                                    // DISABLED, aucun sol n'était jamais détecté). Geospatial n'est
                                    // demandé que si une clé existe — c'est un bonus, pas une condition.
                                    config.geospatialMode = if (viewModel.apiKeyPresent)
                                        Config.GeospatialMode.ENABLED else Config.GeospatialMode.DISABLED
                                    config.planeFindingMode    = Config.PlaneFindingMode.HORIZONTAL
                                    config.lightEstimationMode = Config.LightEstimationMode.ENVIRONMENTAL_HDR
                                    config.focusMode           = Config.FocusMode.AUTO
                                    // Profondeur (si l'appareil la gère) : essais d'impact plus sûrs
                                    if (session.isDepthModeSupported(Config.DepthMode.AUTOMATIC))
                                        config.depthMode = Config.DepthMode.AUTOMATIC
                                    Log.d(TAG, "ARCore config: plans=HORIZONTAL geospatial=${config.geospatialMode} depth=${config.depthMode}")
                                }
                            ).also { v ->
                                arView = v

                                // Thread principal (Choreographer). Traité sur l'instant et non
                                // plus reporté par mainHandler.post : l'essai d'impact exige le
                                // Frame courant, périmé dès l'image suivante.
                                v.onSessionUpdated = { session, frame ->
                                    sessionUpdateCount.incrementAndGet()
                                    try {
                                        viewModel.onArFrame(session, frame, v)
                                    } catch (e: Exception) {
                                        Log.e(TAG, "onArFrame error", e)
                                    }
                                }

                                v.onSessionFailed = { e ->
                                    mainHandler.post {
                                        Log.e(TAG, "ARCore session failed", e)
                                        Toast.makeText(
                                            this@ArNavigationActivity,
                                            s.sessionFailed(e.message ?: ""),
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
                        strings         = s,
                        webGuidance     = webGuidance,
                        onClose         = { finish() },
                        onFallbackToGps = { viewModel.fallbackToGps() },
                        onRealign       = { viewModel.requestRealign() }
                    )
                    // Plans détectés affichés pendant l'ancrage (ils aident à viser le
                    // sol), masqués une fois le tracé posé
                    LaunchedEffect(state.groundAnchored, state.aimFloor) {
                        try { arView?.planeRenderer?.isEnabled = !state.groundAnchored || state.aimFloor }
                        catch (e: Exception) { Log.w(TAG, "planeRenderer: ${e.message}") }
                    }
                }
            }
        }

        // FIX : watchdog qui vérifie après 8s qu'on a bien reçu des frames ARCore.
        // Si sessionUpdateCount = 0, ARCore n'a pas démarré → diagnostic explicite.
        // Délai 8s pour laisser le temps au routing OSRM + initialisation ARCore.
        lifecycleScope.launch {
            kotlinx.coroutines.delay(8000)
            if (isFinishing || lifecycle.currentState == Lifecycle.State.DESTROYED) return@launch
            val count = sessionUpdateCount.get()
            if (count == 0) {
                Log.e(TAG, "Aucun onSessionUpdated reçu après 8s — ARCore ne démarre pas")
                // Pas de toast : le HUD affiche la cause et quoi faire (FallbackReason.NO_FRAMES)
                viewModel.onArCoreSilent()
            } else {
                Log.d(TAG, "Watchdog OK : $count frames ARCore reçus en 8s")
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

    // Vérifier qu'ARCore est installé et à jour avant de lancer la navigation.
    // Avant : UNKNOWN_CHECKING (réponse transitoire, fréquente au premier appel)
    // tombait dans « non supporté » et fermait l'activité ; après une demande
    // d'installation, rien ne relançait la nav au retour → écran figé.
    private fun checkArCoreAvailability(onAvailable: () -> Unit) {
        try {
            val av = ArCoreApk.getInstance().checkAvailability(this)
            when {
                av == ArCoreApk.Availability.SUPPORTED_INSTALLED -> onAvailable()
                av == ArCoreApk.Availability.SUPPORTED_APK_TOO_OLD ||
                av == ArCoreApk.Availability.SUPPORTED_NOT_INSTALLED -> requestArCoreInstall(onAvailable)
                av.isTransient && availabilityTries++ < 25 ->
                    mainHandler.postDelayed({ checkArCoreAvailability(onAvailable) }, 200)
                av.isTransient -> onAvailable()   // toujours indéterminé après 5 s : on tente
                else -> {
                    Toast.makeText(this, s.arcoreUnsupported(av.toString()), Toast.LENGTH_LONG).show()
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

    private fun requestArCoreInstall(onAvailable: () -> Unit) {
        try {
            when (ArCoreApk.getInstance().requestInstall(this, !installRequested)) {
                ArCoreApk.InstallStatus.INSTALLED -> {
                    installRequested = false; afterInstall = null
                    onAvailable()
                }
                ArCoreApk.InstallStatus.INSTALL_REQUESTED -> {
                    // Le Play Store s'ouvre ; la suite se fait dans onResume
                    installRequested = true; afterInstall = onAvailable
                }
            }
        } catch (e: Exception) {
            // Installation refusée par l'utilisateur ou impossible
            Log.e(TAG, "ARCore install request failed", e)
            Toast.makeText(this, s.arcoreMissing, Toast.LENGTH_LONG).show()
            finish()
        }
    }

    override fun onResume() {
        super.onResume()
        if (installRequested) afterInstall?.let { requestArCoreInstall(it) }
        sensorManager.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)?.let {
            sensorManager.registerListener(this, it, SensorManager.SENSOR_DELAY_GAME)
        } ?: Log.w(TAG, "Pas de capteur de rotation : pas de boussole")
    }

    override fun onPause() {
        super.onPause()
        sensorManager.unregisterListener(this)
        viewModel.onCompass(null)
    }

    override fun onSensorChanged(event: SensorEvent) {
        if (event.sensor.type != Sensor.TYPE_ROTATION_VECTOR) return
        SensorManager.getRotationMatrixFromVector(rotationMatrix, event.values)
        for (i in 0 until 9) rotationD[i] = rotationMatrix[i].toDouble()
        GroundGeo.cameraHeadingFromRotationMatrix(rotationD)?.let { viewModel.onCompass(it) }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {
        if (accuracy <= SensorManager.SENSOR_STATUS_ACCURACY_LOW) Log.w(TAG, "Boussole peu fiable (précision $accuracy)")
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
        if (com.silexperience.velohnav.BuildConfig.DEBUG) Log.d(TAG, "startNavigation → $pendingDestLat, $pendingDestLng")
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
