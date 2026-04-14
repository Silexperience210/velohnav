package com.silexperience.velohnav.ar

import android.annotation.SuppressLint
import android.app.Application
import android.util.Log
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.ar.core.Anchor
import com.google.ar.core.Earth
import com.google.ar.core.Frame
import io.github.sceneview.ar.ARSceneView
import io.github.sceneview.ar.node.AnchorNode
import io.github.sceneview.model.Model
import io.github.sceneview.node.ModelNode
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import com.silexperience.velohnav.BuildConfig

enum class NavStatus { IDLE, LOCATING, ROUTING, LOCALIZING, NAVIGATING, ARRIVED, ERROR }

data class NavState(
    val status: NavStatus = NavStatus.IDLE,
    val currentStep: NavigationStep? = null,
    val stepIndex: Int = 0,
    val totalSteps: Int = 0,
    val distanceToNextTurnMeters: Double = 0.0,
    val totalRemainingMeters: Int = 0,
    val etaSeconds: Int = 0,
    val vpsAccuracy: VpsAccuracy? = null,
    val destName: String = "",
    val errorMessage: String? = null
)

class ArNavigationViewModel(application: Application) : AndroidViewModel(application) {
    private val TAG = "ArNavViewModel"
    private val _state = MutableStateFlow(NavState())
    val navState: StateFlow<NavState> = _state.asStateFlow()

    private val geo = GeospatialManager()
    private val routeManager = RouteManager(BuildConfig.MAPS_API_KEY)
    private val fusedLocation = LocationServices.getFusedLocationProviderClient(application)
    private var arView: ARSceneView? = null
    private var route: NavigationRoute? = null
    private var currentStepIdx = 0
    private val arrowNodes = mutableMapOf<Int, AnchorNode>()
    // FIX SceneView 2.x : loadModelInstance → loadModelAsync retourne un ModelInstance directement.
    // On stocke l'asset GLB pour créer des instances supplémentaires avec createInstance().
    private var modelAsset: io.github.sceneview.model.Model? = null
    private var vpsReady = false

    fun initializeNavigation(arSceneView: ARSceneView, destLat: Double, destLng: Double, destName: String, travelMode: String) {
        arView = arSceneView
        _state.value = _state.value.copy(status = NavStatus.LOCATING, destName = destName)
        viewModelScope.launch {
            try {
                // FIX : loadModelInstance → loadModelAsync (SceneView 2.x)
                modelAsset = arSceneView.modelLoader.loadModel("models/arrow_navigation.glb")
            } catch (e: Exception) { Log.e(TAG, "GLB load error", e) }
        }
        viewModelScope.launch { locateAndRoute(destLat, destLng, travelMode) }
    }

    @SuppressLint("MissingPermission")
    private suspend fun locateAndRoute(dLat: Double, dLng: Double, mode: String) {
        try {
            val loc = fusedLocation.getCurrentLocation(Priority.PRIORITY_HIGH_ACCURACY, null).await()
                ?: return setState(NavStatus.ERROR, "GPS indisponible")
            _state.value = _state.value.copy(status = NavStatus.ROUTING)
            routeManager.fetchRoute(loc.latitude, loc.longitude, dLat, dLng, mode)
                .onSuccess { r ->
                    route = r
                    _state.value = _state.value.copy(status = NavStatus.LOCALIZING,
                        totalSteps = r.steps.size, totalRemainingMeters = r.totalDistanceMeters,
                        etaSeconds = r.totalDurationSeconds, currentStep = r.steps.firstOrNull())
                }
                .onFailure { setState(NavStatus.ERROR, it.message ?: "Erreur itinéraire") }
        } catch (e: Exception) { setState(NavStatus.ERROR, e.message ?: "Erreur GPS") }
    }

    fun onEarthTracking(earth: Earth, frame: Frame) {
        geo.onFrame(earth, frame)
        val acc = geo.accuracy.value ?: return
        _state.value = _state.value.copy(vpsAccuracy = acc)
        val r = route ?: return
        if (!vpsReady && acc.isReliable && _state.value.status == NavStatus.LOCALIZING) {
            vpsReady = true
            placeArrows(earth, r, currentStepIdx, minOf(5, r.steps.size))
            _state.value = _state.value.copy(status = NavStatus.NAVIGATING)
        }
        if (_state.value.status == NavStatus.NAVIGATING) updateProgress(earth, r)
    }

    private fun placeArrows(earth: Earth, r: NavigationRoute, from: Int, count: Int) {
        for (i in from until from + count) {
            if (!arrowNodes.containsKey(i)) placeArrow(earth, r, i)
        }
    }

    private fun placeArrow(earth: Earth, r: NavigationRoute, idx: Int) {
        val step = r.steps.getOrNull(idx) ?: return
        val next = r.steps.getOrNull(idx + 1)
        val bearing = if (next != null) GeospatialManager.computeBearing(step.endLat, step.endLng, next.startLat, next.startLng)
                      else GeospatialManager.computeBearing(step.startLat, step.startLng, step.endLat, step.endLng)
        val placed = geo.placeArrowAnchor(earth, TerrainAnchorData(idx, step.endLat, step.endLng, bearing))
        placed.anchor?.let { createNode(it, idx) }
    }

    private fun createNode(anchor: Anchor, idx: Int) {
        val view = arView ?: return
        viewModelScope.launch {
            val anchorNode = AnchorNode(engine = view.engine, anchor = anchor)
            // FIX SceneView 2.x : createInstance(asset) — pas createInstance(modelInstance)
            modelAsset?.let { asset ->
                val instance = view.modelLoader.createInstance(asset)
                if (instance != null) {
                    anchorNode.addChildNode(ModelNode(instance, scaleToUnits = 0.9f))
                }
            }
            view.addChildNode(anchorNode)
            arrowNodes[idx] = anchorNode
        }
    }

    private fun updateProgress(earth: Earth, r: NavigationRoute) {
        if (currentStepIdx >= r.steps.size) { _state.value = _state.value.copy(status = NavStatus.ARRIVED); return }
        val pose = earth.cameraGeospatialPose
        val step = r.steps[currentStepIdx]
        val dist = GeospatialManager.distanceMeters(pose.latitude, pose.longitude, step.endLat, step.endLng)
        if (dist < 12.0) { advance(earth, r); return }
        _state.value = _state.value.copy(currentStep = step, stepIndex = currentStepIdx,
            distanceToNextTurnMeters = dist,
            totalRemainingMeters = r.steps.drop(currentStepIdx).sumOf { it.distanceMeters },
            etaSeconds = r.steps.drop(currentStepIdx).sumOf { it.durationSeconds })
    }

    private fun advance(earth: Earth, r: NavigationRoute) {
        arrowNodes.remove(currentStepIdx)?.let { arView?.removeChildNode(it) }
        currentStepIdx++
        if (currentStepIdx >= r.steps.size) { _state.value = _state.value.copy(status = NavStatus.ARRIVED); return }
        val next = currentStepIdx + 4
        if (next < r.steps.size) placeArrow(earth, r, next)
    }

    private fun setState(status: NavStatus, msg: String? = null) {
        _state.value = _state.value.copy(status = status, errorMessage = msg)
    }

    fun cleanup() {
        arrowNodes.values.forEach { arView?.removeChildNode(it) }
        arrowNodes.clear(); geo.cleanup(); modelAsset = null; arView = null
    }
    override fun onCleared() { super.onCleared(); cleanup() }
}
