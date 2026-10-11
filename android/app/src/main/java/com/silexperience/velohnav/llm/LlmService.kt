package com.silexperience.velohnav.llm

import android.app.Service
import android.content.Intent
import android.os.Bundle
import android.os.Debug
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Message
import android.os.Messenger
import android.os.Process
import android.util.Log
import java.util.concurrent.Executors

/**
 * Le modèle natif tourne ici, dans le processus « :llm » (AndroidManifest) et non dans
 * celui de l'application. Un pilote GPU qui plante (SIGSEGV dans le pilote Vulkan) ne se
 * rattrape pas : il tue le processus. Ici, seul ce processus meurt ; LlmClient le voit
 * (binder mort), la tentative est déclarée en échec et l'échelle passe à la suivante.
 * Décharger = tuer ce processus : toute la mémoire (poids, tampons du pilote) est rendue.
 *
 * Protocole (Message.what) : requête → réponse REPLY (arg1 = numéro de requête, octets
 * JSON sous « json »). CANCEL est traité tout de suite, hors de la file de calcul.
 */
class LlmService : Service() {

    companion object {
        const val DEVICES = 1
        const val LOAD = 2
        const val WARM = 3
        const val GENERATE = 4
        const val UNLOAD = 5
        const val CANCEL = 6
        const val REPLY = 100
        private const val TAG = "VhLlm"
    }

    // Un seul calcul à la fois, hors du fil principal (une génération dure des secondes).
    private val worker = Executors.newSingleThreadExecutor { r -> Thread(r, "llm").apply { priority = Thread.MAX_PRIORITY } }
    private var libError: String? = null

    override fun onCreate() {
        super.onCreate()
        libError = LlmNative.unsupportedReason()
        if (libError == null) {
            try {
                System.loadLibrary("vh_llm")
            } catch (e: Throwable) {
                libError = "library: ${e.message}"
            }
        }
        if (libError == null) {
            // Traces des processus morts depuis longtemps : déjà lues par le greffon ou perdues.
            filesDir.listFiles { f -> f.name.startsWith("llm-trace-") && System.currentTimeMillis() - f.lastModified() > 10 * 60_000 }
                ?.forEach { it.delete() }
            LlmNative.traceTo(LlmNative.traceFile(filesDir, Process.myPid()).path.toByteArray())
        }
        Log.i(TAG, "service :llm pid ${Process.myPid()}, bibliothèque ${libError ?: "chargée"}")
    }

    private val handler = object : Handler(Looper.getMainLooper()) {
        override fun handleMessage(msg: Message) {
            val replyTo = msg.replyTo ?: return
            val id = msg.arg1
            val data = msg.data
            if (msg.what == CANCEL) {
                if (libError == null) LlmNative.cancel()
                return
            }
            val what = msg.what
            val label = data.getString("label") ?: "request $what"
            worker.execute {
                if (libError == null) LlmNative.trace("request $label".toByteArray())
                val t0 = System.currentTimeMillis()
                val json = try {
                    run(what, data)
                } catch (e: Throwable) {
                    Log.e(TAG, "requête $what en échec", e)
                    """{"ok":false,"error":${quote("${e.javaClass.simpleName}: ${e.message}")}}""".toByteArray()
                }
                // Le début de la réponse suffit à lire l'issue (ok, erreur, appareil) dans logcat.
                Log.i(TAG, "requête $what traitée en ${System.currentTimeMillis() - t0} ms : ${String(json, Charsets.UTF_8).take(300)}")
                val r = Message.obtain(null, REPLY, id, Process.myPid())
                r.data = Bundle().apply { putByteArray("json", json) }
                try { replyTo.send(r) } catch (e: Exception) { Log.w(TAG, "réponse perdue : ${e.message}") }
            }
        }
    }

    private fun run(what: Int, d: Bundle): ByteArray {
        libError?.let { return """{"ok":false,"error":${quote("unsupported: $it")}}""".toByteArray() }
        return when (what) {
            DEVICES -> """{"ok":true,"devices":${String(LlmNative.devices())}}""".toByteArray()
            LOAD -> withMemory(LlmNative.load(d.getByteArray("path")!!, d.getByteArray("backend")!!, d.getInt("nCtx"), d.getInt("nThreads")), full = true)
            WARM -> LlmNative.warm(d.getByteArray("prefix")!!)
            GENERATE -> withMemory(LlmNative.generate(d.getByteArray("prefix")!!, d.getByteArray("rest")!!, d.getInt("maxTokens"), null), full = false)
            UNLOAD -> { LlmNative.unload(); """{"ok":true}""".toByteArray() }
            else -> """{"ok":false,"error":"unknown request $what"}""".toByteArray()
        }
    }

    /**
     * Mémoire du processus :llm jointe à la réponse (« mem », en Mo) : résidente et pic
     * (/proc/self/status, immédiat). Au chargement seulement, aussi la PSS totale et la part
     * « graphique » (tampons du pilote GPU) de Debug.MemoryInfo — plus coûteuse à lire (smaps).
     * Sur téléphone la mémoire est unifiée : les poids envoyés au GPU Vulkan comptent ici.
     */
    private fun withMemory(json: ByteArray, full: Boolean): ByteArray {
        if (json.size < 3 || json[0] != '{'.code.toByte()) return json
        val m = StringBuilder()
        try {
            var rss = -1L; var hwm = -1L
            java.io.File("/proc/self/status").forEachLine { l ->
                if (l.startsWith("VmRSS:")) rss = l.substring(6).trim().split(" ")[0].toLong()
                else if (l.startsWith("VmHWM:")) hwm = l.substring(6).trim().split(" ")[0].toLong()
            }
            m.append("\"rssMB\":${rss / 1024},\"peakMB\":${hwm / 1024}")
            if (full) {
                val mi = Debug.MemoryInfo().also { Debug.getMemoryInfo(it) }
                m.append(",\"pssMB\":${mi.totalPss / 1024}")
                mi.getMemoryStat("summary.graphics")?.toLongOrNull()?.let { m.append(",\"gfxMB\":${it / 1024}") }
            }
        } catch (e: Exception) {
            Log.w(TAG, "mémoire illisible : ${e.message}")
            return json
        }
        return "{\"mem\":{$m},".toByteArray() + json.copyOfRange(1, json.size)
    }

    private val messenger = Messenger(handler)

    override fun onBind(intent: Intent?): IBinder = messenger.binder

    // Plus aucun client : le processus part avec tout ce qu'il tenait.
    override fun onUnbind(intent: Intent?): Boolean {
        Log.i(TAG, "plus de client : fin du processus :llm")
        handler.postDelayed({ Process.killProcess(Process.myPid()) }, 50)
        return false
    }
}

internal fun quote(s: String): String = buildString {
    append('"')
    for (c in s) when {
        c == '"' -> append("\\\"")
        c == '\\' -> append("\\\\")
        c == '\n' -> append("\\n")
        c < ' ' -> append(String.format("\\u%04x", c.code))
        else -> append(c)
    }
    append('"')
}
