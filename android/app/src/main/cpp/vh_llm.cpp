#include "vh_llm.h"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <csignal>
#include <cstdint>
#include <cstring>
#include <deque>
#include <mutex>

#include <fstream>

#include <fcntl.h>
#include <sched.h>
#include <unistd.h>

#include "ggml-backend.h"
#include "ggml-cpu.h"
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

// ── Trace qui survit au plantage ────────────────────────────────────
// write() direct (aucun tampon à vider : le processus peut mourir à l'instruction
// suivante). Le gestionnaire de signaux n'utilise que des fonctions async-signal-safe.
int g_trace_fd = -1;
char g_stage[160] = "start";
struct sigaction g_prev[32];
const int kSignals[] = {SIGSEGV, SIGBUS, SIGILL, SIGFPE, SIGABRT, SIGTRAP};

void trace_write(const char * s, size_t n) {
    if (g_trace_fd >= 0) { ssize_t w = write(g_trace_fd, s, n); (void) w; }
}

const char * sig_name(int sig) {
    switch (sig) {
        case SIGSEGV: return "SIGSEGV"; case SIGBUS: return "SIGBUS"; case SIGILL: return "SIGILL";
        case SIGFPE: return "SIGFPE"; case SIGABRT: return "SIGABRT"; case SIGTRAP: return "SIGTRAP";
        default: return "?";
    }
}

void on_signal(int sig, siginfo_t * info, void * uctx) {
    char b[256];
    // snprintf n'est pas garanti async-signal-safe : la ligne est assemblée à la main.
    size_t n = 0;
    auto put = [&](const char * s) { while (*s && n < sizeof b - 2) b[n++] = *s++; };
    put("!! signal "); put(sig_name(sig)); put(" during "); put(g_stage);
    if (info && (sig == SIGSEGV || sig == SIGBUS)) {
        put(" addr 0x");
        uintptr_t a = (uintptr_t) info->si_addr;
        char hex[2 * sizeof a + 1]; int k = 0;
        for (int i = (int) (2 * sizeof a) - 1; i >= 0; i--) hex[k++] = "0123456789abcdef"[(a >> (4 * i)) & 0xf];
        hex[k] = 0; put(hex);
    }
    b[n++] = '\n';
    trace_write(b, n);
    // Le gestionnaire d'avant (debuggerd sur Android) reprend la main : rapport de plantage
    // et mort du processus, comme sans nous.
    sigaction(sig, &g_prev[sig], nullptr);
    if (g_prev[sig].sa_flags & SA_SIGINFO) {
        if (g_prev[sig].sa_sigaction) { g_prev[sig].sa_sigaction(sig, info, uctx); return; }
    } else if (g_prev[sig].sa_handler != SIG_DFL && g_prev[sig].sa_handler != SIG_IGN) {
        g_prev[sig].sa_handler(sig);
        return;
    }
    raise(sig);
}

void on_log(ggml_log_level level, const char * text, void *) {
    if (!text) return;
    if (level != GGML_LOG_LEVEL_DEBUG) trace_write(text, strlen(text));
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

// ── Cœurs du processeur ─────────────────────────────────────────────
// « 0-3,6 » → {0,1,2,3,6}
std::vector<int> parse_cpu_list(const std::string & s) {
    std::vector<int> o;
    size_t p = 0;
    while (p < s.size()) {
        size_t e = s.find(',', p); if (e == std::string::npos) e = s.size();
        std::string r = s.substr(p, e - p);
        size_t d = r.find('-');
        int a = atoi(r.c_str()), b = d == std::string::npos ? a : atoi(r.c_str() + d + 1);
        if (!r.empty()) for (int i = a; i <= b && i < GGML_MAX_N_THREADS; i++) o.push_back(i);
        p = e + 1;
    }
    return o;
}

std::string cpu_list(const std::vector<int> & v) {
    std::string o;
    for (size_t i = 0; i < v.size(); i++) {
        size_t j = i;
        while (j + 1 < v.size() && v[j + 1] == v[j] + 1) j++;
        if (!o.empty()) o += ",";
        o += std::to_string(v[i]) + (j > i ? "-" + std::to_string(v[j]) : "");
        i = j;
    }
    return o;
}

std::string read_line(const std::string & path, const char * key = nullptr) {
    std::ifstream f(path);
    for (std::string l; std::getline(f, l);) {
        if (!key) return l;
        if (l.rfind(key, 0) == 0) { l.erase(0, strlen(key)); l.erase(0, l.find_first_not_of(" \t")); return l; }
    }
    return "";
}

}  // namespace

std::string allowed_cpus() { return read_line("/proc/self/status", "Cpus_allowed_list:"); }

CpuPlan plan_cpus(int requested) {
    CpuPlan p;
    p.cpuset = read_line("/proc/self/cpuset");
    p.allowed = allowed_cpus();
    std::vector<int> allowed = parse_cpu_list(p.allowed);
    if (allowed.empty()) {   // pas de /proc lisible : le choix du système
        p.threads = std::max(1, requested);
        return p;
    }
    // Fréquence maximale de chaque cœur présent ; les « gros » sont au-dessus des plus petits.
    std::vector<long> freq(GGML_MAX_N_THREADS, 0);
    long fmin = 0;
    for (int i = 0; i < GGML_MAX_N_THREADS; i++) {
        std::string f = read_line("/sys/devices/system/cpu/cpu" + std::to_string(i) + "/cpufreq/cpuinfo_max_freq");
        if (f.empty()) continue;
        freq[i] = atol(f.c_str());
        if (freq[i] > 0 && (fmin == 0 || freq[i] < fmin)) fmin = freq[i];
    }
    std::vector<int> big;
    for (int c : allowed) if (freq[c] > fmin) big.push_back(c);
    // Aucun gros cœur permis (ou cœurs identiques) : ceux qui le sont. Les plus rapides d'abord.
    std::vector<int> pick = big.empty() ? allowed : big;
    std::stable_sort(pick.begin(), pick.end(), [&](int a, int b) { return freq[a] > freq[b]; });
    p.threads = std::max(1, std::min<int>(requested, (int) pick.size()));
    pick.resize(p.threads);
    std::sort(pick.begin(), pick.end());
    p.cpus = pick;
    return p;
}

void init() {
    static std::once_flag once;
    std::call_once(once, [] {
        llama_log_set(on_log, nullptr);
        llama_backend_init();
    });
}

void trace_to(const std::string & path) {
    static std::once_flag once;
    std::call_once(once, [&] {
        g_trace_fd = open(path.c_str(), O_WRONLY | O_CREAT | O_TRUNC | O_APPEND | O_CLOEXEC, 0600);
        // Pile de secours : un débordement de pile se signale aussi.
        static char alt[64 * 1024];
        stack_t ss{};
        ss.ss_sp = alt; ss.ss_size = sizeof alt;
        sigaltstack(&ss, nullptr);
        for (int sig : kSignals) {
            struct sigaction sa{};
            sa.sa_sigaction = on_signal;
            sa.sa_flags = SA_SIGINFO | SA_ONSTACK;
            sigemptyset(&sa.sa_mask);
            sigaction(sig, &sa, &g_prev[sig]);
        }
    });
}

void trace(const std::string & stage) {
    // Copie bornée lue par le gestionnaire de signaux : jamais de chaîne C++ dans un signal.
    size_t n = std::min(stage.size(), sizeof g_stage - 1);
    memcpy(g_stage, stage.data(), n);
    g_stage[n] = 0;
    std::string l = "@ " + stage + "\n";
    trace_write(l.data(), l.size());
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
    if (pool_) ggml_threadpool_free(pool_);
    if (model_) llama_model_free(model_);
    smpl_ = nullptr; ctx_ = nullptr; pool_ = nullptr; model_ = nullptr;
    ckpt_tokens_.clear(); ckpt_state_.clear();
    ckpt_state_.shrink_to_fit();
}

bool Engine::load(const std::string & path, const std::string & backend, int n_ctx, int n_threads,
                  std::string & info, std::string & err) {
    init();
    unload();
    const auto t0 = std::chrono::steady_clock::now();
    const std::string stage = "load " + backend;
    trace(stage + ": devices");

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
    trace(stage + ": model (" + (cpu ? std::string("cpu") : dev_desc) + ")");
    model_ = llama_model_load_from_file(path.c_str(), mp);
    if (!model_) {
        err = "model load failed on " + backend + ": " + log_tail();
        return false;
    }

    // Fils de calcul : jamais plus que de cœurs que le processus a le droit d'utiliser, et
    // gardés sur les gros. ggml fait attendre ses fils en boucle active entre deux opérations,
    // et chaque étape attend le plus lent : un fil sur un petit cœur, ou privé de cœur, freine
    // tous les autres (mesuré sur PC : 4 fils sur 2 cœurs permis, 88 → 64 j/s).
    const CpuPlan cpus = plan_cpus(n_threads);
    n_threads = cpus.threads;
    llama_context_params cp = llama_context_default_params();
    cp.n_ctx = (uint32_t) n_ctx;
    cp.n_batch = (uint32_t) n_batch_;
    cp.n_ubatch = (uint32_t) n_batch_;
    cp.n_threads = n_threads;
    cp.n_threads_batch = n_threads;
    cp.no_perf = false;
    const bool exact = !cpu && gpu_exact;
    if (exact) {
        cp.type_k = GGML_TYPE_F32;
        cp.type_v = GGML_TYPE_F32;
        cp.flash_attn_type = LLAMA_FLASH_ATTN_TYPE_DISABLED;
    }
    trace(stage + ": context");
    ctx_ = llama_init_from_model(model_, cp);
    if (!ctx_) {
        err = "context init failed on " + backend + ": " + log_tail();
        unload();
        return false;
    }
    // Calibrage : le bon nombre de fils dépend de ce qui tourne à côté (WebView, rendu) et
    // du groupe de cœurs donné au processus, qui varient d'un téléphone et d'un instant à
    // l'autre. Un fil privé de cœur fait attendre tous les autres à chaque opération
    // (barrière en boucle active) : mieux vaut mesurer que deviner. Quatre essais au plus,
    // du moins de fils au plus : le premier, sûr, fixe la référence ; un essai 4 fois plus
    // lent par jeton que le meilleur est interrompu (probe_tps). Moins d'une seconde.
    std::string calib;
    if (cpu && calibrate && n_threads > 1) {
        trace(stage + ": threads");
        int best = n_threads;
        double best_tps = -1;
        for (int n = std::max(1, n_threads - 3); n <= n_threads; n++) {
            use_threads(n, cpus.cpus);
            const double tps = probe_tps(best_tps > 0 ? 4000.0 / best_tps : 500);
            char one[32];
            snprintf(one, sizeof one, "%s\"%d\":%.1f", calib.empty() ? "" : ",", n, tps);
            calib += one;
            if (tps > best_tps) { best_tps = tps; best = n; }
        }
        n_threads = best;
    }
    use_threads(n_threads, cpus.cpus);
    smpl_ = llama_sampler_chain_init(llama_sampler_chain_default_params());
    llama_sampler_chain_add(smpl_, llama_sampler_init_greedy());
    trace(stage + ": ready");

    char desc[128] = {0};
    llama_model_desc(model_, desc, sizeof desc);
    info = "{\"backend\":\"" + json_escape(cpu ? "cpu" : backend) + "\""
         + ",\"device\":\"" + json_escape(cpu ? "CPU" : dev_name) + "\""
         + ",\"description\":\"" + json_escape(cpu ? "" : dev_desc) + "\""
         + ",\"model\":\"" + json_escape(desc) + "\""
         + ",\"nCtx\":" + std::to_string(llama_n_ctx(ctx_))
         + ",\"threads\":" + std::to_string(n_threads)
         + ",\"threadsTps\":{" + calib + "}"
         + ",\"cpus\":\"" + json_escape(cpu_list(cpus.cpus)) + "\""
         + ",\"allowedCpus\":\"" + json_escape(cpus.allowed) + "\""
         + ",\"cpuset\":\"" + json_escape(cpus.cpuset) + "\""
         + ",\"nBatch\":" + std::to_string(n_batch_)
         + ",\"kv\":\"" + (exact ? "f32" : "f16") + "\""
         + ",\"flashAttn\":" + (exact ? "false" : "\"auto\"")
         + ",\"loadMs\":" + std::to_string((long) ms_since(t0))
         + ",\"system\":\"" + json_escape(llama_print_system_info()) + "\""
         + ",\"log\":\"" + json_escape(log_tail(40)) + "\"}";
    return true;
}

void Engine::use_threads(int n, const std::vector<int> & cpus) {
    // Un pool par nombre de fils : les fils en trop d'un pool plus grand attendraient le
    // travail en boucle active, sur les mêmes cœurs que ceux qui calculent.
    ggml_threadpool_params tpp = ggml_threadpool_params_default(n);
    for (int c : cpus) tpp.cpumask[c] = true;
    ggml_threadpool * pool = ggml_threadpool_new(&tpp);
    if (pool) llama_attach_threadpool(ctx_, pool, pool);
    else llama_detach_threadpool(ctx_);
    if (pool_) ggml_threadpool_free(pool_);
    pool_ = pool;
    llama_set_n_threads(ctx_, n, n);
}

double Engine::probe_tps(double max_token_ms) {
    const llama_vocab * vocab = llama_model_get_vocab(model_);
    llama_token tok = llama_vocab_bos(vocab);
    if (tok < 0) tok = 0;
    llama_memory_t mem = llama_get_memory(ctx_);
    llama_memory_clear(mem, true);
    // Un jeton plus long que `max_token_ms` est interrompu entre deux opérations (rappel
    // d'abandon de ggml) : un réglage pathologique (mesuré sur PC, 4 fils dont 2 privés de
    // cœur : 0,8 j/s, 1,25 s par jeton) est écarté sans retarder le chargement.
    struct Deadline { std::chrono::steady_clock::time_point at; } dl;
    llama_set_abort_callback(ctx_, [](void * d) {
        return std::chrono::steady_clock::now() > static_cast<Deadline *>(d)->at;
    }, &dl);
    // Le premier jeton réveille les fils et remplit les caches : non compté, délai doublé. Au plus 8
    // jetons de plus, ou 300 ms en tout.
    const auto start = std::chrono::steady_clock::now();
    double ms = 0;
    int n = 0;
    bool aborted = false;
    for (int i = 0; i < 9 && ms_since(start) < 300; i++) {
        const auto t0 = std::chrono::steady_clock::now();
        dl.at = t0 + std::chrono::microseconds((long long) (max_token_ms * (i == 0 ? 2 : 1) * 1000));
        if (llama_decode(ctx_, llama_batch_get_one(&tok, 1)) != 0) { aborted = true; break; }
        if (i > 0) { ms += ms_since(t0); n++; }
    }
    llama_set_abort_callback(ctx_, nullptr, nullptr);
    llama_memory_clear(mem, true);
    return !aborted && n > 0 && ms > 0 ? n * 1000.0 / ms : 0;
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
    trace("warm");
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
    st.cpus = allowed_cpus();
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
    trace("generate: prompt (" + std::to_string(st.prompt_tokens) + " tokens)");
    if (!ensure_prefix(pre, st.reused_tokens, err)) return false;
    if (!decode(tail, 0, err)) return false;
    st.prompt_ms = ms_since(t0);
    trace("generate: tokens");

    const llama_vocab * vocab = llama_model_get_vocab(model_);
    llama_sampler_reset(smpl_);
    std::string pending;   // octets pas encore transmis (caractère UTF-8 incomplet)
    auto t1 = std::chrono::steady_clock::now();
    int pos = st.prompt_tokens;
    for (int i = 0; i < max_tokens && pos < n_ctx - 1; i++, pos++) {
        if (cancel_) { err = "cancelled"; return false; }
        llama_token tok = llama_sampler_sample(smpl_, ctx_, -1);
        if (i == 0) st.first_ms = ms_since(t0);
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
    trace("generate: done (" + std::to_string(st.gen_tokens) + " tokens)");
    return true;
}

}  // namespace vh
