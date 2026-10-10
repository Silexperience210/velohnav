// Moteur conversationnel natif : llama.cpp, sur le GPU (Vulkan) ou le processeur.
//
// Indépendant d'Android : le même code est compilé pour l'APK (vh_llm_jni.cpp) et pour
// le PC (scripts/bench-native), où il est mesuré.
#pragma once

#include <atomic>
#include <functional>
#include <string>
#include <vector>

struct llama_model;
struct llama_context;
struct llama_sampler;

namespace vh {

/** Initialise llama.cpp et capture son journal. Une fois par processus. */
void init();

/** Appareils de calcul vus par ggml : [{"name","description","backend","type","memFreeMB","memTotalMB"}]. */
std::string devices_json();

/** Dernières lignes du journal de llama.cpp / ggml (avertissements et erreurs surtout). */
std::string log_tail(size_t max_lines = 12);

struct GenStats {
    int prompt_tokens = 0;    // jetons du prompt complet
    int reused_tokens = 0;    // dont repris de l'état gardé (consigne)
    int gen_tokens = 0;       // jetons produits
    double prompt_ms = 0;     // calcul du prompt (hors partie reprise)
    double gen_ms = 0;        // production des jetons
    bool eog = false;         // arrêt sur fin de tour (et non sur la limite)
};

class Engine {
public:
    ~Engine();

    /**
     * Charge le modèle sur `backend` : "vulkan" (ou tout nom de moteur ggml : "opencl"…)
     * pour le GPU, "cpu" pour le processeur seul. Rend false et `err` lisible en cas
     * d'échec ; `info` (JSON) dit ce qui a été retenu.
     */
    bool load(const std::string & path, const std::string & backend, int n_ctx, int n_threads,
              std::string & info, std::string & err);

    /** Calcule et garde l'état du modèle à la fin de `prefix` (consigne + outils). */
    bool warm(const std::string & prefix, std::string & err);

    /**
     * Génère après `prefix` + `rest` (texte déjà mis en forme par le gabarit, jetons
     * spéciaux compris). Décodage glouton. `on_piece` reçoit le texte au fil de l'eau
     * (UTF-8 complet) ; rendre false l'interrompt. Arrêt sur fin de tour : "<|im_end|>"
     * est alors ajouté à `out`, comme le fait le décodage de transformers.js.
     */
    bool generate(const std::string & prefix, const std::string & rest, int max_tokens,
                  const std::function<bool(const std::string &)> & on_piece,
                  std::string & out, GenStats & st, std::string & err);

    void unload();
    bool loaded() const { return ctx_ != nullptr; }

    /** Interrompt la génération en cours (appelable depuis un autre fil). */
    void cancel() { cancel_ = true; }

private:
    bool tokenize(const std::string & text, std::vector<int32_t> & out, std::string & err) const;
    bool decode(const std::vector<int32_t> & toks, size_t from, std::string & err);
    bool ensure_prefix(const std::vector<int32_t> & pre, int & reused, std::string & err);

    llama_model * model_ = nullptr;
    llama_context * ctx_ = nullptr;
    llama_sampler * smpl_ = nullptr;
    int n_batch_ = 512;

    // État gardé à la fin de la consigne : jetons + copie de l'état de la séquence 0.
    // LFM2 est hybride (convolutions + attention) : on ne peut pas tronquer son état à
    // une position quelconque, on le RESTAURE depuis cette copie.
    std::vector<int32_t> ckpt_tokens_;
    std::vector<uint8_t> ckpt_state_;

    std::atomic<bool> cancel_{false};
};

}  // namespace vh
