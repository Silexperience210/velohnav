package com.silexperience.velohnav.ar

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.*

/**
 * Géométrie de l'AR ancrée au sol, mesurée sur des cas connus (point, cap,
 * position) — jamais ajustée à l'œil. JVM pur : `./gradlew testDebugUnitTest`.
 */
class GroundAnchorTest {
    private val RAD = PI / 180
    private val LAT = 49.6116; private val LNG = 6.1319   // Luxembourg-Ville

    /** Point à `e` m à l'est et `n` m au nord de (LAT, LNG). */
    private fun geo(e: Double, n: Double): Pair<Double, Double> =
        Pair(LAT + n / GroundGeo.R_EARTH / RAD,
             LNG + e / (GroundGeo.R_EARTH * cos(LAT * RAD)) / RAD)

    /** Route droite vers le nord, de 0 à `len` m. */
    private fun northRoute(len: Double = 300.0) =
        RoutePath(LAT, LNG, (0..(len / 10).toInt()).map { geo(0.0, it * 10.0) })

    private fun near(expected: Double, actual: Double, tol: Double, msg: String = "") =
        assertEquals(msg, expected, actual, tol)

    // ── Projection : point connu, cap connu ──────────────────────────
    @Test fun `face au nord, monde aligne - un point au nord est droit devant, a l'est a droite`() {
        // Visée ARCore −Z, boussole 0° → θ = 0
        val yaw = GroundGeo.yawOffset(0.0, 0.0, -1.0)!!
        near(0.0, yaw, 1e-9)
        val ahead = GroundGeo.enuToWorld(Enu(0.0, 10.0), yaw)
        near(0.0, ahead.x, 1e-9); near(-10.0, ahead.z, 1e-9)        // −Z = devant
        val east = GroundGeo.enuToWorld(Enu(10.0, 0.0), yaw)
        near(10.0, east.x, 1e-9); near(0.0, east.z, 1e-9)           // +X = droite
    }

    @Test fun `face a l'est - l'est est devant, le nord a gauche (pas en miroir)`() {
        val yaw = GroundGeo.yawOffset(90.0, 0.0, -1.0)!!
        near(90.0, yaw, 1e-9)
        val east = GroundGeo.enuToWorld(Enu(10.0, 0.0), yaw)
        near(0.0, east.x, 1e-9); near(-10.0, east.z, 1e-9)
        val north = GroundGeo.enuToWorld(Enu(0.0, 10.0), yaw)
        near(-10.0, north.x, 1e-9); near(0.0, north.z, 1e-9)        // −X = gauche
    }

    @Test fun `monde ARCore tourne au demarrage - le nord suit la direction reelle`() {
        // ARCore a démarré caméra vers +X ; à cet instant la boussole lit 0° (nord)
        val yaw = GroundGeo.yawOffset(0.0, 1.0, 0.0)!!
        near(270.0, yaw, 1e-9)
        val north = GroundGeo.enuToWorld(Enu(0.0, 10.0), yaw)
        near(10.0, north.x, 1e-9); near(0.0, north.z, 1e-9)
    }

    @Test fun `un point droit devant n'a aucun decalage lateral, quels que soient cap et lacet`() {
        // Le décalage « vers la gauche » ne peut pas venir de la conversion : pour
        // tout lacet, le point situé dans l'axe de visée reste dans l'axe.
        for (heading in listOf(0.0, 37.0, 90.0, 181.0, 270.0, 359.0))
            for (fwdAz in listOf(0.0, 45.0, 135.0, 300.0)) {
                val fx = sin(fwdAz * RAD); val fz = -cos(fwdAz * RAD)
                val yaw = GroundGeo.yawOffset(heading, fx, fz)!!
                val p = GroundGeo.enuToWorld(Enu(20 * sin(heading * RAD), 20 * cos(heading * RAD)), yaw)
                val lateral = fx * p.z - fz * p.x                       // produit vectoriel (vertical)
                val depth = fx * p.x + fz * p.z
                near(0.0, lateral, 1e-9, "cap $heading, visée $fwdAz")
                near(20.0, depth, 1e-9)
            }
    }

    @Test fun `worldToEnu est l'inverse exact de enuToWorld`() {
        for (yaw in listOf(0.0, 12.5, 90.0, 233.0, 359.9)) {
            val p = Enu(3.2, -7.9)
            val back = GroundGeo.worldToEnu(GroundGeo.enuToWorld(p, yaw), yaw)
            near(p.e, back.e, 1e-9); near(p.n, back.n, 1e-9)
        }
    }

    @Test fun `la fleche GLB vise l'azimut demande (rotation +Y main droite)`() {
        for (az in listOf(0.0, 30.0, 90.0, 200.0, 315.0)) {
            val phi = GroundGeo.modelYawDeg(az) * RAD
            // R_y(φ) · (0, 0, −1) = (−sin φ, 0, −cos φ)
            val got = GroundGeo.worldAzimuth(-sin(phi), -cos(phi))!!
            near(0.0, GroundGeo.angleDiff(az, got), 1e-9, "azimut $az")
        }
    }

    // ── Boussole native et Geospatial ─────────────────────────────────
    /** Matrice appareil → (est, nord, haut) pour une visée de cap h et d'élévation p. */
    private fun rotationFor(h: Double, p: Double): DoubleArray {
        val f = doubleArrayOf(sin(h * RAD) * cos(p * RAD), cos(h * RAD) * cos(p * RAD), sin(p * RAD))
        val right = doubleArrayOf(cos(h * RAD), -sin(h * RAD), 0.0)                 // X appareil
        val z = doubleArrayOf(-f[0], -f[1], -f[2])                                  // Z appareil = −visée
        val up = doubleArrayOf(z[1] * right[2] - z[2] * right[1],                   // Y = Z × X
                               z[2] * right[0] - z[0] * right[2],
                               z[0] * right[1] - z[1] * right[0])
        // Ligne par ligne : r[3i + j] = composante i de l'axe j
        return doubleArrayOf(right[0], up[0], z[0], right[1], up[1], z[1], right[2], up[2], z[2])
    }

    @Test fun `cap boussole de l'axe camera - debout, penche vers le sol, cas degeneres`() {
        for (h in listOf(0.0, 45.0, 90.0, 180.0, 271.0))
            for (p in listOf(0.0, -30.0, -60.0, 20.0))
                near(0.0, GroundGeo.angleDiff(h, GroundGeo.cameraHeadingFromRotationMatrix(rotationFor(h, p))!!), 1e-9, "h=$h p=$p")
        assertNull("caméra vers le sol : cap indéfini", GroundGeo.cameraHeadingFromRotationMatrix(rotationFor(90.0, -89.0)))
        // Téléphone debout face au nord, écrit à la main
        near(0.0, GroundGeo.cameraHeadingFromRotationMatrix(doubleArrayOf(1.0, 0.0, 0.0, 0.0, 0.0, -1.0, 0.0, 1.0, 0.0))!!, 1e-9)
    }

    @Test fun `quaternion est-haut-sud - relevement de la visee, inclinaison sans effet`() {
        for (b in listOf(0.0, 90.0, 135.0, 250.0)) {
            val half = -b * RAD / 2                                   // rotation +Y de −b
            near(0.0, GroundGeo.angleDiff(b, GroundGeo.bearingFromEusQuaternion(0.0, sin(half), 0.0, cos(half))!!), 1e-9)
            // Lacet puis inclinaison de −30° autour de X local : q = q_yaw · q_pitch
            val ph = -30.0 * RAD / 2
            val (yx, yy, yz, yw) = listOf(0.0, sin(half), 0.0, cos(half))
            val (px, py, pz, pw) = listOf(sin(ph), 0.0, 0.0, cos(ph))
            val qx = yw * px + yx * pw + yy * pz - yz * py
            val qy = yw * py - yx * pz + yy * pw + yz * px
            val qz = yw * pz + yx * py - yy * px + yz * pw
            val qw = yw * pw - yx * px - yy * py - yz * pz
            near(0.0, GroundGeo.angleDiff(b, GroundGeo.bearingFromEusQuaternion(qx, qy, qz, qw)!!), 1e-9, "b=$b penché")
        }
    }

    @Test fun `moyenne circulaire - autour de 0 degre, pas 180`() {
        val (m, std) = GroundGeo.circularMean(listOf(358.0, 359.0, 0.0, 1.0, 2.0))!!
        near(0.0, GroundGeo.angleDiff(0.0, m), 1e-9)
        assertTrue(std < 2.0)
    }

    // ── Ancrage : le tracé part des pieds ─────────────────────────────
    @Test fun `GPS a 6 m de la route - le premier repere est a 1 m devant les pieds`() {
        val path = northRoute()
        val al = GroundAligner(path)
        val feet = WorldXZ(2.0, -1.0); val hit = WorldXZ(2.3, -2.5)
        al.anchor(feet, hit, gpsEnu = Enu(6.0, 0.0), yaw = 0.0)
        val first = al.marks().minByOrNull { hypot(it.x, it.z) + 0.0 }!!
        val firstWorld = hit + WorldXZ(al.marks().first().x, al.marks().first().z)
        near(0.0, (firstWorld - WorldXZ(2.0, -2.0)).length(), 1e-6, "1 m devant les pieds, vers le nord")
        assertTrue(first.id >= 0)
        // Orientation : la pointe vise le nord = −Z quand θ = 0
        near(0.0, al.marks().first().yawDeg, 1e-9)
    }

    @Test fun `hors route (plus de 25 m) - origine GPS brute, pas de recalage force`() {
        val al = GroundAligner(northRoute())
        al.anchor(WorldXZ(0.0, 0.0), WorldXZ(0.0, -1.5), Enu(40.0, 50.0), 0.0)
        near(40.0, al.originEnu.e, 1e-9); near(50.0, al.originEnu.n, 1e-9)
    }

    @Test fun `le bruit de la boussole apres l'ancrage ne bouge rien`() {
        val al = GroundAligner(northRoute())
        repeat(20) { al.addYawSample(it * 50L, 0.0) }
        al.anchor(WorldXZ(0.0, 0.0), WorldXZ(0.0, -1.5), Enu(0.0, 0.0), al.compassYaw()!!)
        val before = al.marks()
        repeat(200) { al.addYawSample(2_000L + it * 30L, if (it % 2 == 0) 25.0 else -25.0) }
        assertEquals("aucune image ne recalcule l'ancrage à partir du cap brut", before, al.marks())
    }

    @Test fun `boussole dispersee - on n'ancre pas, resserree autour de 359-1 - on ancre a 0`() {
        val al = GroundAligner(northRoute())
        repeat(20) { al.addYawSample(it * 50L, if (it % 2 == 0) 20.0 else -20.0) }
        assertNull(al.compassYaw())
        val al2 = GroundAligner(northRoute())
        repeat(20) { al2.addYawSample(it * 50L, if (it % 2 == 0) 359.0 else 1.0) }
        near(0.0, GroundGeo.angleDiff(0.0, al2.compassYaw()!!), 1e-6)
        val al3 = GroundAligner(northRoute())
        repeat(5) { al3.addYawSample(it * 50L, 0.0) }
        assertNull("trop peu d'échantillons", al3.compassYaw())
    }

    @Test fun `fenetre - repères de 4 m derriere a 60 m devant, flèches de manœuvre dans la fenetre`() {
        val al = GroundAligner(northRoute())
        al.anchor(WorldXZ(0.0, 0.0), WorldXZ(0.0, -1.5), Enu(0.0, 0.0), 0.0)
        val m = al.marks(maneuverS = listOf(30.0, 200.0))
        val chevrons = m.filter { !it.maneuver }
        assertEquals(24, chevrons.size)                 // 1, 3,5 … 58,5 m
        assertEquals(1, m.count { it.maneuver })
        // Après 50 m de marche (suivi ARCore), la fenêtre avance
        al.updateUser(WorldXZ(0.0, -50.0))
        near(50.0, al.userS, 1e-6)
        // Abscisse d'un repère = −(z monde) = −(z ancre + z local)
        assertTrue(al.marks().filter { !it.maneuver }.all { -(-1.5 + it.z) in 45.9..110.1 })
    }

    // ── Dérive : ré-ancrage sans saut, correction du lacet ───────────
    @Test fun `re-ancrage en continuite - les reperes ne sautent pas`() {
        val al = GroundAligner(northRoute())
        val yaw = 30.0
        al.anchor(WorldXZ(5.0, 5.0), WorldXZ(5.0, 3.5), Enu(0.0, 0.0), yaw)
        // 70 m de marche vers le nord, vus dans le monde ARCore
        val cam = WorldXZ(5.0, 5.0) + GroundGeo.enuToWorld(Enu(0.0, 70.0), yaw)
        assertTrue(al.needsReanchor(cam))
        val worldAt = { s: Double -> al.anchorWorld + al.localOf(al.path.pointAt(s)) }
        val before = listOf(80.0, 100.0, 120.0).map(worldAt)
        al.reanchor(cam, cam + WorldXZ(0.0, -1.5))
        val after = listOf(80.0, 100.0, 120.0).map(worldAt)
        before.zip(after).forEach { (b, a) -> near(0.0, (a - b).length(), 1e-6) }
        near(70.0, al.userS, 1e-6)
    }

    @Test fun `boussole faussee de 15 degres - la trajectoire marchee la corrige`() {
        val trueYaw = 30.0
        val al = GroundAligner(northRoute())
        val feet0 = WorldXZ(1.0, 2.0)
        al.anchor(feet0, feet0 + WorldXZ(0.0, -1.5), Enu(0.0, 0.0), trueYaw + 15.0)
        // Marche réelle de 45 m vers le nord ; GPS bruité de ±3 m (déterministe)
        var seed = 7L
        fun noise(): Double { seed = (seed * 1103515245 + 12345) and 0x7fffffff; return (seed % 600) / 100.0 - 3.0 }
        var cam = feet0
        for (i in 0..18) {
            val trueEnu = Enu(0.0, i * 2.5)
            cam = feet0 + GroundGeo.enuToWorld(trueEnu, trueYaw)
            al.addTrackPair(cam, Enu(trueEnu.e + noise(), trueEnu.n + noise()), 5.0)
        }
        val corrected = al.trackYawCorrection()
        assertNotNull(corrected)
        near(0.0, GroundGeo.angleDiff(trueYaw, corrected!!), 4.0)
        al.reanchor(cam, cam + WorldXZ(0.0, -1.5), corrected)
        // Un point de la route 20 m plus loin tombe là où il est vraiment (à < 1,5 m)
        val trueWorld = feet0 + GroundGeo.enuToWorld(Enu(0.0, 65.0), trueYaw)
        val drawn = al.anchorWorld + al.localOf(al.path.pointAt(65.0))
        assertTrue("écart ${(drawn - trueWorld).length()} m", (drawn - trueWorld).length() < 1.5 + 45 * sin(4 * RAD))
    }

    @Test fun `immobile ou GPS imprecis - aucune correction`() {
        val al = GroundAligner(northRoute())
        al.anchor(WorldXZ(0.0, 0.0), WorldXZ(0.0, -1.5), Enu(0.0, 0.0), 10.0)
        repeat(30) { al.addTrackPair(WorldXZ(0.1 * (it % 2), 0.0), Enu(it % 3 - 1.0, 0.0), 5.0) }
        assertNull(al.trackYawCorrection())
        assertEquals(1, al.trackPairs)                                  // pas bougé : paires refusées
        al.addTrackPair(WorldXZ(0.0, -30.0), Enu(0.0, 30.0), 25.0)
        assertEquals("GPS à ±25 m refusé", 1, al.trackPairs)
    }

    @Test fun `fitYaw retrouve le lacet exact sans bruit, y compris pres de 360`() {
        for (yaw in listOf(0.0, 45.0, 181.0, 350.0)) {
            val enu = (0..10).map { Enu(it * 3.0, it * it * 0.5) }
            val world = enu.map { GroundGeo.enuToWorld(it, yaw) + WorldXZ(12.0, -4.0) }
            val fit = GroundGeo.fitYaw(world, enu)!!
            near(0.0, GroundGeo.angleDiff(yaw, fit.yawDeg), 1e-6, "lacet $yaw")
            near(0.0, fit.rmsM, 1e-6)
        }
    }

    // ── Route ─────────────────────────────────────────────────────────
    @Test fun `projection sur la route - l'indice de progression evite un saut sur une boucle`() {
        // Aller 100 m vers le nord, 8 m vers l'est, retour 100 m vers le sud
        val pts = listOf(geo(0.0, 0.0), geo(0.0, 100.0), geo(8.0, 100.0), geo(8.0, 0.0))
        val path = RoutePath(LAT, LNG, pts)
        near(208.0, path.length, 0.05)
        val p = Enu(4.5, 20.0)                                           // entre l'aller et le retour
        near(20.0, path.project(p, hint = 18.0).first, 0.05)            // on est sur l'aller
        near(188.0, path.project(p, hint = 185.0).first, 0.05)          // on est sur le retour
        near(90.0, path.bearingAt(101.0), 1e-3)
        near(180.0, path.bearingAt(150.0), 1e-3)
    }

    @Test fun `conversion GPS - meme formule que le web, 100 m au nord et a l'est`() {
        val (la, ln) = geo(100.0, 100.0)
        val d = GroundGeo.enuOffset(LAT, LNG, la, ln)
        near(100.0, d.n, 0.01); near(100.0, d.e, 0.05)
    }
}
