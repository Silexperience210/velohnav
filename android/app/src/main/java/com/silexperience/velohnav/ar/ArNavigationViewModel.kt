package com.silexperience.velohnav.ar

import android.app.Application
import android.util.Log
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.ar.core.Earth
import com.google.ar.core.Frame
import io.github.sceneview.ar.ARSceneView
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.tasks.await

enum class NavStatus { IDLE, LOCATING, ROUTING, LOCALIZING, NAVIGATING, ARRIVED, ERROR }
data class NavState(val status: NavStatus = NavStatus.IDLE, val currentStep: NavigationStep? = null, val stepIndex: Int = 0, val totalSteps: Int = 0, val distanceToNextTurnMeters: Double = 0.0, val totalRemainingMeters: Int = 0, val etaSeconds: Int = 0, val destName: String = "", val errorMessage: String? = null)

class ArNavigationViewModel(application: Application) : AndroidViewModel(application) {
    private val _state = MutableStateFlow(NavState())
    val navState: StateFlow<NavState> = _state.asStateFlow()
    private val geo = GeospatialManager()
    private lateinit var routeManager: RouteManager
    private val fusedLocation = LocationServices.getFusedLocationProviderClient(application)
    private var arView: ARSceneView? = null
    private var route: NavigationRoute? = null
    private var currentStepIdx = 0
    private var vpsReady = false
    private var navigationJob: Job? = null

    fun initializeNavigation(arSceneView: ARSceneView, destLat: Double, destLng: Double, destName: String, travelMode: String, mapsKey: String = "") {
        navigationJob?.cancel()
        arView = arSceneView
        routeManager = RouteManager(mapsKey)
        _state.value = NavState(status = NavStatus.LOCATING, destName = destName)
        navigationJob = viewModelScope.launch { locateAndRoute(destLat, destLng, travelMode) }
    }

    private suspend fun locateAndRoute(dLat: Double, dLng: Double, mode: String) {
        try {
            _state.value = _state.value.copy(status = NavStatus.ROUTING)
            val loc = withTimeoutOrNull(15000) { fusedLocation.getCurrentLocation(Priority.PRIORITY_HIGH_ACCURACY, null).await() } ?: fusedLocation.lastLocation.await()
            if (loc == null) { setState(NavStatus.ERROR, "GPS indisponible."); return }
            routeManager.fetchRoute(loc.latitude, loc.longitude, dLat, dLng, mode)
                .onSuccess { r ->
                    route = r
                    _state.value = _state.value.copy(status = NavStatus.LOCALIZING, totalSteps = r.steps.size, totalRemainingMeters = r.totalDistanceMeters, etaSeconds = r.totalDurationSeconds, currentStep = r.steps.firstOrNull())
                }
                .onFailure { setState(NavStatus.ERROR, it.message ?: "Erreur itinéraire") }
        } catch (e: Exception) { setState(NavStatus.ERROR, "GPS: ${e.message}") }
    }

    fun onEarthTracking(earth: Earth, frame: Frame) {
        if (!viewModelScope.isActive) return
        geo.onFrame(earth, frame)
        val acc = geo.accuracy.value ?: return
        _state.value = _state.value.copy(vpsAccuracy = acc)
        val r = route ?: return
        if (!vpsReady && acc.isReliable && _state.value.status == NavStatus.LOCALIZING) {
            vpsReady = true
            _state.value = _state.value.copy(status = NavStatus.NAVIGATING)
        }
        if (_state.value.status == NavStatus.NAVIGATING) updateProgress(earth, r)
    }

    private fun updateProgress(earth: Earth, r: NavigationRoute) {
        if (currentStepIdx >= r.steps.size) { _state.value = _state.value.copy(status = NavStatus.ARRIVED); return }
        val pose = earth.cameraGeospatialPose
        val step = r.steps[currentStepIdx]
        val dist = GeospatialManager.distanceMeters(pose.latitude, pose.longitude, step.endLat, step.endLng)
        if (dist < 15.0) {
            currentStepIdx++
            if (currentStepIdx >= r.steps.size) { _state.value = _state.value.copy(status = NavStatus.ARRIVED); return }
        }
        _state.value = _state.value.copy(currentStep = step, stepIndex = currentStepIdx, distanceToNextTurnMeters = dist, totalRemainingMeters = r.steps.drop(currentStepIdx).sumOf { it.distanceMeters }, etaSeconds = r.steps.drop(currentStepIdx).sumOf { it.durationSeconds })
    }

    private fun setState(status: NavStatus, msg: String? = null) { _state.value = _state.value.copy(status = status, errorMessage = msg) }
    fun cleanup() { navigationJob?.cancel(); geo.cleanup(); arView = null }
    override fun onCleared() { super.onCleared(); cleanup() }
}
