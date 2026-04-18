package com.silexperience.velohnav.ar

import android.annotation.SuppressLint
import android.app.Application
import android.util.Log
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.ar.core.Earth
import com.google.ar.core.Frame
import com.google.ar.core.TrackingState
import io.github.sceneview.ar.ARSceneView
import io.github.sceneview.ar.node.AnchorNode
import io.github.sceneview.model.Model
import io.github.sceneview.node.ModelNode
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

enum class NavStatus { IDLE, LOCATING, ROUTING, LOCALIZING, NAVIGATING, ARRIVED, ERROR }

data class NavState(
    val status: NavStatus        = NavStatus.IDLE,
    val currentStep: NavigationStep? = null,
    val stepIndex: Int           = 0,
    val totalSteps: Int          = 0,
    val distanceToNextTurnMeters: Double = 0.0,
    val totalRemainingMeters: Int = 0,
    val etaSeconds: Int          = 0,
    val vpsAccuracy: VpsAccuracy? = null,
    val destName: String         = "",
    val errorMessage: String?    = null
)

class ArNavigationViewModel(application: Application) : AndroidViewModel(application) {
    private val TAG = "ArNavViewModel"

    private val _state = MutableStateFlow(NavState())
    val navState: StateFlow<NavState> = _state.asStateFlow()

    private val geo = GeospatialManager()
    private var routeManager: RouteManager = RouteManager("")
    private val fusedLocation = LocationServices.getFusedLocationProviderClient(application)

    // FIX : arView n'est PLUS stocké ici — fuite mémoire lors des rotations écran.
    // ARSceneView est passé en paramètre à chaque méthode qui en a besoin,
    // sauf pour cleanup() où l'Activity passe explicitement la référence courante.
    private var cleanupView: ARSceneView? = null  // référence unique pour cleanup

    private var route: NavigationRoute? = null
    private var currentStepIdx = 0
    private val arrowNodes = java.util.concurrent.ConcurrentHashMap<Int, AnchorNode>()
    private var modelAsset: Model? = null
    private var vpsReady = false
    private var navigationJob: Job? = null
    private var lastEarth: Earth? = null

    // ── Initialisation ─────────────────────────────────────────────
    fun initializeNavigation(
        arSceneView: ARSceneView,
        destLat: Double, destLng: Double,
        destName: String, travelMode: String,
        mapsKey: String = ""
    ) {
        navigationJob?.cancel()
        // Stocker uniquement pour cleanup — pas pour les opérations de rendu
        cleanupView = arSceneView
        routeManager = RouteManager(mapsKey)
        vpsReady = false
        currentStepIdx = 0
        arrowNodes.clear()
        lastEarth = null

        _state.value = NavState(status = NavStatus.LOCATING, destName = destName)

        viewModelScope.launch {
            try {
                modelAsset = arSceneView.modelLoader.loadModel("models/arrow_navigation.glb")
                Log.d(TAG, "GLB chargé")
            } catch (e: Exception) {
                Log.w(TAG, "GLB load failed (nav textuelle): ${e.message}")
            }
        }

        navigationJob = viewModelScope.launch {
            locateAndRoute(destLat, destLng, travelMode)
        }
    }

    // ── GPS + routing ───────────────────────────────────────────────
    @SuppressLint("MissingPermission")
    private suspend fun locateAndRoute(dLat: Double, dLng: Double, mode: String) {
        try {
            // Timeout 10s — évite blocage indéfini si GPS ne fix jamais (indoor, tunnel...)
            val loc = withTimeoutOrNull(10_000) {
                withContext(Dispatchers.IO) {
                    fusedLocation.getCurrentLocation(Priority.PRIORITY_HIGH_ACCURACY, null).await()
                }
            } ?: return setState(NavStatus.ERROR, "GPS indisponible (timeout 10s) — sortez en extérieur")

            _state.value = _state.value.copy(status = NavStatus.ROUTING)

            var lastError: Throwable? = null
            for (attempt in 0..2) {
                if (attempt > 0) delay(attempt * 2000L)
                routeManager.fetchRoute(loc.latitude, loc.longitude, dLat, dLng, mode)
                    .onSuccess { r ->
                        route = r
                        _state.value = _state.value.copy(
                            status               = NavStatus.LOCALIZING,
                            totalSteps           = r.steps.size,
                            totalRemainingMeters = r.totalDistanceMeters,
                            etaSeconds           = r.totalDurationSeconds,
                            currentStep          = r.steps.firstOrNull()
                        )
                        Log.i(TAG, "Route: ${r.steps.size} étapes, ${r.totalDistanceMeters}m")
                        return
                    }
                    .onFailure { lastError = it }
            }
            setState(NavStatus.ERROR, "Itinéraire : ${lastError?.message}")
        } catch (e: Exception) {
            setState(NavStatus.ERROR, "GPS : ${e.message}")
        }
    }

    // ── Appelé depuis main thread (via mainHandler.post dans Activity) ──
    // arView passé en paramètre — jamais stocké
    fun onEarthTracking(earth: Earth, frame: Frame, arView: ARSceneView) {
        lastEarth = earth
        geo.onFrame(earth, frame)
        val acc = geo.accuracy.value ?: return
        _state.value = _state.value.copy(vpsAccuracy = acc)

        val r = route ?: return
        val st = _state.value.status

        if (!vpsReady && acc.isReliable && st == NavStatus.LOCALIZING) {
            Log.i(TAG, "VPS fiable (±${acc.horizontalMeters}m) — démarrage navigation")
            vpsReady = true
            placeArrows(arView, earth, r, 0, minOf(3, r.steps.size))
            _state.value = _state.value.copy(status = NavStatus.NAVIGATING)
        }

        if (st == NavStatus.NAVIGATING || _state.value.status == NavStatus.NAVIGATING) {
            updateProgress(arView, earth, r)
        }
    }

    // ── Placement flèches ────────────────────────────────────────────
    private fun placeArrows(arView: ARSceneView, earth: Earth, r: NavigationRoute, from: Int, count: Int) {
        for (i in from until (from + count).coerceAtMost(r.steps.size)) {
            if (!arrowNodes.containsKey(i)) placeArrow(arView, earth, r, i)
        }
    }

    private fun placeArrow(arView: ARSceneView, earth: Earth, r: NavigationRoute, idx: Int) {
        val step = r.steps.getOrNull(idx) ?: return
        val next = r.steps.getOrNull(idx + 1)
        val bearing = if (next != null)
            GeospatialManager.computeBearing(step.endLat, step.endLng, next.startLat, next.startLng)
        else
            GeospatialManager.computeBearing(step.startLat, step.startLng, step.endLat, step.endLng)

        val placed = geo.placeArrowAnchor(earth, TerrainAnchorData(idx, step.endLat, step.endLng, bearing))
        val anchor = placed.anchor ?: return

        // Main thread — SceneView 2.2.1 accepte addChildNode sur le main thread
        viewModelScope.launch {
            try {
                val anchorNode = AnchorNode(engine = arView.engine, anchor = anchor)
                modelAsset?.let { asset ->
                    val instance = arView.modelLoader.createInstance(asset)
                    if (instance != null)
                        anchorNode.addChildNode(ModelNode(modelInstance = instance, scaleToUnits = 0.8f))
                }
                arView.addChildNode(anchorNode)
                arrowNodes[idx] = anchorNode
                Log.d(TAG, "Flèche step=$idx")
            } catch (e: Exception) {
                Log.e(TAG, "Flèche $idx : ${e.message}")
            }
        }
    }

    // ── Progression ─────────────────────────────────────────────────
    private fun updateProgress(arView: ARSceneView, earth: Earth, r: NavigationRoute) {
        if (currentStepIdx >= r.steps.size) {
            _state.value = _state.value.copy(status = NavStatus.ARRIVED); return
        }
        if (earth.trackingState != TrackingState.TRACKING) return

        val pose = earth.cameraGeospatialPose
        val step = r.steps[currentStepIdx]
        val dist = GeospatialManager.distanceMeters(pose.latitude, pose.longitude, step.endLat, step.endLng)

        if (dist < 15.0) { advance(arView, earth, r); return }

        _state.value = _state.value.copy(
            currentStep              = step,
            stepIndex                = currentStepIdx,
            distanceToNextTurnMeters = dist,
            totalRemainingMeters     = r.steps.drop(currentStepIdx).sumOf { it.distanceMeters },
            etaSeconds               = r.steps.drop(currentStepIdx).sumOf { it.durationSeconds }
        )
    }

    private fun advance(arView: ARSceneView, earth: Earth, r: NavigationRoute) {
        arrowNodes.remove(currentStepIdx)?.let { node ->
            viewModelScope.launch {
                arView.removeChildNode(node)
                try { node.destroy() } catch (e: Exception) { Log.w(TAG, "destroy: ${e.message}") }
            }
        }
        currentStepIdx++
        if (currentStepIdx >= r.steps.size) {
            _state.value = _state.value.copy(status = NavStatus.ARRIVED)
            Log.i(TAG, "Destination atteinte !")
            return
        }
        val nextToLoad = currentStepIdx + 3
        if (nextToLoad < r.steps.size) placeArrow(arView, earth, r, nextToLoad)
    }

    // ── Retry ────────────────────────────────────────────────────────
    fun retry(arView: ARSceneView, destLat: Double, destLng: Double, travelMode: String) {
        navigationJob?.cancel()
        vpsReady = false
        cleanupView = arView
        _state.value = _state.value.copy(status = NavStatus.LOCATING, errorMessage = null)
        navigationJob = viewModelScope.launch { locateAndRoute(destLat, destLng, travelMode) }
    }

    // ── Cleanup — appelé depuis Activity.onDestroy avec la référence courante ──
    fun cleanup(arViewFromActivity: ARSceneView?) {
        navigationJob?.cancel()
        val view = arViewFromActivity ?: cleanupView
        view?.let { v ->
            arrowNodes.values.forEach { node ->
                try {
                    v.removeChildNode(node)
                    node.destroy()
                } catch (e: Exception) {
                    Log.w(TAG, "cleanup node: ${e.message}")
                }
            }
        }
        arrowNodes.clear()
        geo.cleanup()
        modelAsset = null
        cleanupView = null
        lastEarth = null
        route = null
    }

    private fun setState(status: NavStatus, msg: String? = null) {
        _state.value = _state.value.copy(status = status, errorMessage = msg)
        if (msg != null) Log.e(TAG, msg)
    }

    override fun onCleared() { super.onCleared(); cleanup(null) }
}
