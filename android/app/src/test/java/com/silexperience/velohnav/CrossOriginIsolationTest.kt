package com.silexperience.velohnav

import org.junit.Assert.assertEquals
import org.junit.Test

class CrossOriginIsolationTest {
    @Test
    fun ajouteCoopEtCoepSansPerdreLesAutresEnTetes() {
        val out = CrossOriginIsolation.withIsolation(mapOf("Content-Type" to "text/html", "Cache-Control" to "no-cache"))
        assertEquals("text/html", out["Content-Type"])
        assertEquals("no-cache", out["Cache-Control"])
        assertEquals("same-origin", out["Cross-Origin-Opener-Policy"])
        assertEquals("credentialless", out["Cross-Origin-Embedder-Policy"])
    }

    @Test
    fun remplaceUneValeurExistanteQuelleQueSoitSaCasse() {
        val out = CrossOriginIsolation.withIsolation(mapOf("cross-origin-embedder-policy" to "unsafe-none"))
        assertEquals(2, out.size)
        assertEquals("credentialless", out["Cross-Origin-Embedder-Policy"])
    }

    @Test
    fun reponseSansEnTetes() {
        assertEquals(CrossOriginIsolation.HEADERS, CrossOriginIsolation.withIsolation(null))
    }
}
