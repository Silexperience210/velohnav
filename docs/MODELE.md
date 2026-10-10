# Modèle local : le plus léger qui sait appeler des outils

Mesures du 2026-10-09. `@huggingface/transformers` installé : **3.8.1**
(onnxruntime-web 1.22.0-dev.20250409 dans l'application, onnxruntime-node 1.21.0 pour les essais).

## Verdict

**Aucun candidat n'est à la fois compatible avec la 3.8.1, plus léger que Qwen2.5-0.5B et
fiable pour appeler les outils.** Le meilleur score mesuré est 6/12, ce qui reste insuffisant
pour s'en remettre au modèle seul.

**Recommandation : LFM2.5-350M (`onnx-community/LFM2.5-350M-ONNX`, q4).** C'est le plus petit
modèle qui produit des appels d'outils exploitables, et il fait légèrement mieux que la référence
(6/12 contre 5/12) avec environ 3,6 fois moins de mémoire. **Condition bloquante :** il faut passer à
`@huggingface/transformers` v4, car son export ONNX ne se charge pas avec la 3.8.1 (voir plus bas).
Cette montée de version n'est pas faite ici.

| | Qwen2.5-0.5B (actuel) | LFM2.5-350M | Écart |
|---|---|---|---|
| Fichier WebGPU (q4f16) | 483,0 Mo | 255,1 Mo | −47 % |
| Fichier WASM (actuel q8 / LFM2.5 q4) | 512,1 Mo | 293,8 Mo | −43 % |
| Pic RSS mesuré, Node CPU, q4, transformers.js 4.3.1 | 2 934 Mo | 821 Mo | **−72 %** |
| Score outils (banc ci-dessous) | 5/12 | 6/12 | +1 |

Le pic RSS a été mesuré sur PC (Node, CPU) et non sur le téléphone. Il sert à comparer les
modèles entre eux, à runtime identique ; il ne prédit pas la consommation absolue sur Android.

Si la montée en v4 est refusée, rester sur Qwen2.5-0.5B : aucun autre candidat compatible avec la
3.8.1 ne fait mieux à poids inférieur (voir tableau).

## Tailles mesurées

**Méthode :** `node scripts/measure-models.mjs`. Le script lit l'API du Hub
(`/api/models/<id>/tree/<rév>/onnx`), sans rien télécharger, puis additionne
`model<suffixe>.onnx` et ses `.onnx_data`. Les suffixes sont ceux de transformers.js 3.x :
q4 → `_q4`, q4f16 → `_q4f16`, q8 → `_quantized`. Les tailles sont en Mo (10⁶ octets).

| Modèle (dépôt ONNX) | q4 | q4f16 | q8 | Charge en 3.8.1 ? | Score outils | Pic RSS q4* |
|---|---|---|---|---|---|---|
| FunctionGemma-270M (`onnx-community/functiongemma-270m-it-ONNX`) | 801,5 | 426,2 | — | oui | 2/12 | 2 577 Mo |
| LFM2-350M (`onnx-community/LFM2-350M-ONNX`, `main`) | 293,8 | 255,1 | 510,1 | **non** | 2/12 (v4) | 871 Mo (v4) |
| LFM2-350M, révision `5bc4b3e8cf` (export 3.x) | 481,2 | 312,5 | — | oui | 2/12 | 1 487 Mo |
| **LFM2.5-350M** (`onnx-community/LFM2.5-350M-ONNX`) | **293,8** | **255,1** | 510,1 | **non** | **6/12 (v4)** | **821 Mo (v4)** |
| Hammer 2.1 0.5B (`keisuke-miyako/Hammer2.1-0.5b-onnx-int4`) | — | — | — | non (format ORT GenAI, 864 Mo) | non testé | — |
| Qwen3-0.6B (`onnx-community/Qwen3-0.6B-ONNX`) | 919,1 | 569,8 | 617,7 | oui | 1/12 | 3 847 Mo |
| SmolLM2-135M (`onnx-community/SmolLM2-135M-Instruct-ONNX`) | 180,6 | 117,3 | 135,7 | oui | non testé** | — |
| SmolLM2-360M (`onnx-community/SmolLM2-360M-Instruct-ONNX`) | 386,5 | 272,4 | 363,1 | oui | 1/12 | 1 263 Mo |
| *Qwen2.5-0.5B (`onnx-community/Qwen2.5-0.5B-Instruct`), référence* | 786,2 | 483,0 | 512,1 | oui | 5/12 | 3 422 Mo (2 934 en v4) |

\* Pic de mémoire résidente du processus Node pendant le banc, en q4 sur CPU, avec
transformers.js 3.8.1 sauf mention « (v4) » (4.3.1). Les chiffres d'une même colonne ne sont
comparables qu'à runtime identique.
\** Même famille et même gabarit que SmolLM2-360M (voir « Appel d'outils »).

FunctionGemma pèse plus lourd que la référence en q4, malgré ses 270 M paramètres. En cause, son
vocabulaire de 262 144 jetons : la table d'embeddings domine le fichier.

## Portage ONNX et compatibilité 3.8.1

**Méthode :** chargement réel avec `AutoModelForCausalLM.from_pretrained` (3.8.1, Node). En cas
d'échec, j'ai fait une seconde tentative avec l'`InferenceSession` d'onnxruntime-web 1.22-dev
(WASM), le runtime de l'application.

- **LFM2 / LFM2.5 (`main`)** : les deux runtimes refusent le chargement. Erreur Node :
  `Unrecognized attribute: bits for operator GatherBlockQuantized`. Les dépôts ont été ré-exportés
  pour « Transformers.js v4 » (LFM2 le 2026-03-24 ; LFM2.5, publié le 2026-03-31, n'existe que dans
  ce format). La révision `5bb751bafe` de LFM2.5 échoue de la même façon. Seule la révision
  `5bc4b3e8cf` de LFM2 charge en 3.8.1, mais ses embeddings ne sont pas quantifiés, d'où un q4
  de 481 Mo. Avec transformers.js 4.3.1 et onnxruntime-node 1.30, les deux modèles de `main`
  chargent et tournent.
- **Hammer 2.1 0.5B** : le seul portage ONNX trouvé sur le Hub vise onnxruntime-genai
  (`genai_config.json`, `model.onnx.data` de 864 Mo, pas de dossier `onnx/`). Transformers.js ne
  le charge pas ; il faudrait faire un export soi-même.
- **FunctionGemma, Qwen3, SmolLM2, Qwen2.5** : chargement OK en 3.8.1 (architectures
  `gemma3_text`, `qwen3`, `llama`, `qwen2`, toutes présentes dans `models.js`).

## Appel d'outils : banc mesuré

**Méthode :** `node scripts/bench-tools.mjs <dépôt> q4 <révision> <cache>`.

- Les 6 outils de l'application (copie figée de `src/ai/tools.js`) sont passés via
  `apply_chat_template({ tools })`.
- 12 questions en français : 11 appellent un outil, 1 n'en appelle aucun.
- Décodage glouton, 48 jetons maximum, `enable_thinking: false`.
- Une réponse compte « OK » si elle contient **exactement un appel**, au bon outil, avec les
  valeurs d'arguments attendues (ex. `Hamilius` et `dock`). Un nom d'outil simplement cité dans une
  phrase ne compte pas.

Le banc est petit : un point vaut 8 %. Il départage les modèles, mais ne mesure pas un taux
d'erreur précis. Les sorties brutes s'affichent en relançant le script.

Ce que les modèles ratent :
- **LFM2.5-350M (6/12)** : il respecte toujours le format. Les erreurs portent sur le choix
  d'outil ou d'argument : `route` remplacé par `find_station` ou `start_navigation`, `need="dock"`
  pour un vélo électrique, `mode` absent pour le bus.
- **Qwen2.5-0.5B (5/12)** : il répond souvent en texte au lieu d'appeler l'outil (« Could you
  please tell me your current location? »). Il lui arrive aussi d'appeler `weather` pour un bus.
- **LFM2-350M (2/12)** : il invente des noms d'outils (`next_departure_time`) et des arguments
  (`location=`). En v4, il refuse souvent de répondre.
- **FunctionGemma (2/12)** : il remplit les arguments avec le texte des descriptions
  (`need: "bike to take a bike for a ride…"`). Il a aussi produit une boucle de
  `<start_function_call>` mêlée de jetons parasites.
- **Qwen3-0.6B (1/12, sans réflexion)** : il répond presque toujours lui-même et **invente des
  données** (« Le prochain tram est à 10 minutes »). Le mode réflexion n'a pas été testé : il
  consomme des centaines de jetons avant l'appel.
- **SmolLM2-360M (1/12)** : son gabarit ignore les outils. Le prompt ne fait que 44 à 56 jetons,
  contre plus de 650 pour les autres, donc le modèle ne les voit jamais.

## Entraînement à l'appel de fonctions : ce que disent les sources

| Modèle | Entraîné pour les outils ? | Source |
|---|---|---|
| FunctionGemma-270M | Oui, c'est sa fonction. Mais il est « intended to be fine-tuned for your specific function-calling task » et n'est performant « after further fine-tuning » | carte `google/functiongemma-270m-it` |
| LFM2-350M | Oui : format d'appel pythonique entre `<\|tool_call_start\|>` et `<\|tool_call_end\|>`. Fine-tuning recommandé « on narrow use cases » | carte `LiquidAI/LFM2-350M`, section *Tool use* |
| LFM2.5-350M | Oui : « We recommend using it for data extraction, structured outputs, and tool use » | carte `LiquidAI/LFM2.5-350M` |
| Hammer 2.1 0.5B | Oui : fine-tuning « function calling » (xlam-function-calling-60k, function masking), évalué sur BFCL-v3 | carte `MadeAgents/Hammer2.1-0.5b` |
| Qwen3-0.6B | Affirmé pour la famille : « Qwen3 excels in tool calling capabilities ». Pas de chiffre propre au 0.6B | carte `Qwen/Qwen3-0.6B` |
| SmolLM2-135M / 360M | **Non** : « function calling (for the 1.7B) ». Seul le 1.7B est concerné | cartes `HuggingFaceTB/SmolLM2-*-Instruct` |

## Licences (application distribuée)

| Modèle | Licence | Conditions à respecter |
|---|---|---|
| LFM2 / LFM2.5 | LFM Open License v1.0 | Redistribution libre, avec licence et notices à joindre. **Usage commercial permis seulement si l'entité reste sous 10 M$ de chiffre d'affaires annuel** (section 5) |
| FunctionGemma | Gemma Terms of Use (dépôt à accès contrôlé) | Transmettre les conditions et la Prohibited Use Policy aux utilisateurs |
| Hammer 2.1 0.5B | **CC-BY-NC-4.0** | **Usage commercial interdit**, ce qui l'exclut pour une application distribuée |
| Qwen3-0.6B, Qwen2.5-0.5B, SmolLM2 | Apache-2.0 | Joindre la licence et les notices |

## Conversation libre : le cas « Je suis Silex », mesuré

Symptôme rapporté : modèle « prêt », question libre, et la bulle affiche le texte de repli
(« Sans modèle, je réponds… ») sans aucune erreur.

**Méthode :** `node scripts/bench-chat/repro-conversation.mjs <dtype> <device>` (Node) et
`node scripts/bench-chat/run.mjs <webgpu|wasm> conversation` (Chrome, worker de
l'application). Même conversation sur six tours (`cases.CONVERSATION`), même historique,
mêmes options (`generationOptions`, 96 jetons, glouton), même chemin `cleanReply` →
`resolveModelOutput`.

| Chemin | Chargement | « Je suis Silex » : sortie brute | Affiché |
|---|---|---|---|
| Node, q4, CPU | oui | `"Comment puis-je vous aider aujourd'hui ?<\|im_end\|>"` (10 jetons, fin de tour) | réponse du modèle, 6/6 tours |
| Node, q4f16, WebGPU natif (Dawn, vrai GPU) | oui | identique | réponse du modèle, 6/6 tours |
| Chrome, q4, WASM | **non** : `GatherBlockQuantized` sans implémentation, la session ne se crée pas | — | — |
| Chrome, q4f16, WebGPU sans `shader-f16` (forcé) | **oui** | **vide** : erreur `OrtRun` à chaque génération (`Sub requires f16`) | repli `generate`, 0/6, **aucune erreur montrée** |
| Chrome, **q4, WebGPU** sans `shader-f16` (adaptateur logiciel) | oui | `"Comment puis-je vous aider aujourd'hui ?<\|im_end\|>"` | réponse du modèle, 3/3 tours mesurés (~200 s par réponse : GPU émulé, durée non représentative) |

Ce qui est établi :
- la sortie du modèle n'est ni tronquée ni réduite à du balisage : 10 à 51 jetons sur 96,
  toujours terminée par `<|im_end|>`, acceptée par `checkFreeText` ;
- dans le navigateur, seule la variante q4f16 sur WebGPU peut être « prête » : le téléphone
  qui affiche « prêt » est sur ce chemin ;
- **une session peut se charger et échouer à chaque génération.** L'application rattrapait
  alors l'erreur (`ModelError` « generate ») et affichait le repli sans rien dire : seul
  `generate_timeout` était signalé. « Aucune erreur affichée » ne prouvait donc pas que le
  modèle avait répondu.

Correctif qui en découle :
- **essai à vide** : le worker génère 6 jetons juste après le chargement ; « prêt » n'est
  annoncé que si le texte produit est lisible (`selfTestVerdict`). Mesuré dans Chrome : q4f16
  sur un GPU sans fp16 échoue désormais au chargement, avec le message du moteur, au lieu
  d'afficher « prêt » ; q4 sur WebGPU passe l'essai ;
- **ordre des replis** : q4f16/GPU → q4/GPU → q4/WASM. Un échec fp16 (chargement, essai à
  vide ou génération) écarte q4f16, pas le GPU ; un GPU sans `shader-f16` part directement
  en q4/GPU. Le changement passe par « Réessayer », taille annoncée (294 Mo).

Ce qui reste supposé (aucune mesure sur téléphone) : la cause exacte sur l'appareil du
propriétaire — une erreur de génération WebGPU propre à son GPU (cas le plus cohérent avec
les mesures) ou une réponse rejetée par `checkFreeText`. L'interface dit désormais laquelle.

## Vitesse sur le processeur : ce qui la limite, mesuré

Retour du téléphone : « prêt · q4 · processeur · calcul 32 bits », génération très lente.
« Calcul 32 bits » est exact et normal : poids 4 bits, activations fp32 (le WASM n'a pas
d'arithmétique fp16). La lenteur a trois causes, mesurées sur un PC de bureau :

| Cause | Mesure | Correctif |
|---|---|---|
| Consigne + outils recalculés à chaque question (723 jetons sur 733) | 28,9 s avant le premier mot (WASM, 1 fil) | cache de préfixe + calcul anticipé (`promptCache.js`) : réponse de 16 jetons 52,7 s → 25,6 s, sortie identique 5/5 |
| Un seul fil : WebView non isolée (pas de COOP/COEP) | 4 fils ≈ 3,4× plus rapide dans Chrome (consigne 25,2 → 7,4 s) | en-têtes ajoutés par `IsolatingWebViewClient` |
| `MatMulNBits` (poids 4 bits) sans noyau WASM : la matrice entière est redéquantifiée à **chaque jeton** | 1 490 ms/jeton en WASM contre 71 ms/jeton en onnxruntime natif (même modèle, 1 fil) ; micro-banc 1024×4608 : 14,5 ms contre 1,0 ms en fp32 ou `MatMulInteger` | **aucun dans les contraintes**, voir ci-dessous |

Piste écartée — réécrire les poids en int8 (`scripts/bench-chat/q4-to-int8.py`,
`MatMulInteger` a un noyau SIMD WASM) : 13 fois plus rapide (112 ms/jeton), mais le
modèle devient **inutilisable** (accord top-1 avec q4 : 0 %, sortie « compete for force
force… »). `DynamicQuantizeLinear` quantifie l'activation sur un seul uint8 par tenseur ;
les entrées de `down_proj` et `conv/out_proj` ont un rapport max/médiane de 1 000 à 2 500.
Convertir la seule couche 0 fait déjà tomber l'accord à 80 %. Il faudrait une
quantification calibrée (SmoothQuant), un fichier hébergé hors du Hub, et 432 Mo de
poids : le contrôle mémoire (pic estimé 1,6 Go) le refuserait sur le téléphone du
propriétaire (1 384 Mo libres). Le fp32 (1,45 Go) est exclu pour la même raison.

Conclusion : sur le processeur, le décodage reste borné par `MatMulNBits` (≈ 1,5 s par
jeton et par fil sur PC de bureau). Le vrai gain est le GPU : l'écran dit désormais
pourquoi il est écarté (« GPU non utilisé — … »), cause à lire sur le téléphone.

## GPU Adreno : « 鹰 », « 龙 » — cause et correctif

Retour du téléphone (Android 14, WebView Chrome 153, Adreno) : « prêt · q4 · processeur »,
« GPU non utilisé · démarrage q4f16 en échec », essai à vide « 鹰 », « 龙 ». Les deux variantes
GPU se **chargent** ; c'est leur **calcul** qui est faux : « Bonjour » en glouton donne un
idéogramme isolé, là où le processeur et un GPU de bureau donnent « Bonjour ! Comment puis- ».
L'essai à vide ne condamne donc pas une voie utilisable : il rejette une sortie fausse.

Cause la plus probable (publique, non mesurée ici) : depuis onnxruntime-web 1.30, le noyau
`MatMulNBits` (93 nœuds sur ce modèle, accuracy_level 0, blocs de 32) prend une voie
`subgroupShuffle` sur tout GPU non NVIDIA exposant `subgroups`. Sur Adreno elle rend des
valeurs fausses (Adreno 660, Chrome 154 : −2,7 dB contre 78,5 dB attendus) ou fait planter le
compilateur de shaders (Adreno 750, Chrome 153/154) ; créer le device **sans** `subgroups` la
corrige (musetric#975, #990). Le build embarqué (1.31.0-dev) contient cette voie, et aussi le
noyau Transpose à tuile `tile_size + 1`, rapporté faux sur Adreno 660/730.

Correctif (`gpuDeviceRequest`, `gpuSessionOptions`, `orderFor`) :
- le worker crée lui-même le device WebGPU, avec toutes les fonctions de l'adaptateur sauf
  `subgroups*`, et le donne à onnxruntime (option `device` du fournisseur) ;
- nouvelle marche **q4 GPU « sur »** : Transpose (20) sur le processeur et disposition NCHW ;
- q4f16 : accumulation fp32 (le fp16 Adreno perd les petites valeurs) ;
- sur Adreno : q4 GPU, puis q4 « sur » (déjà en cache), puis q4f16 (255 Mo), puis processeur ;
- échelle v4 : les échecs GPU mémorisés avec subgroups sont oubliés, rejoués une fois.

Mesuré ici (RTX 3060, Chrome, `HEADLESS=0 ATTEMPT=… run.mjs webgpu-q4 prefixe`) :

| Tentative | Device | Essai à vide | 3 questions (ms) |
|---|---|---|---|
| q4/webgpu | sans subgroups, subgroup-matrix, subgroup-size-control | « Bonjour ! Comment puis- » | 1 507 · 480 · 258 |
| q4/webgpu/sur | idem, Transpose sur le processeur, NCHW | identique | 854 · 1 073 · 552 |
| échelle réelle (`PAGE=ladder`) | — | retenu : q4/webgpu (q4f16 écarté : pas de shader-f16) | prêt en 3,6 s |

Sorties identiques mot pour mot ; pour comparaison, le processeur (4 fils) : 4,8 à 11 s.

À vérifier sur le téléphone (rien ne peut l'être ici, NVIDIA n'emprunte pas la voie
subgroups) : que q4/webgpu passe l'essai à vide sans subgroups ; sinon que « sur » le passe ;
la vitesse réelle. L'écran dit la tentative retenue (« GPU · q4 », « · mode sûr ») et, en
cas d'échec, l'erreur ou la sortie exacte de chaque tentative.

## Ce qui n'a pas été mesuré

- Aucune mesure sur téléphone (mémoire, vitesse, WebGPU). Toutes les mesures RSS viennent de
  Node sur CPU.
- Le banc en v4 a tourné dans un dossier jetable (`~/.cache/velohnav-v4`) : le dépôt reste en 3.8.1.
- Pas de q4f16 ni de WebGPU au banc. Les scores valent pour la variante q4.
- Pas de prompt optimisé par modèle : même consigne système pour tous.

## Moteur natif (llama.cpp, Vulkan) : où on en est (10/10/2026)

Décision du propriétaire : le GPU de son téléphone doit exécuter le modèle. WebGPU ne
l'atteint pas (q4f16 échoue au démarrage, voir plus haut) : le moteur natif est la voie
principale.

- **écrit** : sources C++ (`android/app/src/main/cpp`), JNI, service isolé « :llm » (un
  plantage du pilote GPU ne tue que ce processus), greffon Capacitor `LocalLlm` (status,
  download vérifié SHA-256, devices, load, warm, generate, cancel, unload).
- **compile pour Android** : `./gradlew :app:externalNativeBuildDebug -PvhNative=1` →
  `libvh_llm.so`, 25,3 Mo non compressés, 8,1 Mo compressés. Vérifié le 10/10, après
  correction de la chaîne d'outils de l'outil hôte des nuanceurs (`vulkan-shaders-gen`) :
  le fichier de chaîne d'outils doit fixer `CMAKE_MAKE_PROGRAM` en ENTRÉE DE CACHE
  (`set(… CACHE FILEPATH … FORCE)`) — un `set()` simple ne suffit pas, et le ninja du SDK
  n'est pas dans le PATH de Gradle. Gradle ne reconfigure pas un dossier `.cxx` déjà
  construit : il faut l'écarter pour que le nouveau fichier de chaîne d'outils soit écrit.
- **mesuré sur PC** (banc `scripts/bench-native`) : processeur 104,1 j/s, Vulkan
  (RTX 3060) 396,1 j/s de génération, réponses en français 8/10 dans les deux cas, essai à
  vide concluant. Même gabarit, même consigne et même lecture de sortie que l'application.
- **pas embarqué dans l'APK livrée** : rien n'appelle encore le greffon depuis `src/`, et
  8,1 Mo compressés feraient passer l'APK de 51 Mo à ~59 Mo, au-delà de la limite de 50 Mo
  de Telegram. La construction native est donc demandée explicitement (`-PvhNative=1`).
- **reste à faire** : brancher le greffon dans la chaîne de l'IA (une marche « GPU natif »
  au-dessus de WebGPU), dire la voie retenue à l'écran, puis mesurer les jetons/s SUR le
  téléphone. Aucune mesure de téléphone n'est possible ici — et donc, aujourd'hui, aucun
  élément ne prouve que le GPU de son appareil exécute le modèle.
