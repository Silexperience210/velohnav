// Pont JNI du moteur natif (vh_llm.cpp) → com.silexperience.velohnav.llm.LlmNative.
//
// Tout texte passe en octets UTF-8 (byte[]) : les chaînes JNI sont en UTF-8 « modifié »,
// où un emoji (4 octets) est invalide et fait planter la machine virtuelle.
#include <jni.h>
#include <string>

#include "vh_llm.h"

namespace {

vh::Engine g_engine;

std::string bytes(JNIEnv * env, jbyteArray a) {
    if (!a) return {};
    jsize n = env->GetArrayLength(a);
    std::string s((size_t) n, '\0');
    env->GetByteArrayRegion(a, 0, n, reinterpret_cast<jbyte *>(s.data()));
    return s;
}

jbyteArray to_bytes(JNIEnv * env, const std::string & s) {
    jbyteArray a = env->NewByteArray((jsize) s.size());
    env->SetByteArrayRegion(a, 0, (jsize) s.size(), reinterpret_cast<const jbyte *>(s.data()));
    return a;
}

std::string esc(const std::string & s) {
    std::string o;
    for (unsigned char c : s) {
        if (c == '"' || c == '\\') { o += '\\'; o += (char) c; }
        else if (c == '\n') o += "\\n";
        else if (c == '\r') o += "\\r";
        else if (c == '\t') o += "\\t";
        else if (c < 0x20) { char b[8]; snprintf(b, sizeof b, "\\u%04x", c); o += b; }
        else o += (char) c;
    }
    return o;
}

std::string error_json(const std::string & err) {
    return "{\"ok\":false,\"error\":\"" + esc(err) + "\",\"log\":\"" + esc(vh::log_tail(20)) + "\"}";
}

}  // namespace

extern "C" {

JNIEXPORT jbyteArray JNICALL
Java_com_silexperience_velohnav_llm_LlmNative_devices(JNIEnv * env, jobject) {
    return to_bytes(env, vh::devices_json());
}

JNIEXPORT jbyteArray JNICALL
Java_com_silexperience_velohnav_llm_LlmNative_load(JNIEnv * env, jobject, jbyteArray path, jbyteArray backend,
                                                   jint n_ctx, jint n_threads) {
    std::string info, err;
    if (!g_engine.load(bytes(env, path), bytes(env, backend), n_ctx, n_threads, info, err)) return to_bytes(env, error_json(err));
    return to_bytes(env, "{\"ok\":true,\"info\":" + info + "}");
}

JNIEXPORT jbyteArray JNICALL
Java_com_silexperience_velohnav_llm_LlmNative_warm(JNIEnv * env, jobject, jbyteArray prefix) {
    std::string err;
    if (!g_engine.warm(bytes(env, prefix), err)) return to_bytes(env, error_json(err));
    return to_bytes(env, "{\"ok\":true}");
}

JNIEXPORT jbyteArray JNICALL
Java_com_silexperience_velohnav_llm_LlmNative_generate(JNIEnv * env, jobject, jbyteArray prefix, jbyteArray rest,
                                                       jint max_tokens, jobject sink) {
    jmethodID on_piece = nullptr;
    if (sink) on_piece = env->GetMethodID(env->GetObjectClass(sink), "onPiece", "([B)Z");
    auto cb = [&](const std::string & piece) -> bool {
        if (!on_piece) return true;
        jbyteArray b = to_bytes(env, piece);
        jboolean go = env->CallBooleanMethod(sink, on_piece, b);
        env->DeleteLocalRef(b);
        if (env->ExceptionCheck()) { env->ExceptionClear(); return false; }
        return go;
    };
    std::string out, err;
    vh::GenStats st;
    if (!g_engine.generate(bytes(env, prefix), bytes(env, rest), max_tokens, cb, out, st, err)) return to_bytes(env, error_json(err));
    char stats[256];
    snprintf(stats, sizeof stats,
             "{\"promptTokens\":%d,\"reusedTokens\":%d,\"genTokens\":%d,\"promptMs\":%.1f,\"genMs\":%.1f,\"eog\":%s}",
             st.prompt_tokens, st.reused_tokens, st.gen_tokens, st.prompt_ms, st.gen_ms, st.eog ? "true" : "false");
    return to_bytes(env, "{\"ok\":true,\"text\":\"" + esc(out) + "\",\"stats\":" + stats + "}");
}

JNIEXPORT void JNICALL
Java_com_silexperience_velohnav_llm_LlmNative_cancel(JNIEnv *, jobject) {
    g_engine.cancel();
}

JNIEXPORT void JNICALL
Java_com_silexperience_velohnav_llm_LlmNative_unload(JNIEnv *, jobject) {
    g_engine.unload();
}

}  // extern "C"
