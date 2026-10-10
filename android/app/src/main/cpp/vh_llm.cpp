#include "vh_llm.h"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <deque>
#include <mutex>

#include "ggml-backend.h"
#include "llama.h"

#ifdef __ANDROID__
#include <android/log.h>
#endif

namespace vh {

namespace {

// ── Journal ─────────────────────────────────────────────────────────
// Une erreur GPU (shader refusé, mémoire du device, pilote) n'apparaît QUE dans le
// journal de ggml : la fonction appelante rend seulement « échec ». Les dernières lignes
// sont gardées pour être jointes à l'erreur, sans résumé.
std::mutex g_log_mu;
std::deque<std::string> g_log;
std::string g_line;   // ggml écrit parfois une ligne en plusieurs morceaux

void on_log(ggml_log_level level, const char * text, void *) {
    if (!text) return;
#ifdef __ANDROID__
    int prio = level == GGML_LOG_LEVEL_ERROR ? ANDROID_LOG_ERROR
             : level == GGML_LOG_LEVEL_WARN  ? ANDROID_LOG_WARN
             : level == GGML_LOG_LEVEL_DEBUG ? ANDROID_LOG_DEBUG : ANDROID_LOG_INFO;
    if (level != GGML_LOG_LEVEL_DEBUG) __android_log_write(prio, "VhLlm", text);
#endif
    if (level == GGML_LOG_LEVEL_DEBUG) return;
    std::lock_guard<std::mutex> lk(g_log_mu);
    g_line += text;
    size_t nl;
    while ((nl = g_line.find('\n')) != std::string::npos) {
        std::string l = g_line.substr(0, nl);
        g_line.erase(0, nl + 1);
        if (l.empty()) continue;
        const char * tag = level == GGML_LOG_LEVEL_ERROR ? "E " : level == GGML_LOG_LEVEL_WARN ? "W " : "I ";
        g_log.push_back(tag + l.substr(0, 400));
        if (g_log.size() > 200) g_log.pop_front();
    }
}

std::string json_escape(const std::string & s) {
    std::string o;
    o.reserve(s.size() + 8);
    for (unsigned char c : s) {
        switch (c) {
            case '"':  o += "\\\""; break;
            case '\\': o += "\\\\"; break;
            case '\n': o += "\\n"; break;
            case '\r': o += "\\r"; break;
            case '\t': o += "\\t"; break;
            default:
                if (c < 0x20) { char b[8]; snprintf(b, sizeof b, "\\u%04x", c); o += b; }
                else o += (char) c;
        }
    }
    return o;
}

const char * type_name(enum ggml_backend_dev_type t) {
    switch (t) {
        case GGML_BACKEND_DEVICE_TYPE_CPU:   return "cpu";
        case GGML_BACKEND_DEVICE_TYPE_GPU:   return "gpu";
        case GGML_BACKEND_DEVICE_TYPE_IGPU:  return "igpu";
        case GGML_BACKEND_DEVICE_TYPE_ACCEL: return "accel";
        default:                             return "other";
    }
}

std::string lower(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return (char) std::tolower(c); });
    return s;
}

double ms_since(std::chrono::steady_clock::time_point t0) {
    return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
}

// Longueur du plus long préfixe UTF-8 complet de `s` : un caractère accentué peut
// arriver en deux jetons, on ne transmet jamais un demi-caractère.
size_t utf8_complete(const std::string & s) {
    size_t n = s.size(), i = n;
    // remonte au début du dernier caractère (au plus 3 octets de continuation)
    while (i > 0 && n - i < 4 && ((unsigned char) s[i - 1] & 0xC0) == 0x80) i--;
    if (i == 0) return n;
    unsigned char lead = (unsigned char) s[i - 1];
    size_t need = lead >= 0xF0 ? 4 : lead >= 0xE0 ? 3 : lead >= 0xC0 ? 2 : 1;
    return (n - (i - 1) >= need) ? n : i - 1;
}

}  // namespace

void init() {
    static std::once_flag once;
    std::call_once(once, [] {
        llama_log_set(on_log, nullptr);
        llama_backend_init();
    });
}

std::string log_tail(size_t max_lines) {
    std::lock_guard<std::mutex> lk(g_log_mu);
    std::string o;
    size_t from = g_log.size() > max_lines ? g_log.size() - max_lines : 0;
    for (size_t i = from; i < g_log.size(); i++) { if (!o.empty()) o += " | "; o += g_log[i]; }
    return o;
}

std::string devices_json() {
    init();
    std::string o = "[";
    for (size_t i = 0; i < ggml_backend_dev_count(); i++) {
        ggml_backend_dev_t d = ggml_backend_dev_get(i);
        ggml_backend_dev_props p{};
        ggml_backend_dev_get_props(d, &p);
        if (i) o += ",";
        o += "{\"name\":\"" + json_escape(p.name ? p.name : "") + "\""
           + ",\"description\":\"" + json_escape(p.description ? p.description : "") + "\""
           + ",\"backend\":\"" + json_escape(ggml_backend_reg_name(ggml_backend_dev_backend_reg(d))) + "\""
           + ",\"type\":\"" + type_name(p.type) + "\""
           + ",\"memFreeMB\":" + std::to_string(p.memory_free / 1000000)
           + ",\"memTotalMB\":" + std::to_string(p.memory_total / 1000000) + "}";
    }
    return o + "]";
}

Engine::~Engine() { unload(); }

void Engine::unload() {
    if (smpl_) llama_sampler_free(smpl_);
    if (ctx_) llama_free(ctx_);
    if (model_) llama_model_free(model_);
    smpl_ = nullptr; ctx_ = nullptr; model_ = nullptr;
    ckpt_tokens_.clear(); ckpt_state_.clear();
    ckpt_state_.shrink_to_fit();
}

bool Engine::load(const std::string & path, const std::string & backend, int n_ctx, int n_threads,
                  std::string & info, std::string & err) {
    init();
    unload();
    const auto t0 = std::chrono::steady_clock::now();

    // L'appareil demandé, et lui seul : sans liste explicite, llama.cpp prend tous les
    // GPU et décharge sur eux même avec 0 couche — on ne saurait plus ce qui tourne.
    std::vector<ggml_backend_dev_t> devs;
    std::string dev_name, dev_desc;
    const bool cpu = lower(backend) == "cpu";
    if (!cpu) {
        for (size_t i = 0; i < ggml_backend_dev_count(); i++) {
            ggml_backend_dev_t d = ggml_backend_dev_get(i);
            const auto t = ggml_backend_dev_type(d);
            if (t != GGML_BACKEND_DEVICE_TYPE_GPU && t != GGML_BACKEND_DEVICE_TYPE_IGPU) continue;
            if (lower(ggml_backend_reg_name(ggml_backend_dev_backend_reg(d))) != lower(backend)) continue;
            devs.push_back(d);
            dev_name = ggml_backend_dev_name(d);
            dev_desc = ggml_backend_dev_description(d);
            break;
        }
        if (devs.empty()) {
            err = "no " + backend + " device (devices: " + devices_json() + ")";
            return false;
        }
    }
    devs.push_back(nullptr);

    llama_model_params mp = llama_model_default_params();
    mp.devices = devs.data();
    mp.n_gpu_layers = cpu ? 0 : 999;
    model_ = llama_model_load_from_file(path.c_str(), mp);
    if (!model_) {
        err = "model load failed on " + backend + ": " + log_tail();
        return false;
    }

    llama_context_params cp = llama_context_default_params();
    cp.n_ctx = (uint32_t) n_ctx;
    cp.n_batch = (uint32_t) n_batch_;
    cp.n_ubatch = (uint32_t) n_batch_;
    cp.n_threads = n_threads;
    cp.n_threads_batch = n_threads;
    cp.no_perf = false;
    ctx_ = llama_init_from_model(model_, cp);
    if (!ctx_) {
        err = "context init failed on " + backend + ": " + log_tail();
        unload();
        return false;
    }
    smpl_ = llama_sampler_chain_init(llama_sampler_chain_default_params());
    llama_sampler_chain_add(smpl_, llama_sampler_init_greedy());

    char desc[128] = {0};
    llama_model_desc(model_, desc, sizeof desc);
    info = "{\"backend\":\"" + json_escape(cpu ? "cpu" : backend) + "\""
         + ",\"device\":\"" + json_escape(cpu ? "CPU" : dev_name) + "\""
         + ",\"description\":\"" + json_escape(cpu ? "" : dev_desc) + "\""
         + ",\"model\":\"" + json_escape(desc) + "\""
         + ",\"nCtx\":" + std::to_string(llama_n_ctx(ctx_))
         + ",\"threads\":" + std::to_string(n_threads)
         + ",\"loadMs\":" + std::to_string((long) ms_since(t0))
         + ",\"system\":\"" + json_escape(llama_print_system_info()) + "\""
         + ",\"log\":\"" + json_escape(log_tail(40)) + "\"}";
    return true;
}

bool Engine::tokenize(const std::string & text, std::vector<int32_t> & out, std::string & err) const {
    const llama_vocab * vocab = llama_model_get_vocab(model_);
    // Le texte porte déjà <|startoftext|> (gabarit) : pas de jeton de début ajouté, et
    // les jetons spéciaux écrits en clair (<|im_start|>…) sont reconnus comme tels.
    int n = -llama_tokenize(vocab, text.data(), (int32_t) text.size(), nullptr, 0, false, true);
    if (n < 0) { err = "tokenize"; return false; }
    out.resize(n);
    if (n && llama_tokenize(vocab, text.data(), (int32_t) text.size(), out.data(), n, false, true) != n) {
        err = "tokenize";
        return false;
    }
    return true;
}

bool Engine::decode(const std::vector<int32_t> & toks, size_t from, std::string & err) {
    for (size_t i = from; i < toks.size(); i += n_batch_) {
        if (cancel_) { err = "cancelled"; return false; }
        int32_t n = (int32_t) std::min<size_t>(n_batch_, toks.size() - i);
        int rc = llama_decode(ctx_, llama_batch_get_one(const_cast<int32_t *>(toks.data() + i), n));
        if (rc != 0) {
            err = "decode failed (" + std::to_string(rc) + "): " + log_tail();
            return false;
        }
    }
    return true;
}

// Met le modèle dans l'état « consigne calculée » : restauré depuis la copie si la
// consigne n'a pas changé, sinon calculé puis copié.
bool Engine::ensure_prefix(const std::vector<int32_t> & pre, int & reused, std::string & err) {
    llama_memory_t mem = llama_get_memory(ctx_);
    reused = 0;
    if (!pre.empty() && pre == ckpt_tokens_ && !ckpt_state_.empty()) {
        llama_memory_clear(mem, true);
        if (llama_state_seq_set_data(ctx_, ckpt_state_.data(), ckpt_state_.size(), 0) > 0) {
            reused = (int) pre.size();
            return true;
        }
        ckpt_tokens_.clear(); ckpt_state_.clear();
    }
    llama_memory_clear(mem, true);
    if (pre.empty()) return true;
    if (!decode(pre, 0, err)) return false;
    size_t sz = llama_state_seq_get_size(ctx_, 0);
    ckpt_state_.resize(sz);
    if (llama_state_seq_get_data(ctx_, ckpt_state_.data(), sz, 0) == sz) ckpt_tokens_ = pre;
    else { ckpt_tokens_.clear(); ckpt_state_.clear(); }
    return true;
}

bool Engine::warm(const std::string & prefix, std::string & err) {
    if (!ctx_) { err = "not loaded"; return false; }
    cancel_ = false;
    std::vector<int32_t> pre;
    if (!tokenize(prefix, pre, err)) return false;
    int reused = 0;
    return ensure_prefix(pre, reused, err);
}

bool Engine::generate(const std::string & prefix, const std::string & rest, int max_tokens,
                      const std::function<bool(const std::string &)> & on_piece,
                      std::string & out, GenStats & st, std::string & err) {
    if (!ctx_) { err = "not loaded"; return false; }
    cancel_ = false;
    out.clear();
    st = GenStats{};
    std::vector<int32_t> pre, tail;
    if (!tokenize(prefix, pre, err) || !tokenize(rest, tail, err)) return false;
    st.prompt_tokens = (int) (pre.size() + tail.size());
    if (tail.empty()) { err = "empty prompt"; return false; }
    const int n_ctx = (int) llama_n_ctx(ctx_);
    if (st.prompt_tokens + 1 >= n_ctx) {
        err = "context: prompt " + std::to_string(st.prompt_tokens) + " tokens > " + std::to_string(n_ctx);
        return false;
    }

    auto t0 = std::chrono::steady_clock::now();
    if (!ensure_prefix(pre, st.reused_tokens, err)) return false;
    if (!decode(tail, 0, err)) return false;
    st.prompt_ms = ms_since(t0);

    const llama_vocab * vocab = llama_model_get_vocab(model_);
    llama_sampler_reset(smpl_);
    std::string pending;   // octets pas encore transmis (caractère UTF-8 incomplet)
    auto t1 = std::chrono::steady_clock::now();
    int pos = st.prompt_tokens;
    for (int i = 0; i < max_tokens && pos < n_ctx - 1; i++, pos++) {
        if (cancel_) { err = "cancelled"; return false; }
        llama_token tok = llama_sampler_sample(smpl_, ctx_, -1);
        if (llama_vocab_is_eog(vocab, tok)) {
            st.eog = true;
            pending += "<|im_end|>";
            break;
        }
        char buf[256];
        int n = llama_token_to_piece(vocab, tok, buf, sizeof buf, 0, true);
        if (n < 0) { err = "token_to_piece"; return false; }
        pending.append(buf, n);
        st.gen_tokens++;
        size_t ok = utf8_complete(pending);
        if (ok) {
            std::string piece = pending.substr(0, ok);
            pending.erase(0, ok);
            out += piece;
            if (on_piece && !on_piece(piece)) { err = "cancelled"; return false; }
        }
        int rc = llama_decode(ctx_, llama_batch_get_one(&tok, 1));
        if (rc != 0) { err = "decode failed (" + std::to_string(rc) + "): " + log_tail(); return false; }
    }
    out += pending;
    if (on_piece && !pending.empty()) on_piece(pending);
    st.gen_ms = ms_since(t1);
    return true;
}

}  // namespace vh
