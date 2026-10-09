package com.silexperience.velohnav.ar

import android.annotation.SuppressLint
import android.app.Application
import android.hardware.GeomagneticField
import android.util.Log
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.ar.core.Anchor
import com.google.ar.core.Earth
import com.google.ar.core.Frame
import com.google.ar.core.Plane
import com.google.ar.core.Pose
import com.google.ar.core.Session
import com.google.ar.core.TrackingState
import io.github.sceneview.ar.ARSceneView
import io.github.sceneview.ar.node.AnchorNode
import io.github.sceneview.math.Position
import io.github.sceneview.math.Rotation
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

/**
 * Mode de guidage.
 *  - LOCAL : AR ancrée au sol — suivi ARCore local, gratuit, hors ligne, sans compte
 *    ni clé. C'est le mode principal, pas un pis-aller.
 *  - VPS : le même tracé au sol, recalé en plus par la localisation Google
 *    (Geospatial) quand elle est disponible et précise — un bonus.
 *  - GPS_FALLBACK : pas de suivi ARCore exploitable ; guidage texte + GPS.
 */
enum class TrackingMode { LOCAL, VPS, GPS_FALLBACK }

/**
 * Cause d'une limitation. NO_FRAMES / NO_TRACKING / NO_COMPASS / MANUAL font passer
 * en GPS seul. Les autres ne concernent QUE le bonus Geospatial (clé absente ou
 * refusée, ARCore trop ancien, quota) : l'AR au sol fonctionne sans.
 */
enum class FallbackReason { NO_API_KEY, NOT_AUTHORIZED, APK_TOO_OLD, QUOTA, NO_FRAMES, NO_TRACKING, NO_COMPASS, TIMEOUT, MANUAL }

/** Erreur Earth qui ne se corrigera pas d'elle-même pendant la session (null sinon). */
fun permanentEarthError(state: Earth.EarthState?, apiKeyPresent: Boolean): FallbackReason? = when (state) {
    Earth.EarthState.ERROR_NOT_AUTHORIZED ->
        if (apiKeyPresent) FallbackReason.NOT_AUTHORIZED else FallbackReason.NO_API_KEY
    Earth.EarthState.ERROR_APK_VERSION_TOO_OLD -> FallbackReason.APK_TOO_OLD
    Earth.EarthState.ERROR_RESOURCE_EXHAUSTED  -> FallbackReason.QUOTA
    else -> null
}

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
    // Plus de compte à rebours VPS (la nav n'attend plus Google) : toujours 0
    val vpsTimeoutSecondsLeft: Int = 0,
    val trackingMode: TrackingMode = TrackingMode.LOCAL,
    // Meilleure précision Geospatial observée — pour debug/UX
    val bestHorizontalAccuracy: Double = Double.MAX_VALUE,
    // Diagnostic Earth (journal, administrateur)
    val earthDiagnostic: EarthDiagnostic? = null,
    // Cause de la bascule en GPS seul (null sinon)
    val fallbackReason: FallbackReason? = null,
    // Pourquoi le bonus Geospatial est absent (informatif, n'empêche rien)
    val geoBonusOff: FallbackReason? = null,
    // Tracé posé au sol (ancre ARCore active)
    val groundAnchored: Boolean = false,
    // En attente d'un sol à viser (ancrage ou recalage en cours)
    val aimFloor: Boolean = false,
    // Boussole trop agitée pour ancrer
    val compassUnsteady: Boolean = false,
    // Sol non détecté : hauteur estimée (moins exact)
    val floorEstimated: Boolean = false
)

class ArNavigationViewModel(application: Application) : AndroidViewModel(application) {
    private val TAG = "ArNavViewModel"

    // ── Constantes ────────────────────────────────────────────────
    /** Attente d'un plan de sol avant de poser le tracé à hauteur estimée (ms). */
    private val FLOOR_WAIT_MS = 6_000L
    /** Idem pour un ré-ancrage en continuité : le sol est déjà connu. */
    private val FLOOR_WAIT_CONTINUE_MS = 1_500L
    /** Boussole jamais stable : on ancre quand même avec une dispersion plus large. */
    private val COMPASS_RELAX_MS = 10_000L
    private val COMPASS_RELAXED_SPREAD_DEG = 25.0
    /** Aucune boussole du tout / aucun suivi ARCore : GPS seul. */
    private val COMPASS_MISSING_MS = 12_000L
    private val TRACKING_MISSING_MS = 15_000L
    /** Hauteur de l'objectif au-dessus du sol tant qu'aucun plan n'a été mesuré. */
    private val DEFAULT_CAM_HEIGHT_M = 1.35
    /** Repères posés légèrement au-dessus du sol (évite le scintillement avec la chaussée). */
    private val MARK_LIFT_M = 0.03f
    private val CHEVRON_POOL = 28
    private val MANEUVER_POOL = 4
    /** Geospatial accepté pour recaler (bonus) : précision de cap et de position. */
    private val GEO_HEADING_OK_DEG = 10.0
    private val GEO_HORIZ_OK_M = 5.0
    private val GEO_RECALIBRATE_MS = 30_000L

    private val _state = MutableStateFlow(NavState())
    val navState: StateFlow<NavState> = _state.asStateFlow()

    private val geo = GeospatialManager()
    private var routeManager: RouteManager = RouteManager("")
    private val fusedLocation = LocationServices.getFusedLocationProviderClient(application)

    // ARSceneView n'est pas stocké pour le rendu (fuite lors des rotations) : seule
    // une référence de nettoyage est gardée.
    private var cleanupView: ARSceneView? = null

    private var route: NavigationRoute? = null
    private var currentStepIdx = 0
    private var navigationJob: Job? = null
    private var gpsWatchJob: Job? = null
    private var watchdogJob: Job? = null
    private var lastEarth: Earth? = null

    @Volatile private var lastGpsLat: Double = 0.0
    @Volatile private var lastGpsLng: Double = 0.0
    @Volatile private var lastGpsAcc: Double = 99.0
    @Volatile private var lastGpsFixAt: Long = 0L
    private var lastPairFixAt = 0L
    private val MAX_GPS_ACCURACY_M = 30f

    // Clé API présente dans le build (manifest) : sans elle, Geospatial n'est même
    // pas demandé — l'AR au sol n'en a pas besoin.
    var apiKeyPresent: Boolean = true
    @Volatile private var pendingFallback: FallbackReason? = null

    // ── AR ancrée au sol ──────────────────────────────────────────
    private var aligner: GroundAligner? = null
    private var maneuverS: List<Double> = emptyList()
    private var anchorNode: AnchorNode? = null
    private var anchor: Anchor? = null
    private val chevronNodes = ArrayList<ModelNode>()
    private val maneuverNodes = ArrayList<ModelNode>()
    private var marksAtS = Double.NaN
    private var camHeight = DEFAULT_CAM_HEIGHT_M
    private var everTracked = false
    private var routeReadyAt = 0L
    private var lastGeoCorrectionAt = 0L

    /** Demande d'ancrage en attente (premier ancrage, recalage, continuité, Geospatial). */
    private enum class AnchorKind { INITIAL, CONTINUE, ABSOLUTE }
    private data class AnchorRequest(val kind: AnchorKind, val since: Long, val yaw: Double? = null, val userEnu: Enu? = null)
    private var anchorRequest: AnchorRequest? = null

    // Boussole native (capteur de rotation, fourni par l'activité) : cap magnétique
    // de l'axe de la caméra + instant de la mesure.
    @Volatile private var compassMagDeg: Double? = null
    @Volatile private var compassAt: Long = 0L
    private var declinationDeg: Double? = null

    fun onCompass(headingMagDeg: Double?) {
        compassMagDeg = headingMagDeg
        compassAt = System.currentTimeMillis()
    }

    // ── Initialisation ─────────────────────────────────────────────
    fun initializeNavigation(
        arSceneView: ARSceneView,
        destLat: Double, destLng: Double,
        destName: String, travelMode: String,
        mapsKey: String = ""
    ) {
        navigationJob?.cancel(); gpsWatchJob?.cancel(); watchdogJob?.cancel()
        cleanupView = arSceneView
        routeManager = RouteManager(mapsKey)
        currentStepIdx = 0
        lastEarth = null
        pendingFallback = null
        clearGround(arSceneView)

        _state.value = NavState(
            status = NavStatus.LOCATING, destName = destName,
            geoBonusOff = if (apiKeyPresent) null else FallbackReason.NO_API_KEY
        )

        // Un seul modèle GLB, instancié une fois pour tous les repères (réutilisés :
        // aucune création ni destruction de nœud en cours de route).
        viewModelScope.launch {
            try {
                val instances = arSceneView.modelLoader.loadInstancedModel(
                    "models/arrow_navigation.glb", CHEVRON_POOL + MANEUVER_POOL)
                instances.forEachIndexed { i, inst ->
                    val node = ModelNode(modelInstance = inst, scaleToUnits = if (i < CHEVRON_POOL) 0.45f else 0.9f)
                    node.isVisible = false
                    if (i < CHEVRON_POOL) chevronNodes.add(node) else maneuverNodes.add(node)
                    anchorNode?.addChildNode(node)
                }
                Log.d(TAG, "GLB chargé : ${instances.size} instances")
                marksAtS = Double.NaN
                refreshMarks()
            } catch (e: Exception) {
                Log.w(TAG, "GLB load failed (nav textuelle): ${e.message}")
            }
        }

        navigationJob = viewModelScope.launch { locateAndRoute(destLat, destLng, travelMode) }
    }

    // ── GPS + routing ───────────────────────────────────────────────
    @SuppressLint("MissingPermission")
    private suspend fun locateAndRoute(dLat: Double, dLng: Double, mode: String) {
        try {
            val loc = withTimeoutOrNull(10_000) {
                withContext(Dispatchers.IO) {
                    fusedLocation.getCurrentLocation(Priority.PRIORITY_HIGH_ACCURACY, null).await()
                }
            } ?: return setState(NavStatus.ERROR, "GPS indisponible (timeout 10s) — sortez en extérieur")

            onGpsFix(loc.latitude, loc.longitude, if (loc.hasAccuracy()) loc.accuracy.toDouble() else 20.0)
            _state.value = _state.value.copy(status = NavStatus.ROUTING)

            var lastError: Throwable? = null
            for (attempt in 0..2) {
                if (attempt > 0) delay(attempt * 2000L)
                routeManager.fetchRoute(loc.latitude, loc.longitude, dLat, dLng, mode)
                    .onSuccess { r ->
                        route = r
                        prepareGround(r)
                        routeReadyAt = System.currentTimeMillis()
                        _state.value = _state.value.copy(
                            status               = NavStatus.LOCALIZING,
                            totalSteps           = r.steps.size,
                            totalRemainingMeters = r.totalDistanceMeters,
                            etaSeconds           = r.totalDurationSeconds,
                            currentStep          = r.steps.firstOrNull(),
                            aimFloor             = true
                        )
                        Log.i(TAG, "Route: ${r.steps.size} étapes, ${r.totalDistanceMeters}m, ${r.polyline().size} points")
                        anchorRequest = AnchorRequest(AnchorKind.INITIAL, System.currentTimeMillis())
                        startGpsWatcher()
                        startWatchdog()
                        pendingFallback?.let { fallbackToGps(it) }
                        return
                    }
                    .onFailure { lastError = it }
            }
            setState(NavStatus.ERROR, "Itinéraire : ${lastError?.message}")
        } catch (e: Exception) {
            setState(NavStatus.ERROR, "GPS : ${e.message}")
        }
    }

    /** Géométrie au sol : route en ENU autour de son point de départ, abscisses des manœuvres. */
    private fun prepareGround(r: NavigationRoute) {
        val line = r.polyline()
        if (line.size < 2) { aligner = null; return }
        val path = RoutePath(line[0].first, line[0].second, line)
        aligner = GroundAligner(path)
        var hint = 0.0
        maneuverS = r.steps.filter { it.maneuver != "arrive" && it.maneuver != "straight" }.map { st ->
            path.project(path.toEnu(st.endLat, st.endLng), hint, back = 0.0, fwd = Double.MAX_VALUE).first.also { hint = it }
        }
        marksAtS = Double.NaN
    }

    /**
     * Pas de suivi ARCore, ou pas de boussole du tout : GPS seul, avec la cause.
     * Une AR ancrée qui fonctionne n'est jamais interrompue par ce chien de garde.
     */
    private fun startWatchdog() {
        watchdogJob?.cancel()
        watchdogJob = viewModelScope.launch {
            while (isActive && _state.value.status == NavStatus.LOCALIZING) {
                val waited = System.currentTimeMillis() - routeReadyAt
                if (!everTracked && waited > TRACKING_MISSING_MS) { fallbackToGps(FallbackReason.NO_TRACKING); return@launch }
                if (compassMagDeg == null && waited > COMPASS_MISSING_MS) { fallbackToGps(FallbackReason.NO_COMPASS); return@launch }
                delay(1000)
            }
        }
    }

    /** Watchdog de l'activité : aucune image ARCore reçue. */
    fun onArCoreSilent() = fallbackToGps(FallbackReason.NO_FRAMES)

    /** Bouton « Passer en mode GPS », ou absence de suivi / de boussole. */
    fun fallbackToGps(reason: FallbackReason = FallbackReason.MANUAL) {
        val s = _state.value
        if (s.trackingMode == TrackingMode.GPS_FALLBACK) return
        if (s.status == NavStatus.LOCATING || s.status == NavStatus.ROUTING) {
            if (reason != FallbackReason.MANUAL && pendingFallback == null) pendingFallback = reason
            Log.d(TAG, "fallbackToGps($reason) différé (état=${s.status})")
            return
        }
        if (s.status != NavStatus.LOCALIZING && s.status != NavStatus.NAVIGATING) return
        val r = route ?: return
        Log.i(TAG, "GPS seul ($reason)")
        anchorRequest = null
        cleanupView?.let { clearGround(it) }
        _state.value = s.copy(
            status = NavStatus.NAVIGATING,
            trackingMode = TrackingMode.GPS_FALLBACK,
            fallbackReason = reason,
            aimFloor = false, compassUnsteady = false,
            currentStep = s.currentStep ?: r.steps.firstOrNull()
        )
        updateProgressGps()
    }

    /** Bouton « Recaler » : nouvel ancrage au sol (boussole + GPS), la nav continue. */
    fun requestRealign() {
        val s = _state.value
        if (s.status != NavStatus.NAVIGATING || s.trackingMode == TrackingMode.GPS_FALLBACK) return
        anchorRequest = AnchorRequest(AnchorKind.INITIAL, System.currentTimeMillis())
        _state.value = s.copy(aimFloor = true)
    }

    private fun onGpsFix(lat: Double, lng: Double, acc: Double) {
        lastGpsLat = lat; lastGpsLng = lng; lastGpsAcc = acc
        lastGpsFixAt = System.currentTimeMillis()
        if (declinationDeg == null) {
            declinationDeg = try {
                GeomagneticField(lat.toFloat(), lng.toFloat(), 0f, System.currentTimeMillis()).declination.toDouble()
            } catch (_: Exception) { 0.0 }
        }
    }

    @SuppressLint("MissingPermission")
    private fun startGpsWatcher() {
        gpsWatchJob?.cancel()
        gpsWatchJob = viewModelScope.launch {
            while (isActive) {
                try {
                    withContext(Dispatchers.IO) {
                        fusedLocation.getCurrentLocation(Priority.PRIORITY_HIGH_ACCURACY, null).await()
                    }?.let {
                        if (it.hasAccuracy() && it.accuracy > MAX_GPS_ACCURACY_M) return@let
                        onGpsFix(it.latitude, it.longitude, if (it.hasAccuracy()) it.accuracy.toDouble() else 20.0)
                        val s = _state.value
                        // Progression par GPS, sauf quand Geospatial (plus précis) la porte
                        if (s.status == NavStatus.NAVIGATING && s.trackingMode != TrackingMode.VPS) updateProgressGps()
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "GPS watch: ${e.message}")
                }
                delay(2000)
            }
        }
    }

    // ── Chaque image ARCore (thread principal, pendant onSessionUpdated) ──
    // Le Frame n'est valable que pendant cet appel : l'essai d'impact se fait ici.
    fun onArFrame(session: Session, frame: Frame, arView: ARSceneView) {
        session.earth?.let { onEarth(it, frame) }

        val camera = frame.camera
        if (camera.trackingState != TrackingState.TRACKING) {
            // Positions monde d'avant la perte non comparables à celles d'après
            aligner?.clearTrack()
            return
        }
        everTracked = true
        val now = System.currentTimeMillis()
        val pose = camera.pose
        val z = pose.zAxis
        val fwdX = -z[0].toDouble(); val fwdZ = -z[2].toDouble()
        val cam = WorldXZ(pose.tx().toDouble(), pose.tz().toDouble())
        val al = aligner ?: return

        // Lacet boussole : cap de l'axe caméra (capteur) − azimut du même axe (ARCore),
        // au même instant. Accumulé, jamais appliqué image par image.
        val mag = compassMagDeg
        if (mag != null && now - compassAt < 250) {
            GroundGeo.yawOffset(mag + (declinationDeg ?: 0.0), fwdX, fwdZ)?.let { al.addYawSample(now, it) }
        }

        anchorRequest?.let { tryAnchor(it, session, frame, arView, pose, cam, now) }

        // Arrivé (repères masqués), GPS seul ou pas encore ancré : rien à suivre
        if (!al.anchored || _state.value.status != NavStatus.NAVIGATING ||
            _state.value.trackingMode == TrackingMode.GPS_FALLBACK) return

        // Ancre perdue par ARCore (monde réinitialisé) : nouvel ancrage complet
        if (anchor?.trackingState == TrackingState.STOPPED && anchorRequest == null) {
            Log.w(TAG, "Ancre perdue — nouvel ancrage")
            anchorRequest = AnchorRequest(AnchorKind.INITIAL, now)
            return
        }

        al.updateUser(cam)
        if (marksAtS.isNaN() || kotlin.math.abs(al.userS - marksAtS) >= GroundAligner.SPACING_M) refreshMarks()

        if (anchorRequest == null && al.needsReanchor(cam)) {
            anchorRequest = AnchorRequest(AnchorKind.CONTINUE, now)
        }

        // Trajectoire marchée : une paire (ARCore, GPS) par nouveau fix GPS
        if (lastGpsFixAt > lastPairFixAt) {
            lastPairFixAt = lastGpsFixAt
            al.addTrackPair(cam, al.path.toEnu(lastGpsLat, lastGpsLng), lastGpsAcc)
            if (anchorRequest == null && _state.value.trackingMode == TrackingMode.LOCAL) {
                al.trackYawCorrection()?.let { yaw ->
                    Log.i(TAG, "Lacet corrigé par la trajectoire : ${al.yawDeg} → $yaw")
                    anchorRequest = AnchorRequest(AnchorKind.CONTINUE, now, yaw = yaw)
                }
            }
        }
    }

    /** Essai d'impact sur un plan horizontal, au centre bas de l'écran. */
    private fun hitFloor(frame: Frame, arView: ARSceneView, camY: Float): Pair<Plane, Pose>? {
        val w = arView.width.toFloat(); val h = arView.height.toFloat()
        if (w <= 0f || h <= 0f) return null
        for (fy in floatArrayOf(0.72f, 0.62f, 0.82f, 0.52f)) {
            for (hit in frame.hitTest(w / 2f, h * fy)) {
                val plane = hit.trackable as? Plane ?: continue
                val p = hit.hitPose
                if (plane.type != Plane.Type.HORIZONTAL_UPWARD_FACING) continue
                if (plane.trackingState != TrackingState.TRACKING || !plane.isPoseInPolygon(p)) continue
                if (hit.distance > 8f || (camY - p.ty()) !in 0.4f..2.5f) continue
                return Pair(plane, p)
            }
        }
        return null
    }

    private fun tryAnchor(req: AnchorRequest, session: Session, frame: Frame, arView: ARSceneView,
                          pose: Pose, cam: WorldXZ, now: Long) {
        val al = aligner ?: return
        val hit = hitFloor(frame, arView, pose.ty())
        val wait = if (req.kind == AnchorKind.INITIAL && !al.anchored) FLOOR_WAIT_MS else FLOOR_WAIT_CONTINUE_MS
        if (hit == null && now - req.since < wait) {
            if (!_state.value.aimFloor) _state.value = _state.value.copy(aimFloor = true)
            return
        }

        // Lacet : boussole moyennée (premier ancrage / recalage), sinon celui demandé
        val yaw: Double = when (req.kind) {
            AnchorKind.INITIAL -> al.compassYaw() ?: relaxedCompassYaw(al, now - req.since) ?: run {
                if (!_state.value.compassUnsteady) _state.value = _state.value.copy(compassUnsteady = true)
                return
            }
            AnchorKind.CONTINUE -> req.yaw ?: al.yawDeg ?: return
            AnchorKind.ABSOLUTE -> req.yaw ?: return
        }
        if (req.kind == AnchorKind.INITIAL && lastGpsFixAt == 0L) return
        if (req.kind == AnchorKind.ABSOLUTE && req.userEnu == null) { anchorRequest = null; return }

        val floorY: Float
        val newAnchor: Anchor
        try {
            if (hit != null) {
                val (plane, p) = hit
                floorY = p.ty()
                camHeight = (pose.ty() - floorY).toDouble().coerceIn(0.6, 2.2)
                newAnchor = plane.createAnchor(Pose.makeTranslation(p.tx(), floorY, p.tz()))
            } else {
                floorY = (pose.ty() - camHeight).toFloat()
                newAnchor = session.createAnchor(Pose.makeTranslation(pose.tx(), floorY, pose.tz()))
            }
        } catch (e: Exception) {
            Log.w(TAG, "Ancrage impossible : ${e.message}")
            return
        }
        val anchorAt = WorldXZ(newAnchor.pose.tx().toDouble(), newAnchor.pose.tz().toDouble())

        when (req.kind) {
            AnchorKind.INITIAL -> al.anchor(cam, anchorAt, al.path.toEnu(lastGpsLat, lastGpsLng), yaw)
            AnchorKind.CONTINUE -> al.reanchor(cam, anchorAt, yaw)
            AnchorKind.ABSOLUTE -> al.anchorAbsolute(cam, anchorAt, req.userEnu!!, yaw)
        }
        attachAnchor(arView, newAnchor)
        anchorRequest = null
        Log.i(TAG, "Ancré au sol (${req.kind}) lacet=${"%.1f".format(yaw)}° sol=${if (hit != null) "détecté" else "estimé"} " +
                   "s=${"%.1f".format(al.userS)}m")

        val s = _state.value
        _state.value = s.copy(
            status = if (s.status == NavStatus.LOCALIZING) NavStatus.NAVIGATING else s.status,
            groundAnchored = true, aimFloor = false, compassUnsteady = false,
            floorEstimated = hit == null,
            trackingMode = if (req.kind == AnchorKind.ABSOLUTE) TrackingMode.VPS
                           else if (s.trackingMode == TrackingMode.GPS_FALLBACK) TrackingMode.LOCAL else s.trackingMode
        )
        if (s.status == NavStatus.LOCALIZING) updateProgressGps()
    }

    /** Boussole jamais assez stable : au bout de COMPASS_RELAX_MS, dispersion plus large admise. */
    private fun relaxedCompassYaw(al: GroundAligner, waited: Long): Double? =
        if (waited < COMPASS_RELAX_MS) null else al.compassYaw(COMPASS_RELAXED_SPREAD_DEG)

    /** Remplace l'ancre : les repères passent sur la nouvelle avant destruction de l'ancienne. */
    private fun attachAnchor(arView: ARSceneView, newAnchor: Anchor) {
        val old = anchorNode; val oldAnchor = anchor
        val node = AnchorNode(engine = arView.engine, anchor = newAnchor)
        arView.addChildNode(node)
        (chevronNodes + maneuverNodes).forEach { node.addChildNode(it) }
        anchorNode = node; anchor = newAnchor
        marksAtS = Double.NaN
        refreshMarks()
        if (old != null) {
            try { arView.removeChildNode(old); old.destroy() } catch (e: Exception) { Log.w(TAG, "ancre: ${e.message}") }
        }
        try { oldAnchor?.detach() } catch (_: Exception) {}
    }

    /** Positionne les repères réutilisés (aucune allocation) ; masque ceux qui ne servent pas. */
    private fun refreshMarks() {
        val al = aligner
        if (al == null || !al.anchored || anchorNode == null) { (chevronNodes + maneuverNodes).forEach { it.isVisible = false }; return }
        marksAtS = al.userS
        val marks = al.marks(maneuverS)
        val chev = marks.filter { !it.maneuver }; val man = marks.filter { it.maneuver }
        fun place(nodes: List<ModelNode>, ms: List<GroundMark>) {
            nodes.forEachIndexed { i, n ->
                val m = ms.getOrNull(i)
                if (m == null) { n.isVisible = false; return@forEachIndexed }
                n.position = Position(m.x.toFloat(), MARK_LIFT_M, m.z.toFloat())
                n.rotation = Rotation(0f, m.yawDeg.toFloat(), 0f)
                n.isVisible = true
            }
        }
        place(chevronNodes, chev); place(maneuverNodes, man)
    }

    // ── Geospatial (bonus) ─────────────────────────────────────────
    private fun onEarth(earth: Earth, frame: Frame) {
        lastEarth = earth
        geo.onFrame(earth, frame)
        val diag = geo.diagnostic.value
        if (diag != null && _state.value.earthDiagnostic != diag) _state.value = _state.value.copy(earthDiagnostic = diag)

        // Clé refusée, ARCore trop ancien, quota : le bonus est indisponible, et
        // c'est tout — l'AR au sol continue. (Avant : bascule en GPS seul et encart
        // « AR précise indisponible » à chaque lancement sans clé.)
        val permanent = permanentEarthError(diag?.state, apiKeyPresent)
        if (permanent != null) {
            if (_state.value.geoBonusOff != permanent) {
                Log.w(TAG, "Geospatial indisponible (${diag?.state}) — AR au sol seule")
                _state.value = _state.value.copy(geoBonusOff = permanent)
            }
            return
        }

        val acc = geo.accuracy.value ?: return
        _state.value = _state.value.copy(
            vpsAccuracy = acc,
            bestHorizontalAccuracy = minOf(_state.value.bestHorizontalAccuracy, acc.horizontalMeters)
        )

        val al = aligner ?: return
        val s = _state.value
        if (earth.trackingState != TrackingState.TRACKING || !al.anchored || anchorRequest != null) return
        if (s.status != NavStatus.NAVIGATING || s.trackingMode == TrackingMode.GPS_FALLBACK) return

        val gp = earth.cameraGeospatialPose
        if (gp.headingAccuracy > GEO_HEADING_OK_DEG || gp.horizontalAccuracy > GEO_HORIZ_OK_M) return
        val now = System.currentTimeMillis()
        if (s.trackingMode == TrackingMode.VPS && now - lastGeoCorrectionAt < GEO_RECALIBRATE_MS) {
            updateProgress(earth, route ?: return)
            return
        }
        val q = gp.eastUpSouthQuaternion
        val bearing = GroundGeo.bearingFromEusQuaternion(q[0].toDouble(), q[1].toDouble(), q[2].toDouble(), q[3].toDouble()) ?: return
        val z = frame.camera.pose.zAxis
        val yaw = GroundGeo.yawOffset(bearing, -z[0].toDouble(), -z[2].toDouble()) ?: return
        lastGeoCorrectionAt = now
        Log.i(TAG, "Geospatial ±${gp.horizontalAccuracy}m / ±${gp.headingAccuracy}° : recalage absolu (lacet $yaw)")
        anchorRequest = AnchorRequest(AnchorKind.ABSOLUTE, now, yaw = yaw, userEnu = al.path.toEnu(gp.latitude, gp.longitude))
    }

    // ── Progression ─────────────────────────────────────────────────
    private fun updateProgressGps() {
        val r = route ?: return
        if (lastGpsFixAt == 0L) return
        val step = r.steps.getOrNull(currentStepIdx) ?: return arrived()
        // Tolérance plus large qu'avec Geospatial (précision GPS ±10 m typique)
        stepProgress(r, GeospatialManager.distanceMeters(lastGpsLat, lastGpsLng, step.endLat, step.endLng), threshold = 20.0)
    }

    /** Progression par Geospatial (mode VPS) : position plus sûre que le GPS. */
    private fun updateProgress(earth: Earth, r: NavigationRoute) {
        if (earth.trackingState != TrackingState.TRACKING) return
        val pose = earth.cameraGeospatialPose
        if (pose.horizontalAccuracy > 15.0) return
        val step = r.steps.getOrNull(currentStepIdx) ?: return arrived()
        stepProgress(r, GeospatialManager.distanceMeters(pose.latitude, pose.longitude, step.endLat, step.endLng), threshold = 15.0)
    }

    private fun stepProgress(r: NavigationRoute, dist: Double, threshold: Double) {
        if (dist < threshold) {
            currentStepIdx++
            if (currentStepIdx >= r.steps.size) return arrived()
        }
        _state.value = _state.value.copy(
            currentStep              = r.steps[currentStepIdx.coerceAtMost(r.steps.size - 1)],
            stepIndex                = currentStepIdx,
            distanceToNextTurnMeters = dist,
            totalRemainingMeters     = r.steps.drop(currentStepIdx).sumOf { it.distanceMeters },
            etaSeconds               = r.steps.drop(currentStepIdx).sumOf { it.durationSeconds }
        )
    }

    private fun arrived() {
        if (_state.value.status == NavStatus.ARRIVED) return
        _state.value = _state.value.copy(status = NavStatus.ARRIVED, aimFloor = false)
        anchorRequest = null
        (chevronNodes + maneuverNodes).forEach { it.isVisible = false }
        Log.i(TAG, "Destination atteinte !")
    }

    // ── Retry ────────────────────────────────────────────────────────
    fun retry(arView: ARSceneView, destLat: Double, destLng: Double, travelMode: String) {
        navigationJob?.cancel(); gpsWatchJob?.cancel(); watchdogJob?.cancel()
        pendingFallback = null
        cleanupView = arView
        clearGround(arView)
        _state.value = _state.value.copy(
            status = NavStatus.LOCATING,
            errorMessage = null,
            trackingMode = TrackingMode.LOCAL,
            fallbackReason = null,
            bestHorizontalAccuracy = Double.MAX_VALUE,
            groundAnchored = false, aimFloor = false, compassUnsteady = false
        )
        navigationJob = viewModelScope.launch { locateAndRoute(destLat, destLng, travelMode) }
    }

    /** Retire l'ancre et masque les repères (les nœuds du pool sont conservés). */
    private fun clearGround(arView: ARSceneView) {
        anchorRequest = null
        (chevronNodes + maneuverNodes).forEach { it.isVisible = false }
        anchorNode?.let { n ->
            try { arView.removeChildNode(n) } catch (_: Exception) {}
        }
        try { anchor?.detach() } catch (_: Exception) {}
        anchorNode = null; anchor = null
        aligner?.reset()
        marksAtS = Double.NaN
        everTracked = false
        _state.value = _state.value.copy(groundAnchored = false)
    }

    // ── Cleanup — appelé depuis Activity.onDestroy avec la référence courante ──
    fun cleanup(arViewFromActivity: ARSceneView?) {
        navigationJob?.cancel(); gpsWatchJob?.cancel(); watchdogJob?.cancel()
        val view = arViewFromActivity ?: cleanupView
        anchorRequest = null
        try {
            anchorNode?.let { n -> view?.removeChildNode(n); n.destroy() }
            (chevronNodes + maneuverNodes).forEach { it.destroy() }
        } catch (e: Exception) {
            Log.w(TAG, "cleanup node: ${e.message}")
        }
        try { anchor?.detach() } catch (_: Exception) {}
        chevronNodes.clear(); maneuverNodes.clear()
        anchorNode = null; anchor = null
        aligner = null
        geo.cleanup()
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
