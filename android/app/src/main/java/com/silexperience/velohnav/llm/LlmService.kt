package com.silexperience.velohnav.llm

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Bundle
import android.os.Debug
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Message
import android.os.Messenger
import android.os.Process
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import com.silexperience.velohnav.R
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
 *
 * Modèle gardé entre deux visites : une fois un modèle chargé, le service passe au premier
 * plan (notification permanente « modèle local actif », bouton « Arrêter ») et survit au
 * départ de l'application. Au retour, un LOAD identique (même fichier, même moteur, même
 * contexte) répond tout de suite avec « reused »: true, sans relire les poids. Sans modèle
 * chargé, le processus part toujours avec son dernier client, comme avant.
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
        /** Bouton « Arrêter » de la notification : le modèle est déchargé, la mémoire rendue. */
        const val ACTION_STOP = "com.silexperience.velohnav.llm.STOP"
        private const val CHANNEL = "llm"
        private const val NOTIFICATION = 7301
    }

    // Un seul calcul à la fois, hors du fil principal (une génération dure des secondes).
    private val worker = Executors.newSingleThreadExecutor { r -> Thread(r, "llm").apply { priority = Thread.MAX_PRIORITY } }
    private var libError: String? = null

    // Modèle en mémoire (fil « llm » seulement) : clé du LOAD réussi et sa réponse, rejouée
    // telle quelle à un LOAD identique.
    private var loadedKey: String? = null
    private var loadedJson: ByteArray? = null
    // Fil principal seulement.
    private var foreground = false
    private var clients = false
    @Volatile private var stopped = false

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
            LOAD -> load(d)
            WARM -> stoppedReply() ?: LlmNative.warm(d.getByteArray("prefix")!!)
            GENERATE -> stoppedReply() ?: withMemory(LlmNative.generate(d.getByteArray("prefix")!!, d.getByteArray("rest")!!, d.getInt("maxTokens"), null), full = false)
            UNLOAD -> { forget(); """{"ok":true}""".toByteArray() }
            else -> """{"ok":false,"error":"unknown request $what"}""".toByteArray()
        }
    }

    /**
     * Même fichier, même moteur, même contexte que le modèle en mémoire : sa réponse de
     * chargement est rendue avec « reused »: true (mémoire relue), en quelques millisecondes.
     * Sinon le moteur charge (et décharge d'abord l'ancien). Réussi : premier plan.
     */
    private fun load(d: Bundle): ByteArray {
        val path = d.getByteArray("path")!!
        val backend = d.getByteArray("backend")!!
        val key = "${String(path)}|${String(backend)}|${d.getInt("nCtx")}"
        val kept = loadedJson
        if (key == loadedKey && kept != null) {
            Log.i(TAG, "modèle déjà en mémoire ($key) : rechargement évité")
            return withMemory("{\"reused\":true,".toByteArray() + kept.copyOfRange(1, kept.size), full = false)
        }
        forget()
        val json = LlmNative.load(path, backend, d.getInt("nCtx"), d.getInt("nThreads"), d.getBoolean("calibrate", true))
        if (String(json, Charsets.UTF_8).startsWith("{\"ok\":true")) {
            loadedKey = key
            loadedJson = json
            stopped = false
            handler.post { keepAlive() }
        }
        return withMemory(json, full = true)
    }

    /** Modèle déchargé ; plus rien à garder au premier plan. */
    private fun forget() {
        loadedKey = null
        loadedJson = null
        LlmNative.unload()
        handler.post { leaveForeground() }
    }

    // Arrêté depuis la notification alors que l'application était reliée : elle doit recharger.
    private fun stoppedReply(): ByteArray? =
        if (stopped && loadedKey == null) """{"ok":false,"error":"stopped: model stopped from the notification"}""".toByteArray() else null

    /**
     * Premier plan : le service est aussi « démarré » (il survit au départ du dernier client)
     * et montre sa notification. Refusé par le système (application déjà en arrière-plan
     * quand le chargement finit) : le modèle reste, mais part avec le dernier client.
     */
    private fun keepAlive() {
        if (foreground) return
        try {
            startService(Intent(this, LlmService::class.java))
            ServiceCompat.startForeground(this, NOTIFICATION, notification(),
                if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0)
            foreground = true
            Log.i(TAG, "modèle gardé en mémoire : service de premier plan")
        } catch (e: Exception) {
            Log.w(TAG, "premier plan refusé : ${e.message}")
        }
    }

    private fun leaveForeground() {
        if (!foreground) return
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
        foreground = false
    }

    private fun notification(): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL, getString(R.string.llm_channel), NotificationManager.IMPORTANCE_LOW)
                .apply { description = getString(R.string.llm_channel_description); setShowBadge(false) })
        }
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val stop = PendingIntent.getService(this, 0, Intent(this, LlmService::class.java).setAction(ACTION_STOP), flags)
        val open = packageManager.getLaunchIntentForPackage(packageName)?.let { PendingIntent.getActivity(this, 0, it, flags) }
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_llm)
            .setContentTitle(getString(R.string.llm_notification_title))
            .setContentText(getString(R.string.llm_notification_text))
            .setStyle(NotificationCompat.BigTextStyle().bigText(getString(R.string.llm_notification_text)))
            .setContentIntent(open)
            .addAction(0, getString(R.string.llm_notification_stop), stop)
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    /**
     * Démarrage par keepAlive (sans action) ou bouton « Arrêter ». Jamais relancé par le
     * système après sa mort : un service relancé n'aurait plus de modèle à garder.
     */
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) stop()
        else if (!foreground) stopSelf(startId)   // démarré sans modèle chargé : rien à garder
        return START_NOT_STICKY
    }

    /**
     * « Arrêter » : la génération en cours s'interrompt, le modèle est déchargé. Sans client,
     * le processus part avec toute sa mémoire ; avec un client, il reste relié et répond
     * « stopped » jusqu'au prochain chargement.
     */
    private fun stop() {
        Log.i(TAG, "arrêt demandé depuis la notification (client relié : $clients)")
        stopped = true
        leaveForeground()
        if (libError == null) LlmNative.cancel()
        worker.execute {
            loadedKey = null
            loadedJson = null
            if (libError == null) LlmNative.unload()
            handler.post { if (!clients) Process.killProcess(Process.myPid()) }
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

    override fun onBind(intent: Intent?): IBinder { clients = true; return messenger.binder }

    override fun onRebind(intent: Intent?) { clients = true }

    // Plus aucun client : modèle au premier plan, il reste pour le prochain retour ;
    // sinon le processus part avec tout ce qu'il tenait.
    override fun onUnbind(intent: Intent?): Boolean {
        clients = false
        if (foreground) {
            Log.i(TAG, "plus de client : modèle gardé en mémoire (premier plan)")
            return true
        }
        Log.i(TAG, "plus de client : fin du processus :llm")
        handler.postDelayed({ Process.killProcess(Process.myPid()) }, 50)
        return true
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
