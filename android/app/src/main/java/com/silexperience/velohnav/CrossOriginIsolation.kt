package com.silexperience.velohnav

import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import com.getcapacitor.Bridge
import com.getcapacitor.BridgeWebViewClient

/**
 * Isolation cross-origin de la WebView (COOP/COEP) : condition de SharedArrayBuffer,
 * donc des fils multiples du moteur processeur du modèle local (onnxruntime-web).
 *
 * Mesuré dans Chrome avec le worker de l'application (scripts/bench-chat, mode
 * « prefixe ») : 4 fils au lieu d'un rendent le modèle ~3,4 fois plus rapide
 * (consigne 25,2 s → 7,4 s ; réponses 21,7 / 39,7 / 16,8 s → 6,5 / 11,2 / 4,8 s).
 * Sans ces en-têtes, la WebView n'est jamais isolée et le moteur reste sur un fil.
 *
 * COEP « credentialless » et non « require-corp » : les ressources d'autres origines
 * (tuiles de carte, polices) restent chargées sans exiger d'en-tête CORP de leurs
 * serveurs. Une WebView qui ne connaît pas « credentialless » ignore l'en-tête : la
 * page n'est alors simplement pas isolée et le moteur garde un fil (modelWorker.
 * wasmThreads), sans rien casser. Seules les réponses du serveur local de Capacitor
 * (l'application elle-même) reçoivent ces en-têtes.
 */
object CrossOriginIsolation {
    val HEADERS: Map<String, String> = mapOf(
        "Cross-Origin-Opener-Policy" to "same-origin",
        "Cross-Origin-Embedder-Policy" to "credentialless",
    )

    /** En-têtes d'une réponse locale, isolation ajoutée (ceux déjà présents sont remplacés). */
    fun withIsolation(headers: Map<String, String>?): Map<String, String> {
        val out = LinkedHashMap<String, String>()
        headers?.forEach { (k, v) -> if (HEADERS.keys.none { it.equals(k, ignoreCase = true) }) out[k] = v }
        out.putAll(HEADERS)
        return out
    }
}

/** Client WebView de Capacitor, réponses locales isolées (voir CrossOriginIsolation). */
class IsolatingWebViewClient(bridge: Bridge) : BridgeWebViewClient(bridge) {
    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
        val response = super.shouldInterceptRequest(view, request) ?: return null
        response.responseHeaders = CrossOriginIsolation.withIsolation(response.responseHeaders)
        return response
    }
}
