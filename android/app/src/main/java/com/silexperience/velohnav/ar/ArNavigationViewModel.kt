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
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

enum class NavStatus { IDLE, LOCATING, ROUTING, LOCALIZING, NAVIGATING, ARRIVED, ERROR }

// Mode de tracking : VPS (haute précision) ou GPS dégradé (fallback)
enum class TrackingMode { VPS, GPS_FALLBACK }

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
    val errorMessage: String?    = null,
    // Compte à rebours avant fallback GPS si VPS ne converge pas (secondes)
    val vpsTimeoutSecondsLeft: Int = 0,
    // Mode actif — basculé en GPS_FALLBACK si VPS timeout
    val trackingMode: TrackingMode = TrackingMode.VPS,
    // Meilleure précision VPS observée — pour debug/UX
    val bestHorizontalAccuracy: Double = Double.MAX_VALUE
)

class ArNavigationViewModel(application: Application) : AndroidViewModel(application) {
    private val TAG = "ArNavViewModel"

    // ── Constantes VPS ────────────────────────────────────────────
    // Timeout : si la VPS ne converge pas en 25s, on bascule en GPS dégradé.
    // Couvre les cas réels : zone sans couverture Street View, ciel obstrué,
    // intérieur (parking, tunnel), bâtiments trop proches/uniformes.
    private val VPS_TIMEOUT_SECONDS = 25
    // Seuil de précision "fiable" — relâché vs avant (5m → 8m horiz, 15° → 20° heading)
    // Permet de démarrer la nav plus tôt dans les zones à VPS médiocre.
    private val VPS_RELIABLE_HORIZ_M  = 8.0
    private val VPS_RELIABLE_HEAD_DEG = 20.0
    // Seuil "acceptable" — fallback graceful : si on reste bloqué mais qu'on a
    // une précision raisonnable (<15m), on démarre quand même la nav.
    private val VPS_ACCEPTABLE_HORIZ_M = 15.0

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
    private var vpsTimeoutJob: Job? = null   // job de timeout VPS — annulé dès que vpsReady
    private var lastEarth: Earth? = null
    // Position GPS de fallback (mise à jour si VPS down) — utilisée pour avancer
    // dans les étapes même sans tracking ARCore Geospatial fiable.
    @Volatile private var lastGpsLat: Double = 0.0
    @Volatile private var lastGpsLng: Double = 0.0
    private var gpsWatchJob: Job? = null

    // ── Initialisation ─────────────────────────────────────────────
    fun initializeNavigation(
        arSceneView: ARSceneView,
        destLat: Double, destLng: Double,
        destName: String, travelMode: String,
        mapsKey: String = ""
    ) {
        navigationJob?.cancel()
        vpsTimeoutJob?.cancel()
        gpsWatchJob?.cancel()
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

            // Mémoriser GPS pour fallback éventuel si VPS échoue
            lastGpsLat = loc.latitude
            lastGpsLng = loc.longitude

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
                            currentStep          = r.steps.firstOrNull(),
                            vpsTimeoutSecondsLeft = VPS_TIMEOUT_SECONDS
                        )
                        Log.i(TAG, "Route: ${r.steps.size} étapes, ${r.totalDistanceMeters}m")
                        // Démarrer le timeout VPS et le watcher GPS de fallback
                        startVpsTimeout(dLat, dLng, mode)
                        startGpsWatcher()
                        return
                    }
                    .onFailure { lastError = it }
            }
            setState(NavStatus.ERROR, "Itinéraire : ${lastError?.message}")
        } catch (e: Exception) {
            setState(NavStatus.ERROR, "GPS : ${e.message}")
        }
    }

    // ── Timeout VPS + fallback GPS ─────────────────────────────────
    // Si la VPS ne devient pas fiable en VPS_TIMEOUT_SECONDS, on bascule
    // en mode GPS dégradé pour ne pas laisser l'utilisateur bloqué.
    private fun startVpsTimeout(dLat: Double, dLng: Double, mode: String) {
        vpsTimeoutJob?.cancel()
        vpsTimeoutJob = viewModelScope.launch {
            for (sec in VPS_TIMEOUT_SECONDS downTo 1) {
                if (vpsReady) return@launch
                _state.value = _state.value.copy(vpsTimeoutSecondsLeft = sec)
                delay(1000)
            }
            // Timeout atteint — VPS ne convergera probablement pas.
            if (!vpsReady) {
                val best = _state.value.bestHorizontalAccuracy
                Log.w(TAG, "VPS timeout après ${VPS_TIMEOUT_SECONDS}s — best=${best}m → fallback GPS")
                fallbackToGps()
            }
        }
    }

    // Bascule manuelle (bouton "passer en GPS") ou auto sur timeout.
    fun fallbackToGps() {
        if (vpsReady) return  // déjà en nav, rien à faire
        val r = route ?: return setState(NavStatus.ERROR, "Itinéraire perdu")
        Log.i(TAG, "Fallback GPS — démarrage navigation dégradée")
        vpsReady = true  // débloque updateProgress
        vpsTimeoutJob?.cancel()
        _state.value = _state.value.copy(
            status = NavStatus.NAVIGATING,
            trackingMode = TrackingMode.GPS_FALLBACK,
            vpsTimeoutSecondsLeft = 0,
            currentStep = r.steps.firstOrNull()
        )
    }

    // Watcher GPS — alimente lastGpsLat/Lng en continu pour le mode fallback
    // et pour updateProgressGps (calcul distances sans Earth.cameraGeospatialPose).
    @SuppressLint("MissingPermission")
    private fun startGpsWatcher() {
        gpsWatchJob?.cancel()
        gpsWatchJob = viewModelScope.launch {
            while (isActive) {
                try {
                    withContext(Dispatchers.IO) {
                        fusedLocation.getCurrentLocation(Priority.PRIORITY_HIGH_ACCURACY, null).await()
                    }?.let {
                        lastGpsLat = it.latitude
                        lastGpsLng = it.longitude
                        // Si on est en mode fallback, on met à jour la progression depuis le GPS
                        if (_state.value.trackingMode == TrackingMode.GPS_FALLBACK &&
                            _state.value.status == NavStatus.NAVIGATING) {
                            updateProgressGps()
                        }
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "GPS watch: ${e.message}")
                }
                delay(2000)  // poll toutes les 2s
            }
        }
    }

    // ── Appelé depuis main thread (via mainHandler.post dans Activity) ──
    // arView passé en paramètre — jamais stocké
    fun onEarthTracking(earth: Earth, frame: Frame, arView: ARSceneView) {
        lastEarth = earth
        geo.onFrame(earth, frame)
        val acc = geo.accuracy.value ?: return

        // Suivre la meilleure précision observée (debug + UX)
        val bestSoFar = minOf(_state.value.bestHorizontalAccuracy, acc.horizontalMeters)
        _state.value = _state.value.copy(vpsAccuracy = acc, bestHorizontalAccuracy = bestSoFar)

        val r = route ?: return
        val st = _state.value.status

        // Critère "fiable" — seuils relâchés (8m / 20°) plus permissifs que le défaut.
        val reliable = acc.horizontalMeters < VPS_RELIABLE_HORIZ_M &&
                       acc.headingDegrees   < VPS_RELIABLE_HEAD_DEG

        // Critère "acceptable" — fallback graceful : si on plafonne à <15m
        // depuis quelques secondes, on démarre quand même la nav.
        val secondsLeft = _state.value.vpsTimeoutSecondsLeft
        val acceptable  = acc.horizontalMeters < VPS_ACCEPTABLE_HORIZ_M &&
                          secondsLeft < VPS_TIMEOUT_SECONDS / 2  // au moins 12s d'attente

        if (!vpsReady && st == NavStatus.LOCALIZING && (reliable || acceptable)) {
            Log.i(TAG, "VPS OK (±${acc.horizontalMeters}m, head ±${acc.headingDegrees}°, " +
                       "reliable=$reliable acceptable=$acceptable) — démarrage nav")
            vpsReady = true
            vpsTimeoutJob?.cancel()
            placeArrows(arView, earth, r, 0, minOf(3, r.steps.size))
            _state.value = _state.value.copy(
                status = NavStatus.NAVIGATING,
                trackingMode = TrackingMode.VPS,
                vpsTimeoutSecondsLeft = 0
            )
        }

        if (st == NavStatus.NAVIGATING || _state.value.status == NavStatus.NAVIGATING) {
            updateProgress(arView, earth, r)
        }
    }

    // ── Progression GPS (mode fallback) ────────────────────────────
    // Pas d'Earth fiable — on avance dans les étapes via lastGpsLat/Lng.
    // Pas de placement d'ancres ARCore : la nav est en mode "boussole + texte".
    private fun updateProgressGps() {
        val r = route ?: return
        if (currentStepIdx >= r.steps.size) {
            _state.value = _state.value.copy(status = NavStatus.ARRIVED); return
        }
        val step = r.steps[currentStepIdx]
        val dist = GeospatialManager.distanceMeters(lastGpsLat, lastGpsLng, step.endLat, step.endLng)

        if (dist < 20.0) {  // tolérance plus large en mode GPS (précision ±10m typique)
            currentStepIdx++
            if (currentStepIdx >= r.steps.size) {
                _state.value = _state.value.copy(status = NavStatus.ARRIVED)
                return
            }
        }

        _state.value = _state.value.copy(
            currentStep              = r.steps[currentStepIdx.coerceAtMost(r.steps.size - 1)],
            stepIndex                = currentStepIdx,
            distanceToNextTurnMeters = dist,
            totalRemainingMeters     = r.steps.drop(currentStepIdx).sumOf { it.distanceMeters },
            etaSeconds               = r.steps.drop(currentStepIdx).sumOf { it.durationSeconds }
        )
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
        vpsTimeoutJob?.cancel()
        gpsWatchJob?.cancel()
        vpsReady = false
        cleanupView = arView
        _state.value = _state.value.copy(
            status = NavStatus.LOCATING,
            errorMessage = null,
            trackingMode = TrackingMode.VPS,
            bestHorizontalAccuracy = Double.MAX_VALUE,
            vpsTimeoutSecondsLeft = 0
        )
        navigationJob = viewModelScope.launch { locateAndRoute(destLat, destLng, travelMode) }
    }

    // ── Cleanup — appelé depuis Activity.onDestroy avec la référence courante ──
    fun cleanup(arViewFromActivity: ARSceneView?) {
        navigationJob?.cancel()
        vpsTimeoutJob?.cancel()
        gpsWatchJob?.cancel()
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
