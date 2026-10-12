// Banc du moteur natif (android/app/src/main/cpp/vh_llm.cpp) sur PC : même code que
// dans l'APK, mêmes prompts que l'application (préparés par run.mjs).
//
//   vh_llm_bench <modèle.gguf> <cpu|vulkan> <cas> <max_tokens> [threads=4]
// VH_NCTX : taille du contexte (4096 par défaut, comme l'application) ; VH_CALIB=0 : fils fixes.
// <cas> : enregistrements séparés par \x1e, consigne et suite séparées par \x1f.
// Sortie : une ligne JSON par cas.
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>
#include "vh_llm.h"

static std::string esc(const std::string & s) {
    std::string o;
    for (unsigned char c : s) {
        if (c == '"' || c == '\\') { o += '\\'; o += (char) c; }
        else if (c == '\n') o += "\\n";
        else if (c < 0x20) { char b[8]; snprintf(b, sizeof b, "\\u%04x", c); o += b; }
        else o += (char) c;
    }
    return o;
}

int main(int argc, char ** argv) {
    if (argc < 5) { fprintf(stderr, "usage: %s model backend cases max_tokens [threads]\n", argv[0]); return 2; }
    std::ifstream f(argv[3], std::ios::binary);
    std::stringstream ss; ss << f.rdbuf();
    std::string all = ss.str();
    std::vector<std::pair<std::string, std::string>> cases;
    size_t p = 0;
    while (p < all.size()) {
        size_t e = all.find('\x1e', p); if (e == std::string::npos) e = all.size();
        std::string rec = all.substr(p, e - p);
        size_t s = rec.find('\x1f');
        if (s != std::string::npos) cases.push_back({rec.substr(0, s), rec.substr(s + 1)});
        p = e + 1;
    }
    vh::init();
    printf("{\"devices\":%s}\n", vh::devices_json().c_str());
    vh::Engine eng;
    // VH_GPU_EXACT=0 : réglage d'avant (cache clés-valeurs fp16, flash attention auto)
    if (const char * e = getenv("VH_GPU_EXACT")) eng.gpu_exact = atoi(e) != 0;
    // VH_CALIB=0 : pas de calibrage des fils (exactement [threads] fils)
    if (const char * e = getenv("VH_CALIB")) eng.calibrate = atoi(e) != 0;
    std::string info, err;
    const int n_ctx = getenv("VH_NCTX") ? atoi(getenv("VH_NCTX")) : 4096;
    if (!eng.load(argv[1], argv[2], n_ctx, argc > 5 ? atoi(argv[5]) : 4, info, err)) {
        printf("{\"error\":\"%s\"}\n", esc(err).c_str());
        return 1;
    }
    printf("{\"info\":%s}\n", info.c_str());
    fflush(stdout);
    for (auto & c : cases) {
        std::string out; vh::GenStats st;
        bool ok = eng.generate(c.first, c.second, atoi(argv[4]), nullptr, out, st, err);
        printf("{\"ok\":%s,\"text\":\"%s\",\"error\":\"%s\",\"promptTokens\":%d,\"reused\":%d,\"genTokens\":%d,\"promptMs\":%.1f,\"firstMs\":%.1f,\"genMs\":%.1f,\"eog\":%s,\"cpus\":\"%s\"}\n",
               ok ? "true" : "false", esc(out).c_str(), ok ? "" : esc(err).c_str(), st.prompt_tokens, st.reused_tokens,
               st.gen_tokens, st.prompt_ms, st.first_ms, st.gen_ms, st.eog ? "true" : "false", esc(st.cpus).c_str());
        fflush(stdout);
    }
    // Mémoire du processus (Linux) : résidente à la fin et pic. Sur PC avec un GPU dédié, les
    // poids Vulkan sont en mémoire vidéo et n'y figurent pas ; sur téléphone (mémoire unifiée),
    // ils compteraient — d'où la mesure faite aussi par le service :llm sur l'appareil.
    std::ifstream st("/proc/self/status");
    long rss = -1, hwm = -1;
    for (std::string l; std::getline(st, l);) {
        if (l.rfind("VmRSS:", 0) == 0) rss = atol(l.c_str() + 6);
        else if (l.rfind("VmHWM:", 0) == 0) hwm = atol(l.c_str() + 6);
    }
    // PSS : part proportionnelle (pages partagées divisées) — avec les poids en mmap, RSS
    // compte tout le fichier lu, PSS ce que le processus coûte vraiment au système.
    std::ifstream sr("/proc/self/smaps_rollup");
    long pss = -1;
    for (std::string l; std::getline(sr, l);) if (l.rfind("Pss:", 0) == 0) { pss = atol(l.c_str() + 4); break; }
    printf("{\"mem\":{\"rssKb\":%ld,\"hwmKb\":%ld,\"pssKb\":%ld}}\n", rss, hwm, pss);
    return 0;
}
