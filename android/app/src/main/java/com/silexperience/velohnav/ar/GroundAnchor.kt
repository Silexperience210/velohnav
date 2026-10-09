package com.silexperience.velohnav.ar

import kotlin.math.*

// ── GroundAnchor.kt — géométrie de l'AR ancrée au sol (Kotlin pur, testable) ──
//
// Principe : l'itinéraire est posé UNE fois sur un point du sol détecté devant
// l'utilisateur (essai d'impact ARCore sur un plan horizontal), puis c'est le
// suivi visuel et inertiel d'ARCore qui le maintient en place. Rien ici n'est
// recalculé à chaque image à partir du cap brut : c'était la cause du
// tremblement et du décalage latéral de la vue boussole.
//
// Deux repères :
//  - ENU local (m) : e = est, n = nord, autour d'un point de référence GPS ;
//  - monde ARCore : Y vers le haut (aligné sur la gravité), X et Z horizontaux,
//    orientation initiale arbitraire (celle du téléphone au démarrage).
// Il ne manque, pour passer de l'un à l'autre, qu'un angle de lacet θ :
//      relèvement (ENU, horaire depuis le nord) = azimut monde (horaire depuis −Z) + θ
// θ est mesuré à l'ancrage (moyenne boussole − visée ARCore, mêmes instants),
// puis seulement corrigé par des sources fiables : trajectoire marchée (ARCore
// contre GPS, sur au moins une quinzaine de mètres), ou localisation Google si
// elle est disponible (bonus, jamais une condition).
//
// Aucune dépendance Android : compilé et testé sur JVM (GroundAnchorTest).

/** Décalage local (m) : e = est, n = nord. */
data class Enu(val e: Double, val n: Double) {
    operator fun plus(o: Enu) = Enu(e + o.e, n + o.n)
    operator fun minus(o: Enu) = Enu(e - o.e, n - o.n)
    fun length() = hypot(e, n)
}

/** Point ou déplacement horizontal dans le repère monde ARCore (y = vertical). */
data class WorldXZ(val x: Double, val z: Double) {
    operator fun plus(o: WorldXZ) = WorldXZ(x + o.x, z + o.z)
    operator fun minus(o: WorldXZ) = WorldXZ(x - o.x, z - o.z)
    fun length() = hypot(x, z)
}

/** Résultat d'un ajustement de lacet sur une trajectoire. */
data class YawFit(val yawDeg: Double, val spreadM: Double, val rmsM: Double, val pairs: Int)

object GroundGeo {
    const val R_EARTH = 6_371_008.8
    private const val RAD = PI / 180.0

    /** Décalage ENU de `to` vu de `from` — même formule que le web (groundProjection.enuOffset). */
    fun enuOffset(fromLat: Double, fromLng: Double, toLat: Double, toLng: Double): Enu {
        val lat0 = (fromLat + toLat) / 2 * RAD
        return Enu((toLng - fromLng) * RAD * R_EARTH * cos(lat0), (toLat - fromLat) * RAD * R_EARTH)
    }

    fun norm360(a: Double): Double = ((a % 360.0) + 360.0) % 360.0

    /** Écart signé (−180..180) pour aller de `from` à `to`. */
    fun angleDiff(from: Double, to: Double): Double = ((to - from) % 360.0 + 540.0) % 360.0 - 180.0

    /** Relèvement (°) d'un vecteur ENU. */
    fun bearingOf(d: Enu): Double = norm360(atan2(d.e, d.n) / RAD)

    /**
     * Azimut (°, horaire vu du dessus, 0 = −Z) d'une direction du monde ARCore.
     * Null si elle est presque verticale (composante horizontale < `minHoriz`).
     */
    fun worldAzimuth(x: Double, z: Double, minHoriz: Double = 0.3): Double? =
        if (hypot(x, z) < minHoriz) null else norm360(atan2(x, -z) / RAD)

    /**
     * Cap (°, nord magnétique) de l'axe de visée de la caméra arrière (−Z de
     * l'appareil), à partir de la matrice de SensorManager.getRotationMatrixFromVector
     * (ligne par ligne, appareil → monde est/nord/haut). Indépendant de la rotation
     * de l'écran. Null si la caméra vise presque le sol ou le ciel.
     */
    fun cameraHeadingFromRotationMatrix(r: DoubleArray, minHoriz: Double = 0.3): Double? {
        val east = -r[2]; val north = -r[5]
        if (hypot(east, north) < minHoriz) return null
        return norm360(atan2(east, north) / RAD)
    }

    /**
     * Relèvement (°, nord vrai) de l'axe de visée d'une pose Geospatial, à partir de
     * son quaternion est-haut-sud (GeospatialPose.getEastUpSouthQuaternion, x,y,z,w).
     * Remplace GeospatialPose.heading, déprécié.
     */
    fun bearingFromEusQuaternion(qx: Double, qy: Double, qz: Double, qw: Double, minHoriz: Double = 0.3): Double? {
        // Troisième colonne de la matrice de rotation, changée de signe : image de (0, 0, −1)
        val east  = -2.0 * (qx * qz + qw * qy)
        val south = -(1.0 - 2.0 * (qx * qx + qy * qy))
        val north = -south
        if (hypot(east, north) < minHoriz) return null
        return norm360(atan2(east, north) / RAD)
    }

    /** θ = cap − azimut monde de la même direction de visée, au même instant. */
    fun yawOffset(headingDeg: Double, fwdX: Double, fwdZ: Double): Double? =
        worldAzimuth(fwdX, fwdZ)?.let { norm360(headingDeg - it) }

    /**
     * Moyenne circulaire (°) et dispersion (écart type circulaire, °).
     * Null si la liste est vide ou les angles se compensent.
     */
    fun circularMean(angles: List<Double>): Pair<Double, Double>? {
        if (angles.isEmpty()) return null
        var s = 0.0; var c = 0.0
        for (a in angles) { s += sin(a * RAD); c += cos(a * RAD) }
        val r = hypot(s, c) / angles.size
        if (r < 1e-6) return null
        val std = sqrt(-2.0 * ln(r.coerceAtMost(1.0))) / RAD
        return Pair(norm360(atan2(s, c) / RAD), std)
    }

    /** ENU → monde ARCore (x, z), pour le lacet θ. */
    fun enuToWorld(d: Enu, yawDeg: Double): WorldXZ {
        val t = yawDeg * RAD; val c = cos(t); val s = sin(t)
        return WorldXZ(d.e * c - d.n * s, -(d.e * s + d.n * c))
    }

    /** Monde ARCore (x, z) → ENU, inverse exacte de enuToWorld. */
    fun worldToEnu(w: WorldXZ, yawDeg: Double): Enu {
        val t = yawDeg * RAD; val c = cos(t); val s = sin(t)
        val ux = w.x; val uy = -w.z
        return Enu(ux * c + uy * s, -ux * s + uy * c)
    }

    /**
     * Lacet (°, rotation autour de +Y, main droite) qui fait viser à la flèche GLB
     * (pointe en −Z à l'identité) l'azimut monde `azimuthDeg`. Même convention que
     * GeospatialManager.arrowYawQuaternion : il faut −azimut.
     */
    fun modelYawDeg(azimuthDeg: Double): Double = -azimuthDeg

    /**
     * Lacet θ qui superpose au mieux une trajectoire ARCore (positions monde de la
     * caméra) à la trajectoire GPS des mêmes instants (moindres carrés, rotation
     * pure, translation éliminée par centrage). Null avec moins de 3 paires.
     * spreadM : étendue de la trajectoire (rayon quadratique moyen) ; rmsM : résidu.
     */
    fun fitYaw(world: List<WorldXZ>, enu: List<Enu>): YawFit? {
        val n = minOf(world.size, enu.size)
        if (n < 3) return null
        val wx = (0 until n).sumOf { world[it].x } / n; val wz = (0 until n).sumOf { world[it].z } / n
        val ee = (0 until n).sumOf { enu[it].e } / n;   val en = (0 until n).sumOf { enu[it].n } / n
        var num = 0.0; var den = 0.0; var spread2 = 0.0
        for (i in 0 until n) {
            val ux = world[i].x - wx; val uy = -(world[i].z - wz)
            val pe = enu[i].e - ee;   val pn = enu[i].n - en
            num += pn * ux - pe * uy
            den += pe * ux + pn * uy
            spread2 += ux * ux + uy * uy
        }
        if (hypot(num, den) < 1e-9) return null
        val yaw = norm360(-atan2(num, den) / RAD)
        var res2 = 0.0
        for (i in 0 until n) {
            val p = worldToEnu(WorldXZ(world[i].x - wx, world[i].z - wz), yaw)
            val de = p.e - (enu[i].e - ee); val dn = p.n - (enu[i].n - en)
            res2 += de * de + dn * dn
        }
        return YawFit(yaw, sqrt(spread2 / n), sqrt(res2 / n), n)
    }
}

/**
 * Itinéraire en ENU autour de `refLat/refLng`, avec abscisse curviligne.
 * Construit à partir de la géométrie complète de la route (pas seulement des
 * points de manœuvre : une rue courbe serait sinon tirée au cordeau).
 */
class RoutePath(val refLat: Double, val refLng: Double, latLngs: List<Pair<Double, Double>>) {
    val points: List<Enu>
    private val cum: DoubleArray

    init {
        val pts = ArrayList<Enu>(latLngs.size)
        for ((la, ln) in latLngs) {
            val p = GroundGeo.enuOffset(refLat, refLng, la, ln)
            // Sommets confondus : inutiles et sans direction
            if (pts.isEmpty() || (p - pts.last()).length() > 0.05) pts.add(p)
        }
        points = pts
        cum = DoubleArray(pts.size)
        for (i in 1 until pts.size) cum[i] = cum[i - 1] + (pts[i] - pts[i - 1]).length()
    }

    val length: Double get() = if (cum.isEmpty()) 0.0 else cum.last()

    fun toEnu(lat: Double, lng: Double): Enu = GroundGeo.enuOffset(refLat, refLng, lat, lng)

    private fun segmentAt(s: Double): Int {
        if (points.size < 2) return 0
        var lo = 0; var hi = points.size - 2
        while (lo < hi) { val mid = (lo + hi + 1) / 2; if (cum[mid] <= s) lo = mid else hi = mid - 1 }
        return lo
    }

    /** Point situé à l'abscisse `s` (bornée à la route). */
    fun pointAt(s: Double): Enu {
        if (points.isEmpty()) return Enu(0.0, 0.0)
        if (points.size == 1) return points[0]
        val ss = s.coerceIn(0.0, length)
        val i = segmentAt(ss)
        val segLen = cum[i + 1] - cum[i]
        val t = if (segLen > 0) (ss - cum[i]) / segLen else 0.0
        val a = points[i]; val b = points[i + 1]
        return Enu(a.e + t * (b.e - a.e), a.n + t * (b.n - a.n))
    }

    /** Relèvement (°) de la route à l'abscisse `s`. */
    fun bearingAt(s: Double): Double {
        if (points.size < 2) return 0.0
        val i = segmentAt(s.coerceIn(0.0, length))
        return GroundGeo.bearingOf(points[i + 1] - points[i])
    }

    /**
     * Projection orthogonale de `p` sur la route : (abscisse, distance).
     * Avec `hint`, seule la portion [hint − back, hint + fwd] est examinée : une
     * route qui repasse près d'elle-même ne fait pas sauter la progression (fenêtre
     * étroite : entre deux appels, on n'avance que de quelques mètres). Si le
     * meilleur point de la fenêtre est nettement hors route (grand déplacement d'un
     * coup : reprise du suivi, ré-ancrage), recherche sur toute la route.
     */
    fun project(p: Enu, hint: Double? = null, back: Double = 15.0, fwd: Double = 40.0): Pair<Double, Double> {
        if (points.isEmpty()) return Pair(0.0, p.length())
        if (points.size == 1) return Pair(0.0, (p - points[0]).length())
        var bestS = 0.0; var bestD = Double.MAX_VALUE
        for (i in 0 until points.size - 1) {
            if (hint != null && (cum[i + 1] < hint - back || cum[i] > hint + fwd)) continue
            val a = points[i]; val b = points[i + 1]
            val dx = b.e - a.e; val dy = b.n - a.n; val l2 = dx * dx + dy * dy
            val t = if (l2 > 0) (((p.e - a.e) * dx + (p.n - a.n) * dy) / l2).coerceIn(0.0, 1.0) else 0.0
            val d = hypot(a.e + t * dx - p.e, a.n + t * dy - p.n)
            if (d < bestD) { bestD = d; bestS = cum[i] + t * sqrt(l2) }
        }
        if (hint != null && bestD > WINDOW_MAX_OFFSET_M) {
            val global = project(p, null)
            if (bestD == Double.MAX_VALUE || global.second < bestD - 2.0) return global
        }
        return Pair(bestS, bestD)
    }

    companion object {
        /** Écart à la route au-delà duquel la fenêtre de progression est jugée perdue. */
        const val WINDOW_MAX_OFFSET_M = 5.0
    }
}

/** Repère au sol à poser : position locale (m, relative à l'ancre) et lacet du modèle. */
data class GroundMark(val id: Int, val x: Double, val z: Double, val yawDeg: Double, val maneuver: Boolean)

/**
 * État de l'ancrage au sol, sans ARCore : ce que la vue ancrée doit afficher et
 * quand il faut ré-ancrer. Le ViewModel ne fait que lui passer les mesures
 * (visée caméra, cap boussole, GPS) et appliquer ses décisions aux nœuds 3D.
 */
class GroundAligner(val path: RoutePath) {

    companion object {
        /** Fenêtre (ms) et minimum d'échantillons pour la moyenne boussole à l'ancrage. */
        const val YAW_WINDOW_MS = 1_500L
        const val YAW_MIN_SAMPLES = 10
        /** Dispersion boussole (°) au-delà de laquelle on n'ancre pas (main qui bouge, aimant). */
        const val YAW_MAX_SPREAD_DEG = 10.0
        /** Recalage sur la route à l'ancrage : au-delà, l'utilisateur n'est pas dessus. */
        const val SNAP_MAX_M = 25.0
        /** Premier repère à 1 m des pieds, puis un tous les SPACING_M. */
        const val FIRST_M = 1.0
        const val SPACING_M = 2.5
        /** Portion dessinée autour de l'utilisateur. */
        const val BEHIND_M = 4.0
        const val AHEAD_M = 60.0
        /** Ré-ancrage quand l'utilisateur s'est éloigné de l'ancre (dérive du suivi). */
        const val REANCHOR_M = 60.0
        /** Trajectoire : paires retenues, écart mini entre paires, précision GPS maxi. */
        const val TRACK_MAX_PAIRS = 30
        const val TRACK_MIN_STEP_M = 2.0
        const val TRACK_MAX_ACC_M = 12.0
        /** Correction de lacet par la trajectoire : étendue mini, résidu maxi, écart mini. */
        const val TRACK_MIN_SPREAD_M = 12.0
        const val TRACK_MAX_RMS_M = 5.0
        const val YAW_MIN_CORRECTION_DEG = 3.0
    }

    private val yawSamples = ArrayDeque<Pair<Long, Double>>()
    private val trackWorld = ArrayDeque<WorldXZ>()
    private val trackEnu = ArrayDeque<Enu>()

    /** Lacet θ en vigueur (null tant que l'itinéraire n'est pas ancré). */
    var yawDeg: Double? = null; private set
    /** ENU des pieds de l'utilisateur au moment de l'ancrage. */
    var originEnu: Enu = Enu(0.0, 0.0); private set
    /** Position monde (x, z) de ces mêmes pieds. */
    var originWorld: WorldXZ = WorldXZ(0.0, 0.0); private set
    /** Position monde (x, z) de l'ancre ARCore (point du sol touché). */
    var anchorWorld: WorldXZ = WorldXZ(0.0, 0.0); private set
    /** Abscisse de l'utilisateur sur la route, dernière connue. */
    var userS: Double = 0.0; private set
    /** Abscisse du premier repère de la grille (fixée à l'ancrage). */
    private var gridStart = FIRST_M

    val anchored: Boolean get() = yawDeg != null

    // ── Lacet boussole (avant ancrage) ───────────────────────────────
    fun addYawSample(tMs: Long, thetaDeg: Double) {
        yawSamples.addLast(Pair(tMs, GroundGeo.norm360(thetaDeg)))
        while (yawSamples.isNotEmpty() && tMs - yawSamples.first().first > YAW_WINDOW_MS) yawSamples.removeFirst()
    }

    /** Moyenne boussole utilisable pour ancrer, ou null (trop peu d'échantillons, trop dispersés). */
    fun compassYaw(maxSpreadDeg: Double = YAW_MAX_SPREAD_DEG): Double? {
        if (yawSamples.size < YAW_MIN_SAMPLES) return null
        val (mean, std) = GroundGeo.circularMean(yawSamples.map { it.second }) ?: return null
        return if (std <= maxSpreadDeg) mean else null
    }

    // ── Ancrage ───────────────────────────────────────────────────────
    /**
     * Premier ancrage : les pieds (feet, monde) sont associés au point de la route
     * le plus proche de la position GPS — le tracé part donc des pieds, même avec
     * quelques mètres d'erreur GPS. Hors route (> SNAP_MAX_M) : la position GPS brute.
     */
    fun anchor(feet: WorldXZ, anchorAt: WorldXZ, gpsEnu: Enu, yaw: Double) {
        val (s, d) = path.project(gpsEnu)
        val origin = if (d <= SNAP_MAX_M) path.pointAt(s) else gpsEnu
        set(feet, anchorAt, origin, s, yaw)
        clearTrack()
    }

    /**
     * Ré-ancrage en continuité (même lacet ou lacet corrigé) : la position ENU des
     * pieds est déduite du suivi ARCore depuis l'ancre précédente, pas du GPS — pas
     * de saut dû au bruit GPS. Un lacet corrigé fait tourner autour de l'ancre
     * précédente, ce qui est exact si l'ancien lacet était faux.
     */
    fun reanchor(feet: WorldXZ, anchorAt: WorldXZ, newYaw: Double = yawDeg ?: 0.0) {
        val origin = originEnu + GroundGeo.worldToEnu(feet - originWorld, newYaw)
        set(feet, anchorAt, origin, path.project(origin, userS).first, newYaw)
    }

    /**
     * Ré-ancrage sur une position absolue fiable (localisation Google, bonus) :
     * lacet et position viennent d'elle.
     */
    fun anchorAbsolute(feet: WorldXZ, anchorAt: WorldXZ, userEnu: Enu, yaw: Double) {
        set(feet, anchorAt, userEnu, path.project(userEnu, userS).first, yaw)
        clearTrack()
    }

    private fun set(feet: WorldXZ, anchorAt: WorldXZ, origin: Enu, s: Double, yaw: Double) {
        originWorld = feet; anchorWorld = anchorAt; originEnu = origin
        userS = s; gridStart = s + FIRST_M; yawDeg = GroundGeo.norm360(yaw)
    }

    fun reset() { yawDeg = null; clearTrack(); yawSamples.clear() }

    // ── Pendant la navigation ─────────────────────────────────────────
    /** Position ENU des pieds, déduite du suivi ARCore (null avant ancrage). */
    fun userEnu(camera: WorldXZ): Enu? = yawDeg?.let { originEnu + GroundGeo.worldToEnu(camera - originWorld, it) }

    /** Met à jour l'abscisse de l'utilisateur ; renvoie le déplacement le long de la route. */
    fun updateUser(camera: WorldXZ): Double {
        val p = userEnu(camera) ?: return 0.0
        val s = path.project(p, userS).first
        val moved = s - userS
        userS = s
        return moved
    }

    fun needsReanchor(camera: WorldXZ): Boolean = anchored && (camera - anchorWorld).length() > REANCHOR_M

    /** Position locale (relative à l'ancre) d'un point ENU, au sol. */
    fun localOf(p: Enu): WorldXZ {
        val yaw = yawDeg ?: 0.0
        return (originWorld - anchorWorld) + GroundGeo.enuToWorld(p - originEnu, yaw)
    }

    /**
     * Repères à poser autour de l'utilisateur : chevrons réguliers le long de la
     * route (id = rang dans la grille) et flèches de manœuvre (id = 10 000 + étape),
     * orientés selon la route. `maneuverS` : abscisses des points de manœuvre.
     */
    fun marks(maneuverS: List<Double> = emptyList()): List<GroundMark> {
        val yaw = yawDeg ?: return emptyList()
        val out = ArrayList<GroundMark>()
        val from = maxOf(gridStart, userS - BEHIND_M)
        val to = minOf(path.length, userS + AHEAD_M)
        var k = ceil((from - gridStart) / SPACING_M).toInt().coerceAtLeast(0)
        while (true) {
            val s = gridStart + k * SPACING_M
            if (s > to) break
            out.add(mark(k, s, yaw, false))
            k++
        }
        for ((i, s) in maneuverS.withIndex()) {
            if (s < from || s > to) continue
            out.add(mark(10_000 + i, s, yaw, true, bearingS = minOf(s + 3.0, path.length)))
        }
        return out
    }

    private fun mark(id: Int, s: Double, yaw: Double, maneuver: Boolean, bearingS: Double = s): GroundMark {
        val l = localOf(path.pointAt(s))
        val azimuth = path.bearingAt(bearingS) - yaw
        return GroundMark(id, l.x, l.z, GroundGeo.modelYawDeg(azimuth), maneuver)
    }

    // ── Correction du lacet par la trajectoire marchée ───────────────
    /**
     * Ajoute une paire (position caméra ARCore, position GPS) au même instant.
     * Ignorée si le GPS est imprécis ou si l'on n'a pas bougé depuis la paire précédente.
     */
    fun addTrackPair(camera: WorldXZ, gpsEnu: Enu, accuracyM: Double) {
        if (!anchored || accuracyM > TRACK_MAX_ACC_M) return
        val last = trackWorld.lastOrNull()
        if (last != null && (camera - last).length() < TRACK_MIN_STEP_M) return
        trackWorld.addLast(camera); trackEnu.addLast(gpsEnu)
        while (trackWorld.size > TRACK_MAX_PAIRS) { trackWorld.removeFirst(); trackEnu.removeFirst() }
    }

    /** Lacet corrigé si la trajectoire le justifie nettement, sinon null. */
    fun trackYawCorrection(): Double? {
        val yaw = yawDeg ?: return null
        val fit = GroundGeo.fitYaw(trackWorld.toList(), trackEnu.toList()) ?: return null
        if (fit.spreadM < TRACK_MIN_SPREAD_M || fit.rmsM > TRACK_MAX_RMS_M) return null
        return if (abs(GroundGeo.angleDiff(yaw, fit.yawDeg)) >= YAW_MIN_CORRECTION_DEG) fit.yawDeg else null
    }

    /** Le suivi ARCore a été perdu : les positions monde antérieures ne sont plus comparables. */
    fun clearTrack() { trackWorld.clear(); trackEnu.clear() }

    val trackPairs: Int get() = trackWorld.size
}
