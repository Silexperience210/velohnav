// Banc du moteur natif (android/app/src/main/cpp/vh_llm.cpp) sur PC : même code que
// dans l'APK, mêmes prompts que l'application (préparés par run.mjs).
//
//   vh_llm_bench <modèle.gguf> <cpu|vulkan> <cas> <max_tokens> [threads=4]
// <cas> : enregistrements séparés par \x1e, consigne et suite séparées par \x1f.
// Sortie : une ligne JSON par cas.
#include <cstdio>
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
    std::string info, err;
    if (!eng.load(argv[1], argv[2], 4096, argc > 5 ? atoi(argv[5]) : 4, info, err)) {
        printf("{\"error\":\"%s\"}\n", esc(err).c_str());
        return 1;
    }
    printf("{\"info\":%s}\n", info.c_str());
    fflush(stdout);
    for (auto & c : cases) {
        std::string out; vh::GenStats st;
        bool ok = eng.generate(c.first, c.second, atoi(argv[4]), nullptr, out, st, err);
        printf("{\"ok\":%s,\"text\":\"%s\",\"error\":\"%s\",\"promptTokens\":%d,\"reused\":%d,\"genTokens\":%d,\"promptMs\":%.1f,\"genMs\":%.1f,\"eog\":%s}\n",
               ok ? "true" : "false", esc(out).c_str(), ok ? "" : esc(err).c_str(), st.prompt_tokens, st.reused_tokens,
               st.gen_tokens, st.prompt_ms, st.gen_ms, st.eog ? "true" : "false");
        fflush(stdout);
    }
    return 0;
}
