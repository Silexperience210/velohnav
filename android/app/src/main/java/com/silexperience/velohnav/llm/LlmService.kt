package com.silexperience.velohnav.llm

import android.app.Service
import android.content.Intent
import android.os.Bundle
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
            worker.execute {
                val json = try {
                    run(what, data)
                } catch (e: Throwable) {
                    """{"ok":false,"error":${quote("${e.javaClass.simpleName}: ${e.message}")}}""".toByteArray()
                }
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
            LOAD -> LlmNative.load(d.getByteArray("path")!!, d.getByteArray("backend")!!, d.getInt("nCtx"), d.getInt("nThreads"))
            WARM -> LlmNative.warm(d.getByteArray("prefix")!!)
            GENERATE -> LlmNative.generate(d.getByteArray("prefix")!!, d.getByteArray("rest")!!, d.getInt("maxTokens"), null)
            UNLOAD -> { LlmNative.unload(); """{"ok":true}""".toByteArray() }
            else -> """{"ok":false,"error":"unknown request $what"}""".toByteArray()
        }
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
