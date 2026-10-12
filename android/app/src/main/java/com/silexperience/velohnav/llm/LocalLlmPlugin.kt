package com.silexperience.velohnav.llm

import android.Manifest
import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Message
import android.os.Messenger
import android.os.Process
import android.util.Log
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import dalvik.system.BaseDexClassLoader
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Pont entre l'application (src/ai/nativeModel.js) et le moteur natif (LlmService, processus
 * « :llm »). Télécharge le modèle GGUF dans le stockage de l'application, le charge sur le
 * moteur demandé (« vulkan » : GPU, « cpu » : processeur) et génère.
 *
 * Toute réponse du moteur est rendue telle quelle (JSON) : l'erreur exacte du pilote ou de
 * llama.cpp et les dernières lignes de son journal arrivent jusqu'à l'interface. Si le
 * processus :llm meurt pendant une requête (pilote GPU), la requête échoue avec
 * « crash » : c'est la seule trace possible d'un plantage natif.
 */
@CapacitorPlugin(name = "LocalLlm")
class LocalLlmPlugin : Plugin() {

    private companion object {
        const val TAG = "VhLlm"
        const val BIND_MS = 20_000L   // liaison au processus :llm, au plus
    }

    private val main = Handler(Looper.getMainLooper())

    // ── Fichier du modèle ────────────────────────────────────────────────────
    private fun modelsDir() = File(context.filesDir, "models").apply { mkdirs() }

    /** Nom de fichier simple seulement : jamais de chemin venu du JavaScript. */
    private fun modelFile(call: PluginCall): File? {
        val name = call.getString("file") ?: return null
        if (!Regex("^[A-Za-z0-9._-]+\\.gguf$").matches(name)) return null
        return File(modelsDir(), name)
    }

    @PluginMethod(returnType = PluginMethod.RETURN_PROMISE)
    fun status(call: PluginCall) {
        val ret = JSObject()
        // APK construite sans -PvhNative : le greffon est là, la bibliothèque non. Sans ce
        // contrôle, l'application téléchargerait le modèle GGUF (219 Mo) avant de découvrir
        // au chargement qu'aucun moteur ne peut le lire.
        val packaged = (context.classLoader as? BaseDexClassLoader)?.findLibrary("vh_llm") != null
        val reason = if (!packaged) "not-built" else LlmNative.unsupportedReason()
        ret.put("supported", reason == null)
        ret.put("reason", reason ?: "")
        ret.put("sdk", Build.VERSION.SDK_INT)
        ret.put("device", "${Build.MANUFACTURER} ${Build.MODEL}")
        ret.put("soc", if (Build.VERSION.SDK_INT >= 31) "${Build.SOC_MANUFACTURER} ${Build.SOC_MODEL}" else Build.HARDWARE)
        ret.put("bigCores", LlmNative.bigCores())
        modelFile(call)?.let { f ->
            ret.put("modelExists", f.isFile)
            ret.put("modelBytes", if (f.isFile) f.length().toDouble() else 0.0)
            val part = File(f.path + ".part")
            ret.put("partialBytes", if (part.isFile) part.length().toDouble() else 0.0)
        }
        // Trace logcat (adb logcat -s VhLlm) : la preuve que le JavaScript a atteint le greffon.
        Log.i(TAG, "status : bibliothèque ${if (packaged) "embarquée" else "absente"}, ${reason ?: "pris en charge"}, " +
            "${ret.getString("soc")}, modèle ${ret.opt("modelExists")} (${ret.opt("modelBytes")} o, partiel ${ret.opt("partialBytes")} o)")
        call.resolve(ret)
    }

    private val downloadCancel = AtomicBoolean(false)
    @Volatile private var downloading = false

    /**
     * Téléchargement du modèle, repris là où il s'était arrêté (fichier .part + en-tête
     * Range), taille et SHA-256 vérifiées avant d'être accepté. Progression : événement
     * « downloadProgress » { loaded, total }.
     */
    @PluginMethod(returnType = PluginMethod.RETURN_PROMISE)
    fun download(call: PluginCall) {
        val f = modelFile(call) ?: return call.reject("bad file", "bad-file")
        val url = call.getString("url") ?: return call.reject("no url", "bad-url")
        val bytes = call.getDouble("bytes")?.toLong() ?: 0L
        val sha = call.getString("sha256")?.lowercase() ?: ""
        if (downloading) return call.reject("download already running", "busy")
        if (f.isFile && (bytes == 0L || f.length() == bytes)) {
            call.resolve(JSObject().put("path", f.path).put("cached", true))
            return
        }
        downloading = true
        downloadCancel.set(false)
        Log.i(TAG, "téléchargement de ${f.name} ($bytes o attendus)")
        Thread({
            try {
                val part = File(f.path + ".part")
                fetch(url, part, bytes)
                if (bytes > 0 && part.length() != bytes) throw IllegalStateException("size ${part.length()} != $bytes")
                if (sha.isNotEmpty()) {
                    val got = sha256(part)
                    if (got != sha) { part.delete(); throw IllegalStateException("sha256 $got != $sha") }
                }
                if (!part.renameTo(f)) throw IllegalStateException("rename failed")
                Log.i(TAG, "${f.name} reçu, taille et SHA-256 vérifiées")
                call.resolve(JSObject().put("path", f.path).put("cached", false))
            } catch (e: Exception) {
                Log.w(TAG, "téléchargement interrompu : ${e.message}")
                call.reject(e.message ?: e.javaClass.simpleName, if (downloadCancel.get()) "cancelled" else "network")
            } finally {
                downloading = false
            }
        }, "llm-download").start()
    }

    private fun fetch(url: String, part: File, expected: Long) {
        var from = if (part.isFile) part.length() else 0L
        if (expected > 0 && from > expected) { part.delete(); from = 0 }
        if (expected > 0 && from == expected) return
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = 20_000
        c.readTimeout = 60_000
        if (from > 0) c.setRequestProperty("Range", "bytes=$from-")
        val code = c.responseCode
        if (code != 200 && code != 206) throw IllegalStateException("HTTP $code")
        if (code == 200) from = 0   // le serveur ignore la reprise : on repart de zéro
        val total = if (expected > 0) expected else from + c.contentLengthLong
        var loaded = from
        var last = 0L
        c.inputStream.use { input ->
            FileOutputStream(part, from > 0).use { out ->
                val buf = ByteArray(256 * 1024)
                while (true) {
                    if (downloadCancel.get()) throw IllegalStateException("cancelled")
                    val n = input.read(buf)
                    if (n < 0) break
                    out.write(buf, 0, n)
                    loaded += n
                    val now = System.currentTimeMillis()
                    if (now - last > 250 || loaded == total) {
                        last = now
                        notifyListeners("downloadProgress", JSObject().put("loaded", loaded.toDouble()).put("total", total.toDouble()))
                    }
                }
            }
        }
    }

    private fun sha256(f: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        f.inputStream().use { s ->
            val buf = ByteArray(1 shl 20)
            while (true) { val n = s.read(buf); if (n < 0) break; md.update(buf, 0, n) }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    @PluginMethod(returnType = PluginMethod.RETURN_PROMISE)
    fun cancelDownload(call: PluginCall) {
        downloadCancel.set(true)
        call.resolve()
    }

    /** Supprime les modèles GGUF (et morceaux) sauf `keep` : un seul modèle sur l'appareil. */
    @PluginMethod(returnType = PluginMethod.RETURN_PROMISE)
    fun deleteModels(call: PluginCall) {
        val keep = call.getString("keep") ?: ""
        var freed = 0L
        modelsDir().listFiles()?.forEach { f ->
            if (f.name != keep && (f.name.endsWith(".gguf") || f.name.endsWith(".gguf.part"))) { freed += f.length(); f.delete() }
        }
        call.resolve(JSObject().put("freedBytes", freed.toDouble()))
    }

    // ── Processus :llm ───────────────────────────────────────────────────────
    private var service: Messenger? = null
    private var servicePid = 0
    private var bound = false
    private var seq = 0
    private val pending = HashMap<Int, (ByteArray?, String?) -> Unit>()
    private val queued = ArrayList<Message>()
    // Ce que faisait le processus quand il est mort : dit dans l'erreur « crash ».
    private var lastRequest = ""
    private var lastRequestAt = 0L

    private val replies = Messenger(object : Handler(Looper.getMainLooper()) {
        override fun handleMessage(msg: Message) {
            if (msg.what != LlmService.REPLY) return
            if (msg.arg2 > 0) servicePid = msg.arg2
            Log.i(TAG, "réponse n° ${msg.arg1} du processus :llm (pid ${msg.arg2})")
            pending.remove(msg.arg1)?.invoke(msg.data.getByteArray("json"), null)
        }
    })

    private val conn = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            service = Messenger(binder)
            // Pid connu dès la liaison : un plantage pendant la PREMIÈRE requête (le chargement)
            // doit pouvoir être expliqué (trace, raison de sortie), avant toute réponse.
            if (servicePid <= 0) servicePid = llmPid()
            Log.i(TAG, "processus :llm relié (pid $servicePid), ${queued.size} requête(s) en attente")
            queued.forEach { sendNow(it) }
            queued.clear()
        }

        // Le processus :llm est mort (plantage natif, ou tué par le système)
        override fun onServiceDisconnected(name: ComponentName?) {
            Log.w("VhLlm", "processus :llm mort pendant : $lastRequest")
            dropService("crash during $lastRequest", diagnose = true)
        }

        override fun onBindingDied(name: ComponentName?) = dropService("binding died during $lastRequest", diagnose = true)
    }

    /**
     * `diagnose` : le processus est mort sans répondre. Les requêtes en cours échouent avec la
     * raison complète — ce que le système dit de sa mort et la fin de sa trace —, lue hors du
     * fil principal (la raison de sortie peut arriver un instant après la déconnexion).
     */
    private fun dropService(reason: String, diagnose: Boolean = false) {
        val pid = servicePid
        val since = lastRequestAt
        service = null
        if (bound) { try { context.unbindService(conn) } catch (_: Exception) {} }
        bound = false
        servicePid = 0
        queued.clear()
        val fails = pending.values.toList()
        pending.clear()
        if (!diagnose) { fails.forEach { it(null, reason) }; return }
        Thread({
            val full = crashReport(reason, pid, since)
            Log.w(TAG, full)
            main.post { fails.forEach { it(null, full) } }
        }, "llm-crash-report").start()
    }

    /** Pid du processus :llm de cette application, ou 0. */
    private fun llmPid(): Int = try {
        (context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager).runningAppProcesses
            ?.firstOrNull { it.processName == "${context.packageName}:llm" }?.pid ?: 0
    } catch (_: Exception) { 0 }

    /**
     * Pourquoi le processus :llm est mort, en une ligne : « crash during load vulkan |
     * exit native-crash SIGSEGV, rss 412 Mo | trace: @ load vulkan: context | !! signal SIGSEGV… ».
     * Distingue le plantage natif (pilote GPU), la mémoire (tué par le système) et le reste.
     */
    private fun crashReport(reason: String, pid: Int, since: Long): String {
        val parts = mutableListOf(reason)
        exitReason(pid, since)?.let { parts += "exit $it" }
        if (pid > 0) {
            val f = LlmNative.traceFile(context.filesDir, pid)
            if (f.isFile) {
                val lines = f.readLines().filter { it.isNotBlank() }
                // Les étapes et le signal d'abord ; puis la fin du journal du moteur.
                val keep = (lines.filter { it.startsWith("@ ") || it.startsWith("!! ") }.takeLast(4) +
                    lines.filter { !it.startsWith("@ ") && !it.startsWith("!! ") }.takeLast(6)).distinct()
                parts += "trace: ${keep.joinToString(" / ") { it.take(200) }}"
                f.delete()
            } else parts += "trace: none"
        }
        return parts.joinToString(" | ").take(1500)
    }

    /** Raison de sortie enregistrée par le système (Android 11+), attendue jusqu'à 1,5 s. */
    private fun exitReason(pid: Int, since: Long): String? {
        if (Build.VERSION.SDK_INT < 30) return null
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        repeat(6) {
            val e = try {
                am.getHistoricalProcessExitReasons(context.packageName, 0, 8)
                    .firstOrNull { it.processName.endsWith(":llm") && (pid <= 0 || it.pid == pid) && it.timestamp >= since - 2_000 }
            } catch (_: Exception) { null }
            if (e != null) {
                val kind = when (e.reason) {
                    ApplicationExitInfo.REASON_CRASH_NATIVE -> "native-crash"
                    ApplicationExitInfo.REASON_CRASH -> "java-crash"
                    ApplicationExitInfo.REASON_LOW_MEMORY -> "low-memory"
                    ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE -> "excessive-resource"
                    ApplicationExitInfo.REASON_SIGNALED -> "signaled"
                    ApplicationExitInfo.REASON_ANR -> "anr"
                    ApplicationExitInfo.REASON_EXIT_SELF -> "exit-self"
                    ApplicationExitInfo.REASON_USER_REQUESTED -> "user-requested"
                    ApplicationExitInfo.REASON_DEPENDENCY_DIED -> "dependency-died"
                    else -> "reason-${e.reason}"
                }
                val sig = if (e.reason == ApplicationExitInfo.REASON_CRASH_NATIVE || e.reason == ApplicationExitInfo.REASON_SIGNALED) " signal ${e.status}" else ""
                return "$kind$sig, rss ${e.rss / 1024} Mo, pss ${e.pss / 1024} Mo${e.description?.let { ", ${it.take(160)}" } ?: ""}"
            }
            Thread.sleep(250)
        }
        return null
    }

    private fun sendNow(m: Message) {
        try { service?.send(m) } catch (e: Exception) { dropService("send failed: ${e.message}") }
    }

    private fun request(what: Int, label: String, data: Bundle, done: (ByteArray?, String?) -> Unit) {
        main.post {
            val id = ++seq
            pending[id] = done
            lastRequest = label
            lastRequestAt = System.currentTimeMillis()
            data.putString("label", label)
            val m = Message.obtain(null, what, id, 0).apply { this.data = data; replyTo = replies }
            if (service != null) { sendNow(m); return@post }
            queued.add(m)
            if (!bound) {
                bound = context.bindService(Intent(context, LlmService::class.java), conn,
                    Context.BIND_AUTO_CREATE or Context.BIND_IMPORTANT)
                Log.i(TAG, "requête n° $id ($label) : liaison au processus :llm ${if (bound) "demandée" else "refusée"}")
                if (!bound) dropService("bindService refused")
                // Android peut différer le redémarrage d'un service dont le processus vient de
                // mourir (Vulkan) : la liaison reste alors muette, et le chargement suivant
                // attendait tout son délai. Un processus qui démarre répond en 1 à 2 s.
                else main.postDelayed({
                    if (service == null && pending.containsKey(id)) dropService("bind: no :llm process after ${BIND_MS / 1000} s")
                }, BIND_MS)
            }
        }
    }

    /** Réponse du moteur rendue telle quelle à l'application (JSON du moteur sous « result »). */
    private fun relay(call: PluginCall) = { json: ByteArray?, crash: String? ->
        // « bind » : le processus n'a jamais répondu — rien n'a tourné, rien n'est prouvé du moteur.
        if (json == null) call.reject(crash ?: "crash", if (crash?.startsWith("bind:") == true) "bind" else "crash")
        else call.resolve(JSObject().put("result", String(json, Charsets.UTF_8)).put("pid", servicePid))
    }

    @PluginMethod(returnType = PluginMethod.RETURN_PROMISE)
    fun devices(call: PluginCall) = request(LlmService.DEVICES, "devices", Bundle(), relay(call))

    @PluginMethod(returnType = PluginMethod.RETURN_PROMISE)
    fun load(call: PluginCall) {
        val f = modelFile(call) ?: return call.reject("bad file", "bad-file")
        if (!f.isFile) return call.reject("model missing", "missing")
        val backend = call.getString("backend") ?: "cpu"
        val b = Bundle().apply {
            putByteArray("path", f.path.toByteArray())
            putByteArray("backend", backend.toByteArray())
            putInt("nCtx", call.getInt("nCtx") ?: 4096)
            putInt("nThreads", call.getInt("nThreads") ?: LlmNative.bigCores())
            putBoolean("calibrate", call.getBoolean("calibrate") ?: true)
        }
        askNotifications()
        request(LlmService.LOAD, "load $backend", b, relay(call))
    }

    /**
     * Modèle chargé, le service passe au premier plan avec une notification (« modèle local
     * actif », bouton « Arrêter »). Android 13+ : sans cette permission elle n'apparaît pas
     * dans le volet — le service tourne quand même. Demandée une seule fois.
     */
    private fun askNotifications() {
        if (Build.VERSION.SDK_INT < 33) return
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        val prefs = context.getSharedPreferences("llm", Context.MODE_PRIVATE)
        if (prefs.getBoolean("askedNotifications", false)) return
        val act = activity ?: return
        prefs.edit().putBoolean("askedNotifications", true).apply()
        main.post { ActivityCompat.requestPermissions(act, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 7301) }
    }

    /**
     * Où en est la requête en cours, lu sans la déranger : la dernière étape écrite à la
     * trace du processus :llm (« load cpu: threads 2/3 »…), depuis quand plus rien n'y est
     * écrit, ou « bind » si le processus n'est pas encore relié (Android peut différer le
     * redémarrage d'un service mort). L'application l'affiche pendant un chargement long et
     * le joint à l'erreur « timeout » : on sait quelle sous-étape a figé.
     */
    @PluginMethod(returnType = PluginMethod.RETURN_PROMISE)
    fun stage(call: PluginCall) {
        main.post {
            val ret = JSObject()
                .put("request", lastRequest)
                .put("requestMs", if (lastRequestAt > 0) (System.currentTimeMillis() - lastRequestAt).toDouble() else 0.0)
                .put("bound", service != null)
                .put("queued", queued.size)
                .put("pid", servicePid)
            val pid = servicePid
            val binding = service == null && queued.isNotEmpty()
            Thread({
                if (binding) ret.put("stage", "bind")
                else if (pid > 0) lastStage(LlmNative.traceFile(context.filesDir, pid))?.let { (stage, ms) ->
                    ret.put("stage", stage).put("idleMs", ms.toDouble())
                }
                call.resolve(ret)
            }, "llm-stage").start()
        }
    }

    /** Dernière étape « @ … » de la trace, et depuis quand la trace est muette (date du fichier). */
    private fun lastStage(f: File): Pair<String, Long>? = try {
        if (!f.isFile) null else java.io.RandomAccessFile(f, "r").use { r ->
            val from = maxOf(0L, r.length() - 16_384)
            val buf = ByteArray((r.length() - from).toInt())
            r.seek(from); r.readFully(buf)
            String(buf, Charsets.UTF_8).lines().lastOrNull { it.startsWith("@ ") }?.let {
                it.removePrefix("@ ").take(160) to (System.currentTimeMillis() - f.lastModified())
            }
        }
    } catch (_: Exception) { null }

    @PluginMethod(returnType = PluginMethod.RETURN_PROMISE)
    fun warm(call: PluginCall) {
        val b = Bundle().apply { putByteArray("prefix", (call.getString("prefix") ?: "").toByteArray()) }
        request(LlmService.WARM, "warm", b, relay(call))
    }

    @PluginMethod(returnType = PluginMethod.RETURN_PROMISE)
    fun generate(call: PluginCall) {
        val b = Bundle().apply {
            putByteArray("prefix", (call.getString("prefix") ?: "").toByteArray())
            putByteArray("rest", (call.getString("rest") ?: "").toByteArray())
            putInt("maxTokens", call.getInt("maxTokens") ?: 256)
        }
        // « selftest » (essai à vide du chargement) ou « answer » : dit où le plantage a eu lieu.
        request(LlmService.GENERATE, "generate ${call.getString("phase") ?: "answer"}", b, relay(call))
    }

    @PluginMethod(returnType = PluginMethod.RETURN_PROMISE)
    fun cancel(call: PluginCall) {
        main.post { service?.let { sendNow(Message.obtain(null, LlmService.CANCEL)) } }
        call.resolve()
    }

    /**
     * Arrête le moteur : le processus :llm est tué, toute sa mémoire est rendue (poids,
     * tampons du pilote GPU). Les requêtes en cours échouent avec « unloaded ».
     */
    @PluginMethod(returnType = PluginMethod.RETURN_PROMISE)
    fun unload(call: PluginCall) {
        main.post {
            val pid = servicePid.takeIf { it > 0 } ?: llmPid()
            dropService("unloaded")
            if (pid <= 0 || pid == Process.myPid()) { call.resolve(); return@post }
            Process.killProcess(pid)
            // Rendre la main seulement une fois le processus mort : relié trop tôt, le moteur
            // suivant (processeur natif après un Vulkan écarté) pouvait se lier au service du
            // processus mourant, et échouer en « crash » sans avoir rien fait.
            Thread({
                val proc = File("/proc/$pid")
                val t0 = System.currentTimeMillis()
                while (proc.exists() && System.currentTimeMillis() - t0 < 3_000) Thread.sleep(50)
                Log.i(TAG, "processus :llm $pid ${if (proc.exists()) "toujours là après 3 s" else "arrêté"}")
                call.resolve()
            }, "llm-unload").start()
        }
    }

    /**
     * Rend le moteur sans l'arrêter : la liaison est défaite, le processus :llm garde le
     * modèle (service de premier plan) pour le prochain chargement, qui le reprend aussitôt.
     * Sans modèle chargé, le service part avec la liaison, comme avant.
     */
    @PluginMethod(returnType = PluginMethod.RETURN_PROMISE)
    fun release(call: PluginCall) {
        main.post {
            dropService("released")
            call.resolve()
        }
    }

    override fun handleOnDestroy() {
        main.post { dropService("destroyed") }
        super.handleOnDestroy()
    }
}
