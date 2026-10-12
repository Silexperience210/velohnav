# Moteur natif : un modèle plus intelligent que LFM2.5-350M ?

Mesures du 2026-10-12, banc `scripts/bench-native/compare.mjs` : le code de l'APK
(`vh_llm.cpp`), sur le processeur, 4 fils fixes (`VH_CALIB=0`), contexte 4 096. Chaque
modèle reçoit la consigne de l'application dans le gabarit de sa famille
(`chatTemplate.js`, vérifié identique à `apply_chat_template` : `template.mjs` et
`template-families.mjs`). Sorties lues comme dans l'application (`cleanReply` →
`resolveModelOutput`). GGUF téléchargés et vérifiés (taille, SHA-256) par `fetch.mjs`.

**Mesuré sur PC (i7-8750H), pas sur le téléphone** : aucun téléphone n'était branché.
LFM2.5-350M y tourne à 96–104 j/s, ce qui correspond à ce qu'on relève sur le Snapdragon 888
(88–101). La colonne « 888 estimé » applique donc la proportion mesurée sur PC à 95 j/s.
Pour mesurer sur l'appareil : `ADB=1 node scripts/bench-native/compare.mjs …`.

## Verdict

**LFM2.5-1.2B-Instruct Q4_0** (`lfm2.5-1.2b`). C'est le seul candidat nettement plus
intelligent en conversation libre qui tienne les contraintes : ~33 j/s estimés (≥ 10),
1,4 Go de mémoire (≤ 2 Go). C'est aussi un remplacement direct : même gabarit et même format
d'outils que le 350M, donc aucun changement de consigne, de lecture ni d'interface.

APK d'évaluation : `VITE_NATIVE_MODEL=lfm2.5-1.2b npm run build`. Le défaut reste
LFM2.5-350M tant que le choix n'est pas validé sur le téléphone.

## Vitesse, mémoire, outils (banc complet, 13 points)

| modèle | quant. | fichier | consigne à froid | 1er jeton | j/s PC | j/s 888 estimés | RSS / PSS | station | météo | libre | total |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **lfm2.5-350m** (actuel) | q4_0 | 219 Mo | 1,6 s | 63 ms | 103,6 | ~95 | 590 / 514 Mo | 2/4 | 1/3 | 5/6 | 8/13 |
| **lfm2.5-1.2b** | q4_0 | 696 Mo | 5,5 s | 203 ms | 35,6 | ~33 | 1 464 / 1 388 Mo | 0/4 | 1/3 | 6/6 | 7/13 |
| lfm2.5-1.2b | q4_k_m | 731 Mo | 4,8 s | 202 ms | 33,5 | ~31 | 1 400 / 1 324 Mo | 1/4 | 2/3 | 5/6 | 8/13 |
| qwen2.5-0.5b | q4_k_m | 491 Mo | 3,6 s | 153 ms | 50,7 | ~46 | 747 / 671 Mo | 2/4 | 0/3 | 3/6 | 5/13 |
| qwen2.5-0.5b | q4_0 | 429 Mo | 2,4 s | 113 ms | 58,5 | ~54 | 849 / 773 Mo | 1,5/4 | 2/3 | 4/6 | 7,5/13 |
| qwen2.5-1.5b | q4_k_m | 1 117 Mo | 7,6 s | 304 ms | 23,3 | ~21 | 2 020 / 1 943 Mo | 0/4 | 0/3 | 4/6 | 4/13 |
| qwen2.5-1.5b | q4_0 | 1 066 Mo | 8,4 s | 297 ms | 24,6 | ~23 | 2 075 / 1 999 Mo | 0/4 | 1/3 | 4/6 | 5/13 |
| phi-3-mini | q4_k_m | 2 393 Mo | 22,6 s | 918 ms | 9,0 | ~8 | 5 480 / 5 403 Mo | 2,5/4 | 1/3 | 0/6 | 3,5/13 |
| tinyllama-1.1b | q4_k_m | 669 Mo | 6,7 s | 432 ms | 30,7 | ~28 | 1 284 / 1 208 Mo | 0/4 | 0/3 | 1/6 | 1/13 |

« Consigne à froid » : calcul de la consigne et de ses outils (744 à 933 jetons). L'application
la calcule d'avance (`warmNative`) ; sur le téléphone, ce temps sera plus long que sur PC.

**RSS ≈ 2 × le fichier** pour tous les Q4_0 : llama.cpp réempaquette les poids pour les cœurs
ARM/AVX dans un tampon à part, et les pages du fichier en mmap lues au chargement restent
comptées. Ces pages sont propres : le système peut les reprendre sous pression mémoire.

### Pourquoi les outils comptent peu ici

Dans l'application, les questions de station, de météo et de départs ne vont **jamais** au
modèle : `localAnswers.js` y répond sur les données de l'appareil (`AIScreen.jsx`, réponse
locale d'abord). Le modèle ne reçoit que ce que l'assistant local ne sait pas traiter : de la
conversation libre. C'est là que le 350M « semble bête », et c'est le critère qui tranche.
Les colonnes station et météo restent utiles pour repérer les modèles qui inventent : Qwen2.5,
avec la liste d'outils au format LFM, n'appelle aucun outil et répond « Oui, il y a des vélos à
la station Gare » ou « Oui, il va pleuvoir ». Il n'a été noté qu'avec son propre bloc d'outils
(`<tools>`, ajouté au gabarit `chatml`).

## Conversation libre (`LIBRE=1`, 96 jetons comme l'application)

Les 10 questions de `bench-chat/cases.js`, puis la conversation du téléphone en 6 tours, chaque
réponse étant réinjectée dans l'historique.

| modèle | affichées | cohérence et utilité (lecture des sorties) |
|---|---|---|
| lfm2.5-350m | 15/16 | Hors sujet fréquent : « régler la selle » → « utilisez le service de navigation, mode bicycling » ; « merci » → « je ne peux pas vous aider avec les stations » ; récite la liste des outils ; oublie le prénom (« Je ne sais pas votre prénom »). |
| **lfm2.5-1.2b q4_0** | **16/16** | Cohérent à chaque tour : « Bonjour Silex ! », « Luxembourg-Ville », blague correcte (« une bonne roue »), explique le Vel'OH!. Défaut : trop prudent (« je ne peux pas vous donner de conseils sur la selle »). |
| lfm2.5-1.2b q4_k_m | 16/16 | Proche du Q4_0. Au tour de mémoire : « Bonjour Silex ! Je n'ai pas de mémoire de vos prénoms ». Plus lent sur ARM (Q4_K_M n'est pas réempaqueté sans i8mm). |
| qwen2.5-1.5b q4_0 | 14/16 | Se prend pour l'utilisateur (« Je suis Silex, un vélo au Luxembourg »), boucle sur « Que peux-tu faire ? », 2 Go de RSS. |
| qwen2.5-0.5b q4_0 | 13/16 | Appels d'outils hors sujet (casque → `weather`, capitale → `find_station`), blagues absurdes. |
| phi-3-mini | — | Ne s'arrête pas après un appel (enchaîne « # Instruction … »), multiplie les appels. Hors budget : 9 j/s sur PC, 5,4 Go avec 4 096 jetons de contexte (aucune attention groupée : 1,5 Go de cache). |
| tinyllama-1.1b | — | Inutilisable : répond en anglais, génère du XML ou du code Vue.js, répète la consigne. |

## Limites et suites

- Vitesse et mémoire à confirmer sur le Snapdragon 888 (`ADB=1`, binaire de `android.sh`).
- Le 1.2B refuse souvent d'appeler `find_station` (« je ne peux pas vérifier en temps réel »).
  Sans conséquence aujourd'hui (l'assistant local répond avant lui), mais à revoir si le modèle
  doit un jour traiter ces questions.
- Sa prudence en conversation vient en partie de la consigne (« N'écris jamais de nombre… ») :
  une consigne assouplie pour la conversation libre serait le prochain essai.
- La voie WebGPU / WASM reste sur LFM2.5-350M ONNX : seul le moteur natif change.
