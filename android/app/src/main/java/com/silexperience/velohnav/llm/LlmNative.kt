package com.silexperience.velohnav.llm

import android.os.Build
import java.io.File

/**
 * Moteur conversationnel natif (llama.cpp, src/main/cpp) — appelé UNIQUEMENT depuis
 * LlmService, dans le processus séparé « :llm » : un plantage du pilote GPU y tue ce
 * processus, pas l'application.
 *
 * Toutes les chaînes passent en octets UTF-8 (voir vh_llm_jni.cpp).
 */
object LlmNative {

    /** Reçoit le texte au fil de la génération ; rendre false l'interrompt. */
    fun interface PieceSink { fun onPiece(piece: ByteArray): Boolean }

    external fun devices(): ByteArray
    external fun load(path: ByteArray, backend: ByteArray, nCtx: Int, nThreads: Int): ByteArray
    external fun warm(prefix: ByteArray): ByteArray
    external fun generate(prefix: ByteArray, rest: ByteArray, maxTokens: Int, sink: PieceSink?): ByteArray
    external fun cancel()
    external fun unload()

    /**
     * Pourquoi la bibliothèque ne peut pas tourner ici, ou null si elle le peut :
     * construite pour arm64 avec le produit scalaire 8 bits et la demi-précision
     * (armv8.2-a+dotprod+fp16), et liée à libvulkan.so d'Android 9 (API 28). Sans ce
     * contrôle, un processeur plus ancien mourrait d'une instruction illégale.
     */
    fun unsupportedReason(): String? {
        if (Build.VERSION.SDK_INT < 28) return "android-${Build.VERSION.SDK_INT}"
        if ("arm64-v8a" !in Build.SUPPORTED_ABIS) return "abi-${Build.SUPPORTED_ABIS.joinToString("/")}"
        val feats = cpuFeatures()
        if (feats.isNotEmpty() && !("asimddp" in feats && "asimdhp" in feats)) return "cpu-no-dotprod-fp16"
        return null
    }

    fun cpuFeatures(): Set<String> = try {
        File("/proc/cpuinfo").readLines()
            .firstOrNull { it.startsWith("Features") }
            ?.substringAfter(":")?.trim()?.split(Regex("\\s+"))?.toSet() ?: emptySet()
    } catch (_: Exception) { emptySet() }

    /**
     * Fils de calcul : les cœurs « gros » (fréquence maximale au-dessus de celle des plus
     * petits cœurs), 2 à 4. Les petits cœurs ralentiraient le calcul au lieu de l'aider :
     * chaque étape attend le fil le plus lent.
     */
    fun bigCores(): Int = try {
        val freqs = (0 until Runtime.getRuntime().availableProcessors()).mapNotNull { i ->
            File("/sys/devices/system/cpu/cpu$i/cpufreq/cpuinfo_max_freq").takeIf { it.canRead() }?.readText()?.trim()?.toLongOrNull()
        }
        val min = freqs.minOrNull()
        val big = if (freqs.isEmpty() || min == null) 4 else freqs.count { it > min }.takeIf { it > 0 } ?: freqs.size
        big.coerceIn(2, 4)
    } catch (_: Exception) { 4 }
}
