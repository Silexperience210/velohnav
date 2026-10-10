package com.silexperience.velohnav.llm

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Message
import android.os.Messenger
import android.os.Process
import android.util.Log
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
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
        val reason = LlmNative.unsupportedReason()
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
                call.resolve(JSObject().put("path", f.path).put("cached", false))
            } catch (e: Exception) {
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

    private val replies = Messenger(object : Handler(Looper.getMainLooper()) {
        override fun handleMessage(msg: Message) {
            if (msg.what != LlmService.REPLY) return
            if (msg.arg2 > 0) servicePid = msg.arg2
            pending.remove(msg.arg1)?.invoke(msg.data.getByteArray("json"), null)
        }
    })

    private val conn = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            service = Messenger(binder)
            queued.forEach { sendNow(it) }
            queued.clear()
        }

        // Le processus :llm est mort (plantage natif, ou tué par le système)
        override fun onServiceDisconnected(name: ComponentName?) {
            Log.w("VhLlm", "processus :llm mort pendant : $lastRequest")
            dropService("crash during $lastRequest")
        }

        override fun onBindingDied(name: ComponentName?) = dropService("binding died during $lastRequest")
    }

    private fun dropService(reason: String) {
        service = null
        if (bound) { try { context.unbindService(conn) } catch (_: Exception) {} }
        bound = false
        servicePid = 0
        queued.clear()
        val fails = pending.values.toList()
        pending.clear()
        fails.forEach { it(null, reason) }
    }

    private fun sendNow(m: Message) {
        try { service?.send(m) } catch (e: Exception) { dropService("send failed: ${e.message}") }
    }

    private fun request(what: Int, label: String, data: Bundle, done: (ByteArray?, String?) -> Unit) {
        main.post {
            val id = ++seq
            pending[id] = done
            lastRequest = label
            val m = Message.obtain(null, what, id, 0).apply { this.data = data; replyTo = replies }
            if (service != null) { sendNow(m); return@post }
            queued.add(m)
            if (!bound) {
                bound = context.bindService(Intent(context, LlmService::class.java), conn,
                    Context.BIND_AUTO_CREATE or Context.BIND_IMPORTANT)
                if (!bound) dropService("bindService refused")
            }
        }
    }

    /** Réponse du moteur rendue telle quelle à l'application (JSON du moteur sous « result »). */
    private fun relay(call: PluginCall) = { json: ByteArray?, crash: String? ->
        if (json == null) call.reject(crash ?: "crash", "crash")
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
        }
        request(LlmService.LOAD, "load $backend", b, relay(call))
    }

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
        request(LlmService.GENERATE, "generate", b, relay(call))
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
            val pid = servicePid
            dropService("unloaded")
            if (pid > 0 && pid != Process.myPid()) Process.killProcess(pid)
            call.resolve()
        }
    }

    override fun handleOnDestroy() {
        main.post { dropService("destroyed") }
        super.handleOnDestroy()
    }
}
