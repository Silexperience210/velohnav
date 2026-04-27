# ⬡ VelohNav

**Navigation AR pour le réseau Vel'OH! Luxembourg — PWA + APK Android natif**

[![CI](https://github.com/Silexperience210/velohnav/actions/workflows/apk.yml/badge.svg)](https://github.com/Silexperience210/velohnav/actions/workflows/apk.yml)
![React](https://img.shields.io/badge/React-18-61DAFB?logo=react)
![Capacitor](https://img.shields.io/badge/Capacitor-8-119EFF?logo=capacitor)
![ARCore](https://img.shields.io/badge/ARCore-1.46-4285F4?logo=google)
![Nostr](https://img.shields.io/badge/Nostr-BIP--340-purple)
![Lightning](https://img.shields.io/badge/Lightning-LNURL--pay-F7931A?logo=bitcoin)
![License](https://img.shields.io/badge/license-MIT-green)

---

## Ce que fait l'app

VelohNav est une app de navigation AR pour le réseau Vel'OH! Luxembourg combinant :
- **AR temps réel** avec ARCore Geospatial VPS (précision ~1m) ou tracé canvas en fallback
- **IA** Claude pour répondre en contexte (météo, dispo, distance, transport en commun)
- **Crypto-natif** : signalements décentralisés Nostr + récompenses Bitcoin Lightning
- **Multimodal** : vélo, marche, bus RGTR — avec bascule auto si météo dégrade
- **Audio HRTF 3D** pour guidage casque mains-libres
- **Style cyberpunk** noir + orange/red, futuriste, full-screen

---

## Onglets

### ⬡ AR — Réalité augmentée

**Caméra + tracé**
- **Boussole réelle** — `DeviceOrientationEvent` mode `absolute` (boussole magnétique) + low-pass filter alpha=0.25 anti-tremblement
- **Pins AR projetés** — calcul bearing + FOV 68° depuis GPS, projection en coordonnées écran
- **Tracé route multi-couches** — halo glow + ombre + bord blanc + ligne couleur + tirets animés (effet "qui avance"), animation 30 fps via `requestAnimationFrame`
- **Support DPI rétine** — canvas net sur écrans haute densité
- **Échantillonnage adaptatif** — 1 point sur N pour les routes très denses (perf)
- **Clamp aux bords FOV** — évite les coupures brutales du tracé quand on tourne la tête
- **Pin destination dédié** — projeté en AR au-dessus de la station cible, vert pulsant à <30m, masque les autres pins pendant la nav pour focus

**Navigation ARCore native (Android)**
- **VPS Geospatial** avec timeout 25s + countdown affiché à l'écran
- **Fallback GPS automatique** si VPS ne converge pas (zone sans Street View, intérieur)
- **Bouton manuel "Passer en mode GPS"** disponible immédiatement sans attendre le timeout
- **Seuils relâchés** 8m/20° (vs 5m/15° par défaut Google) + critère "acceptable" <15m après 12s
- **Affichage temps réel** précision actuelle + meilleure observée
- **Watcher GPS** pour la progression dans les étapes en mode dégradé
- **Mode "GPS limité"** explicite dans le HUD avec badge orange
- **Flèches 3D** SceneView ancrées par VPS Geospatial
- **HUD Compose cyberpunk** avec ETA, badge précision VPS, instructions par étape
- **Retry automatique** itinéraire — 3 tentatives avec backoff exponentiel (0s, 2s, 4s)

**Wind-aware ETA** 🌬️
- Croise direction du vent OpenMeteo + bearing du segment de route en cours
- Facteur de correction d'ETA en temps réel (sensibilité ~0.6%/km/h vent de face)
- Clamp 0.85x..1.35x (max +35% ETA en vent fort de face)
- Badge HUD couleur conditionnelle (rouge=face, vert=dos)
- Pas appliqué en mode walking (impact négligeable)

**Predictive Routing** ⚠️
- Surveille en temps réel l'état de la station de destination pendant la navigation
- Si elle devient inutilisable (0 vélos en pickup, 0 docks en dropoff), trouve la meilleure alternative (rayon 700m max, détour 1.5x max)
- Heuristique d'intent automatique : `trip.active` → dropoff (besoin docks), sinon pickup (besoin vélos)
- Bannière warning animée slide-up au-dessus du bandeau nav
- Cooldown 60s anti-spam, stations rejetées mémorisées pour la session

**AR Ghost Trail** 👻
- Enregistre automatiquement les positions GPS horodatées de chaque trajet station→station
- Stocke le meilleur (plus rapide) en IndexedDB, clé `originId__destId__mode`
- À chaque nav vers une destination déjà parcourue, projette en AR un fantôme virtuel
- Calcul du delta : `+5s` retard / `-2s` avance / `0s` au coude à coude
- Indicateur permanent en haut à gauche + pin AR avec halo orange dashed
- Animation float + pulse, interpolation 5 fps via recherche binaire

**Crowd-sourced obstacles via Nostr** 🚧
- 4 types signalables : Chantier, Vélo cassé, Sol glissant, Danger
- Long-press 700ms sur la zone centrale AR → menu radial
- Publié sur Nostr (kind 30078 NIP-33 paramétré, expiration 24h via NIP-40)
- Reçu en live via subscription WebSocket aux relays publics (Damus, nos.lol, nostr.band)
- **Signature Schnorr BIP-340** via `@noble/secp256k1` — events validés par tous les relays standards
- Clé éphémère anonyme (32-byte privkey) générée à la session, jamais persistée
- Pin AR avec halo coloré pulsant + nom + distance + ancienneté
- Map `seen` au niveau du pool singleton — survit aux unmount/remount

**Multimodal switch** 🌧️
- Surveille la météo OpenMeteo en live (poll 90s pendant nav vélo active)
- Si pluie démarre/s'intensifie pendant un trajet long (>1.5km), calcule un point de pivot optimal
- Sweet spot timing bus ~6 min, station avec docks libres + arrêt bus <250m
- Triggers : pluie ≥0.4mm/h (si trajet >3km), pluie ≥1.5mm/h, orage WMO ≥95
- Bannière bleue 🌧️ slide-up : "🚲 Vélo → Pivot · 🚌 Ligne N à HH:MM"
- Détaille docks libres au pivot + distance arrêt depuis station
- Cooldown 5 min entre 2 suggestions

**Audio HRTF 3D** 🎧
- L'instruction vocale est spatialisée dans le casque comme si elle venait virtuellement de la direction du virage
- Pipeline : `fetch(translate.google.com/translate_tts) → arrayBuffer (MP3 24kHz) → ctx.decodeAudioData → AudioBufferSource → HRTF Panner → ctx.destination`
- **TTS gratuit** Google Translate — no key, no auth, voix française naturelle
- **CapacitorHttp** sur Android pour bypass CORS (requête HTTP native)
- Annonces aux seuils 200m / 100m / 50m / 20m, cooldown 12s anti-répétition
- Cache LRU 50 entrées en mémoire — annonces récurrentes servies instantanément
- Versioning anti-obsolescence : annonce abandonnée si situation a changé pendant le fetch
- Fallback `SpeechSynthesis` natif si réseau down → user toujours guidé même offline
- Toggle dans Settings → APPLICATION

**Autres**
- **Boussole calibration overlay** — guide figure-8 animé si signal manquant
- **Clustering** — stations regroupées sous 500m avec comptage total vélos/docks
- **Drapeaux damier animés** sur chaque pin (svg, animation CSS)
- **Toggle Fischer 🥐** — boulangeries Fischer en AR (8 enseignes Luxembourg)

### ◈ MAP — Carte vectorielle

- **Carte SVG Luxembourg-Ville** — rivières Alzette et Pétrusse, routes principales, quartiers
- **Pan/pinch-to-zoom** natif — gestes multi-touch, limites de zoom 0.5×–4×
- **Filtres** — Tout · Vélos dispo · Docks libres · Électriques
- **Recherche textuelle** en temps réel
- **Labels stations** visibles à partir de zoom ×3
- **Détail station** au tap — nom, vélos méca/élec, docks, distance à pied, cap cardinal
- **Boutons navigation AR** — "AR PIED" et "AR VÉLO" → bascule vers l'écran AR avec nav active
- **Bouton TRAJET** — démarre un trajet VelohNav (timer + sats reward à l'arrivée)
- **Recommandation météo multimodale** — bandeau WeatherBanner : bike / mixed / transit selon pluie, vent, code WMO
- **Arrêt TC le plus proche** — 22 arrêts tram/bus Luxembourg-Ville hardcodés

### ◎ AI — Assistant IA

- **Modèle** : `claude-haiku-4-5-20251001` — 800 tokens max
- **Contexte injecté** : stations triées par distance, vélos dispo, conditions météo, mode de recommandation, départs bus RGTR temps réel
- **Lancement nav AR depuis l'IA** — l'assistant peut déclencher directement la navigation vers une station via réponse structurée
- **Historique** de conversation dans la session

### ◇ Settings

| Réglage | Description |
|---------|-------------|
| Clé JCDecaux | API Vel'OH! temps réel |
| Clé Claude | Assistant IA (console.anthropic.com) |
| Clé Google Maps | Optionnel — fallback si OSRM indisponible |
| Clé HAFAS ATP | Optionnel — bus RGTR temps réel (`opendata-api@verkeiersverbond.lu`) |
| Lightning Address | `user@provider.com` pour Sats Rewards |
| Sats Rewards | Toggle on/off — paiement LNURL-pay self-custodial |
| **Audio spatial 3D** | Toggle — guidage vocal HRTF (casque/écouteurs requis) |
| Publicités AR | Overlays sponsors dans la vue caméra |
| Langue | FR / EN — détection automatique au premier lancement |

---

## Stack

### Web / PWA

| | |
|---|---|
| Framework | React 18 + Vite 5 |
| Build mobile | Capacitor 8 |
| PWA | vite-plugin-pwa — Service Worker, cache OSRM 24h offline |
| Météo | OpenMeteo (gratuit, sans clé, CORS OK) |
| Itinéraire | OSRM public — `router.project-osrm.org` (gratuit, sans clé) |
| Itinéraire fallback | Google Directions API (clé optionnelle) |
| Transport en commun | HAFAS ATP — bus RGTR Luxembourg (clé requise) |
| Boussole | `DeviceOrientationEvent` absolu + fallback relatif |
| **Crypto** | `@noble/secp256k1` v3 — Schnorr BIP-340 pour Nostr |
| **TTS** | Google Translate (gratuit) + SpeechSynthesis fallback |
| Audio 3D | Web Audio API — `PannerNode` HRTF |
| Storage | IndexedDB v2 — stations + ghost trails |
| i18n | FR / EN — 66/91 clés branchées |
| Tests | Vitest — 43 tests unitaires |

### Android natif

| | |
|---|---|
| Language | Kotlin 2.1.0 |
| AR | ARCore 1.46.0 + SceneView 2.2.1 |
| UI | Jetpack Compose + Material3 (Compose BOM 2024.06) |
| Architecture | ViewModel + StateFlow + Coroutines 1.8.1 |
| Réseau | OkHttp 4 + Retrofit 2.11 + Gson |
| GPS | FusedLocationProviderClient |
| HTTP bridge | CapacitorHttp (bypass CORS) |
| Build | AGP 8.9.1 · Java 21 · compileSdk 36 · minSdk 24 |
| CI | GitHub Actions — debug APK automatique, release auto sur tag `v*` |

> **IA on-device** : Gemini Nano (AICore) n'est **pas** implémenté. L'assistant utilise l'API Claude via HTTP.

---

## Installation rapide

```bash
git clone https://github.com/Silexperience210/velohnav.git
cd velohnav
npm install
npm run dev        # PWA sur http://localhost:5173
npm test           # 43 tests unitaires
```

### Build APK debug

```bash
npm run build
npx cap sync android
cd android && ./gradlew assembleDebug
# → android/app/build/outputs/apk/debug/app-debug.apk
```

### Build APK release signé

1. Générer le keystore une seule fois :
   ```bash
   bash scripts/generate-keystore.sh
   ```
2. Ajouter les 4 secrets dans GitHub → Settings → Secrets :
   - `KEYSTORE_BASE64` — `base64 -w 0 velohnav-release.jks`
   - `KEY_ALIAS` — `velohnav`
   - `KEY_PASSWORD` — mot de passe clé
   - `STORE_PASSWORD` — mot de passe keystore
3. Le CI génère l'APK signé à chaque push sur `main`. Sur tag `v*`, l'APK est attaché à la GitHub Release.

---

## API JCDecaux

```
GET https://api.jcdecaux.com/vls/v3/stations?contract=Luxembourg&apiKey=VOTRE_CLE
```

Inscription gratuite : [developer.jcdecaux.com](https://developer.jcdecaux.com)

Champs utilisés : `totalStands.availabilities.bikes` · `mechanicalBikes` · `electricalBikes` · `stands` · `position` · `status` · `name` · `number`

> Les requêtes CORS depuis un navigateur sont bloquées par JCDecaux. Sur Android (Capacitor), les requêtes partent du process natif — aucun problème.
> En PWA, un proxy CORS (`corsproxy.io`) est utilisé en fallback automatique.

---

## Sats Rewards ⚡

Entre ta **Lightning Address** dans OPT (ex: `ton-wallet@getalby.com`).
Après chaque trajet validé → sats calculés en fonction de la durée, envoyés via **LNURL-pay**.
Zéro serveur intermédiaire — self-custodial.

Compatible : Alby · Wallet of Satoshi · Phoenix · Blink · Zeus

---

## Décentralisation Nostr

Les signalements d'obstacles sont publiés sur le réseau Nostr — protocole décentralisé, pas de backend VelohNav.

| | |
|---|---|
| Kind | `30078` (NIP-33 replaceable parameterized) |
| Tags | `t=velohnav-obstacle`, `g=lat,lng`, `expiration` (NIP-40) |
| Signature | Schnorr BIP-340 via `@noble/secp256k1` |
| Clé | Éphémère 32-byte session-only, jamais persistée |
| Relays par défaut | `wss://relay.damus.io`, `wss://nos.lol`, `wss://relay.nostr.band` |
| Décay | 24h auto-élagage côté client + tag `expiration` |

L'identité du reporter est anonyme et change à chaque session. Aucune corrélation possible entre 2 sessions du même utilisateur.

---

## Structure

```
velohnav/
├── src/
│   ├── App.jsx                  # Root + NavBar + état global (météo, transit lifted)
│   ├── components/
│   │   ├── ARScreen.jsx         # Vue AR — caméra, pins, navigation, ghost, obstacles
│   │   ├── MapScreen.jsx        # Carte vectorielle SVG Luxembourg
│   │   ├── AIScreen.jsx         # Assistant Claude
│   │   ├── SettingsScreen.jsx   # Paramètres / clés API + toggle audio 3D
│   │   ├── WeatherBanner.jsx    # Bandeau météo + recommandation TC
│   │   └── ar/
│   │       ├── ARPin.jsx              # Pin station Vel'OH normal
│   │       ├── CheckeredFlag.jsx      # Drapeau damier animé
│   │       ├── CityBG.jsx             # Background SVG Luxembourg
│   │       ├── GhostPin.jsx           # 👻 Pin AR du fantôme du meilleur temps
│   │       ├── NavOverlay.jsx         # Corridor de navigation
│   │       ├── ObstaclesAR.jsx        # ⚠️ Pins obstacles + menu signalement
│   │       ├── RouteOverlay.jsx       # Tracé OSRM canvas multi-couches
│   │       └── projection.js          # Projection GPS → écran AR (FOV 50°)
│   ├── hooks/
│   │   ├── useCompass.js              # DeviceOrientationEvent (absolu + fallback)
│   │   ├── useGhostTrail.js           # 👻 Recording + replay best run (IndexedDB)
│   │   ├── useMultimodalSwitch.js     # 🌧️ Bascule vélo→bus si pluie
│   │   ├── useObstacles.js            # 🚧 Pool Nostr + signalements signés Schnorr
│   │   ├── usePredictiveRouting.js    # ⚠️ Re-route auto si station saturée
│   │   ├── useRoute.js                # OSRM + Google Directions + cache 24h
│   │   ├── useSpatialAudio.js         # 🎧 TTS HRTF 3D (Google Translate + Web Audio)
│   │   ├── useStationsCache.js        # IndexedDB v2 (stations + ghosts)
│   │   ├── useTransit.js              # HAFAS ATP — bus RGTR (lifted dans App)
│   │   └── useWeather.js              # OpenMeteo + windImpact() + getWeatherAdvice()
│   ├── utils.js                       # GPS, LNURL, JCDecaux, notifications
│   ├── utils/
│   │   ├── geo.js                     # haversine, getBearing, fDist, fWalk
│   │   └── theme.js                   # Palette C, bCol, bTag
│   ├── constants.js                   # FOV, arrêts TC, coordonnées référence
│   ├── i18n.js                        # Hook useI18n + t()
│   └── locales/fr.js + en.js          # 91 clés de traduction
├── android/
│   └── app/src/main/java/com/silexperience/velohnav/ar/
│       ├── ArNavigationActivity.kt    # Activity Compose — AR nav
│       ├── ArNavigationPlugin.kt      # Bridge Capacitor
│       ├── ArNavigationViewModel.kt   # État nav + timeout VPS + fallback GPS
│       ├── GeospatialManager.kt       # VPS accuracy + anchors
│       ├── RouteManager.kt            # OSRM + Google fallback
│       └── ui/NavigationHud.kt        # HUD cyberpunk Compose + countdown VPS
├── scripts/
│   └── generate-keystore.sh           # Génération keystore + instructions secrets
├── capacitor.config.json              # Config Capacitor + CapacitorHttp enabled
├── vite.config.js
└── package.json
```

---

## Architecture des hooks AR

```
┌─────────────────────────────────────────────────────────────┐
│                       ARScreen.jsx                          │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────────┐   │
│  │  useCompass  │  │   useRoute   │  │ useStationsCache│   │
│  └──────────────┘  └──────────────┘  └─────────────────┘   │
│                                                              │
│  ┌──────────────────┐  ┌────────────────────────┐          │
│  │ useGhostTrail    │  │  usePredictiveRouting  │          │
│  │ (IndexedDB)      │  │  (live station watch)  │          │
│  └──────────────────┘  └────────────────────────┘          │
│                                                              │
│  ┌──────────────────┐  ┌────────────────────────┐          │
│  │ useObstacles     │  │  useMultimodalSwitch   │          │
│  │ (Nostr Schnorr)  │  │  (météo + transit)     │          │
│  └──────────────────┘  └────────────────────────┘          │
│                                                              │
│  ┌──────────────────────────────────────────────┐          │
│  │ useSpatialAudio (HRTF 3D + Google TTS)       │          │
│  └──────────────────────────────────────────────┘          │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
              ┌───────────────────────────────┐
              │  ARCore Geospatial (Android)  │
              │  ArNavigationActivity.kt      │
              │  + timeout 25s VPS            │
              │  + fallback GPS dégradé       │
              └───────────────────────────────┘
```

---

## Limitations connues

- **i18n** : 66/91 clés branchées — les 25 restantes (strings dynamiques avec interpolation) sont en français fixe
- **resolveAnchorOnRooftopAsync** (ARCore 1.40+) : API async non migrée — utilise encore `resolveAnchorOnTerrain` avec `@Suppress("DEPRECATION")` ; migration prévue
- **LNURL CORS** : non testé sur tous les providers Lightning — dépend des headers CORS du serveur de la wallet
- **Clés en localStorage** : clé Claude et JCDecaux stockées en clair dans le navigateur
- **TTS Google Translate** : 200 caractères max par requête (largement OK pour annonces de nav). En cas de panne du endpoint, fallback automatique sur SpeechSynthesis natif.
- **Audio HRTF en browser desktop** : CapacitorHttp est natif Android/iOS. En PWA pure, fetch direct vers Google Translate sera bloqué par CORS — fallback SpeechSynthesis automatique.

---

## Licence

MIT — Données JCDecaux : [Open Licence](https://developer.jcdecaux.com/files/Open-Licence-en.pdf)
Réseau Nostr — protocole ouvert, aucun lock-in.
