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

enum class NavStatus { IDLE, LOCATING, ROUTING, LOCALIZING, NAVIGATING, ARRIVED, ERROR }

data class NavState(
    val status: NavStatus      = NavStatus.IDLE,
    val currentStep: NavigationStep? = null,
    val stepIndex: Int         = 0,
    val totalSteps: Int        = 0,
    val distanceToNextTurnMeters: Double = 0.0,
    val totalRemainingMeters: Int  = 0,
    val etaSeconds: Int        = 0,
    val vpsAccuracy: VpsAccuracy? = null,
    val destName: String       = "",
    val errorMessage: String?  = null
)

class ArNavigationViewModel(application: Application) : AndroidViewModel(application) {
    private val TAG = "ArNavViewModel"

    private val _state = MutableStateFlow(NavState())
    val navState: StateFlow<NavState> = _state.asStateFlow()

    private val geo = GeospatialManager()
    private var routeManager: RouteManager = RouteManager("")
    private val fusedLocation = LocationServices.getFusedLocationProviderClient(application)

    private var arView: ARSceneView? = null
    private var route: NavigationRoute? = null
    private var currentStepIdx = 0
    private val arrowNodes = java.util.concurrent.ConcurrentHashMap<Int, AnchorNode>()
    private var modelAsset: Model? = null
    private var vpsReady = false
    private var navigationJob: Job? = null

    // Dernier Earth connu — pour retry sans attendre le prochain frame
    private var lastEarth: Earth? = null

    // ── Initialisation ───────────────────────────────────────────
    fun initializeNavigation(
        arSceneView: ARSceneView,
        destLat: Double, destLng: Double,
        destName: String, travelMode: String,
        mapsKey: String = ""
    ) {
        navigationJob?.cancel()
        arView = arSceneView
        routeManager = RouteManager(mapsKey)
        vpsReady = false
        currentStepIdx = 0
        arrowNodes.clear()
        lastEarth = null

        _state.value = NavState(status = NavStatus.LOCATING, destName = destName)

        // Charger le modèle GLB en arrière-plan
        viewModelScope.launch {
            try {
                // loadModel() est déjà une suspend function qui gère son propre dispatcher
                modelAsset = arSceneView.modelLoader.loadModel("models/arrow_navigation.glb")
            } catch (e: Exception) {
                Log.w(TAG, "GLB load failed (navigation sans modèle): ${e.message}")
                // Ne pas crasher — navigation textuelle reste disponible
            }
        }

        navigationJob = viewModelScope.launch {
            locateAndRoute(destLat, destLng, travelMode)
        }
    }

    // ── GPS + routing avec retry backoff ────────────────────────
    @SuppressLint("MissingPermission")
    private suspend fun locateAndRoute(dLat: Double, dLng: Double, mode: String) {
        try {
            val loc = withContext(Dispatchers.IO) {
                fusedLocation.getCurrentLocation(Priority.PRIORITY_HIGH_ACCURACY, null).await()
            } ?: return setState(NavStatus.ERROR, "GPS indisponible — vérifiez la localisation")

            _state.value = _state.value.copy(status = NavStatus.ROUTING)

            var lastError: Throwable? = null
            for (attempt in 0..2) {
                if (attempt > 0) delay(attempt * 2000L)
                routeManager.fetchRoute(loc.latitude, loc.longitude, dLat, dLng, mode)
                    .onSuccess { r ->
                        route = r
                        _state.value = _state.value.copy(
                            status       = NavStatus.LOCALIZING,
                            totalSteps   = r.steps.size,
                            totalRemainingMeters = r.totalDistanceMeters,
                            etaSeconds   = r.totalDurationSeconds,
                            currentStep  = r.steps.firstOrNull()
                        )
                        Log.i(TAG, "Route obtenue : ${r.steps.size} étapes, ${r.totalDistanceMeters}m")
                        return
                    }
                    .onFailure { lastError = it }
            }
            setState(NavStatus.ERROR, "Itinéraire indisponible : ${lastError?.message}")
        } catch (e: Exception) {
            setState(NavStatus.ERROR, "Erreur GPS : ${e.message}")
        }
    }

    // ── Appelé depuis le main thread (via mainHandler.post) ─────
    // FIX : plus de GL thread ici, on est sur le main thread
    fun onEarthTracking(earth: Earth, frame: Frame) {
        lastEarth = earth
        geo.onFrame(earth, frame)
        val acc = geo.accuracy.value ?: return
        _state.value = _state.value.copy(vpsAccuracy = acc)

        val r = route ?: return
        val st = _state.value.status

        // Transition LOCALIZING → NAVIGATING dès que VPS est fiable
        if (!vpsReady && acc.isReliable && st == NavStatus.LOCALIZING) {
            Log.i(TAG, "VPS fiable — démarrage navigation (±${acc.horizontalMeters}m)")
            vpsReady = true
            // Placer les 3 premières flèches (sur le main thread = OK)
            placeArrows(earth, r, 0, minOf(3, r.steps.size))
            _state.value = _state.value.copy(status = NavStatus.NAVIGATING)
        }

        if (st == NavStatus.NAVIGATING || _state.value.status == NavStatus.NAVIGATING) {
            updateProgress(earth, r)
        }
    }

    // ── Placement des ancres ─────────────────────────────────────
    private fun placeArrows(earth: Earth, r: NavigationRoute, from: Int, count: Int) {
        for (i in from until (from + count).coerceAtMost(r.steps.size)) {
            if (!arrowNodes.containsKey(i)) placeArrow(earth, r, i)
        }
    }

    private fun placeArrow(earth: Earth, r: NavigationRoute, idx: Int) {
        val step = r.steps.getOrNull(idx) ?: return
        val next = r.steps.getOrNull(idx + 1)
        val bearing = if (next != null)
            GeospatialManager.computeBearing(step.endLat, step.endLng, next.startLat, next.startLng)
        else
            GeospatialManager.computeBearing(step.startLat, step.startLng, step.endLat, step.endLng)

        val placed = geo.placeArrowAnchor(earth, TerrainAnchorData(idx, step.endLat, step.endLng, bearing))
        val anchor = placed.anchor ?: return

        // createNode sur le main thread dans viewModelScope — correct
        viewModelScope.launch {
            val view = arView ?: return@launch
            try {
                val anchorNode = AnchorNode(engine = view.engine, anchor = anchor)
                modelAsset?.let { asset ->
                    val instance = view.modelLoader.createInstance(asset)
                    if (instance != null) {
                        anchorNode.addChildNode(ModelNode(modelInstance = instance, scaleToUnits = 0.8f))
                    }
                }
                view.addChildNode(anchorNode)
                arrowNodes[idx] = anchorNode
                Log.d(TAG, "Flèche placée step=$idx")
            } catch (e: Exception) {
                Log.e(TAG, "Erreur placement flèche $idx: ${e.message}")
            }
        }
    }

    // ── Progression ──────────────────────────────────────────────
    private fun updateProgress(earth: Earth, r: NavigationRoute) {
        if (currentStepIdx >= r.steps.size) {
            _state.value = _state.value.copy(status = NavStatus.ARRIVED); return
        }
        // Vérifier que la session est toujours en tracking
        if (earth.trackingState != TrackingState.TRACKING) return

        val pose  = earth.cameraGeospatialPose
        val step  = r.steps[currentStepIdx]
        val dist  = GeospatialManager.distanceMeters(pose.latitude, pose.longitude, step.endLat, step.endLng)

        // Arrivée à moins de 15m de l'étape courante → avancer
        if (dist < 15.0) { advance(earth, r); return }

        _state.value = _state.value.copy(
            currentStep              = step,
            stepIndex                = currentStepIdx,
            distanceToNextTurnMeters = dist,
            totalRemainingMeters     = r.steps.drop(currentStepIdx).sumOf { it.distanceMeters },
            etaSeconds               = r.steps.drop(currentStepIdx).sumOf { it.durationSeconds }
        )
    }

    private fun advance(earth: Earth, r: NavigationRoute) {
        arrowNodes.remove(currentStepIdx)?.let { node ->
            viewModelScope.launch {
                arView?.removeChildNode(node)
                try { node.destroy() } catch (e: Exception) { Log.w(TAG, "destroy advance: ${e.message}") }
            }
        }
        currentStepIdx++
        if (currentStepIdx >= r.steps.size) {
            _state.value = _state.value.copy(status = NavStatus.ARRIVED)
            Log.i(TAG, "Destination atteinte !")
            return
        }
        // Pré-charger la flèche suivante
        val nextToLoad = currentStepIdx + 3
        if (nextToLoad < r.steps.size) placeArrow(earth, r, nextToLoad)
    }

    // ── Retry public ─────────────────────────────────────────────
    fun retry(destLat: Double, destLng: Double, travelMode: String) {
        navigationJob?.cancel()
        vpsReady = false
        _state.value = _state.value.copy(status = NavStatus.LOCATING, errorMessage = null)
        navigationJob = viewModelScope.launch { locateAndRoute(destLat, destLng, travelMode) }
    }

    // ── Cleanup ──────────────────────────────────────────────────
    fun cleanup() {
        navigationJob?.cancel()
        viewModelScope.launch {
            arrowNodes.values.forEach { node ->
                arView?.removeChildNode(node)
                try { node.destroy() } catch (e: Exception) { Log.w(TAG, "destroy: ${e.message}") }
            }
            arrowNodes.clear()
        }
        geo.cleanup()
        modelAsset = null
        arView = null
        lastEarth = null
    }

    private fun setState(status: NavStatus, msg: String? = null) {
        _state.value = _state.value.copy(status = status, errorMessage = msg)
        if (msg != null) Log.e(TAG, msg)
    }

    override fun onCleared() { super.onCleared(); cleanup() }
}
