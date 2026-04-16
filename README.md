# ⬡ VelohNav

**Navigation AR pour le réseau Vel'OH! Luxembourg — PWA + APK Android natif**

[![CI](https://github.com/Silexperience210/velohnav/actions/workflows/apk.yml/badge.svg)](https://github.com/Silexperience210/velohnav/actions/workflows/apk.yml)
![React](https://img.shields.io/badge/React-18-61DAFB?logo=react)
![Capacitor](https://img.shields.io/badge/Capacitor-8-119EFF?logo=capacitor)
![ARCore](https://img.shields.io/badge/ARCore-1.46-4285F4?logo=google)
![License](https://img.shields.io/badge/license-MIT-green)

---

## Ce que fait l'app

VelohNav connecte l'API temps réel JCDecaux à une interface AR pour trouver, naviguer et déposer un vélo Vel'OH! sans quitter l'écran de la caméra. L'assistant IA Claude répond aux questions sur les stations en contexte réel. Les trajets peuvent être récompensés en sats Bitcoin via Lightning.

---

## Onglets

### ⬡ AR — Réalité augmentée

- **Boussole réelle** — `DeviceOrientationEvent` avec mode `absolute` (boussole magnétique) + fallback relatif sur Android
- **Pins AR projetés** — calcul bearing + FOV 68° depuis GPS, projection en coordonnées écran
- **Clustering** — stations regroupées sous 500m avec comptage total vélos/docks
- **Drapeaux damier animés** sur chaque pin (svg, animation CSS)
- **Navigation AR web** — overlay corridor canvas tracé depuis OSRM, flèche directionnelle `NavOverlay` avec bearing relatif
- **Navigation ARCore natif (Android)** — démarre `ArNavigationActivity` via plugin Capacitor ; itinéraire OSRM + fallback Google Directions ; flèches 3D SceneView ancrées par VPS Geospatial ; HUD Compose cyberpunk avec ETA, badge précision VPS, instructions par étape
- **Overlay calibration boussole** — guide figure-8 animé si signal manquant
- **Retry automatique** — 3 tentatives avec backoff exponentiel (0s, 2s, 4s)
- **Détection arrivée** — 15m du waypoint courant, avancement automatique des étapes

### ◈ MAP — Carte vectorielle

- **Carte SVG Luxembourg-Ville** — rivières Alzette et Pétrusse, routes principales, quartiers
- **Pan/pinch-to-zoom** natif — gestes multi-touch, limites de zoom 0.5×–4×
- **Filtres** — Tout · Vélos dispo · Docks libres · Électriques
- **Recherche textuelle** en temps réel
- **Labels stations** visibles à partir de zoom ×3
- **Détail station** au tap — nom, vélos méca/élec, docks, distance à pied, cap cardinal
- **Boutons navigation** — "À PIED" et "EN VÉLO" → ouvre Google Maps avec itinéraire
- **Bouton TRAJET** — démarre un trajet VelohNav (timer + sats reward à l'arrivée)
- **Recommandation météo multimodale** — bandeau WeatherBanner : bike / mixed / transit selon pluie, vent, code WMO
- **Arrêt TC le plus proche** — 22 arrêts tram/bus Luxembourg-Ville hardcodés

### ◎ AI — Assistant IA

- **Modèle** : `claude-haiku-4-5-20251001` — 800 tokens max
- **Contexte injecté** : stations triées par distance, vélos dispo, conditions météo, mode de recommandation
- **Historique** de conversation dans la session
- **Clé API personnelle** — à configurer dans OPT (reste en `localStorage`)

### ≡ OPT — Paramètres

| Réglage | Description |
|---------|-------------|
| Clé JCDecaux | API Vel'OH! temps réel |
| Clé Claude | Assistant IA (console.anthropic.com) |
| Clé Google Maps | Optionnel — fallback si OSRM indisponible |
| Lightning Address | `user@provider.com` pour Sats Rewards |
| Sats Rewards | Toggle on/off — paiement LNURL-pay self-custodial |

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
| Boussole | `DeviceOrientationEvent` absolu + fallback relatif |
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
| Build | AGP 8.9.1 · Java 21 · compileSdk 36 · minSdk 24 |
| CI | GitHub Actions — debug APK automatique, release si secrets configurés |

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
3. Le CI génère l'APK signé à chaque push sur `main`.

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

## Structure

```
velohnav/
├── src/
│   ├── App.jsx                  # Root + NavBar + état global
│   ├── components/
│   │   ├── ARScreen.jsx         # Vue AR — caméra, pins, navigation
│   │   ├── MapScreen.jsx        # Carte vectorielle SVG Luxembourg
│   │   ├── AIScreen.jsx         # Assistant Claude
│   │   ├── SettingsScreen.jsx   # Paramètres / clés API
│   │   └── WeatherBanner.jsx    # Bandeau météo + recommandation TC
│   ├── hooks/
│   │   ├── useCompass.js        # DeviceOrientationEvent (absolu + fallback)
│   │   ├── useRoute.js          # OSRM + Google Directions + cache 24h
│   │   └── useWeather.js        # OpenMeteo + getWeatherAdvice()
│   ├── utils.js                 # GPS, LNURL, JCDecaux, notifications
│   ├── utils/
│   │   ├── geo.js               # haversine, getBearing, fDist, fWalk
│   │   └── theme.js             # Palette C, bCol, bTag
│   ├── constants.js             # Arrêts TC, coordonnées référence
│   ├── i18n.js                  # Hook useI18n + t()
│   └── locales/fr.js + en.js    # 91 clés de traduction
├── android/
│   └── app/src/main/java/com/silexperience/velohnav/ar/
│       ├── ArNavigationActivity.kt   # Activity Compose — AR nav
│       ├── ArNavigationPlugin.kt     # Bridge Capacitor
│       ├── ArNavigationViewModel.kt  # État nav + retry logic
│       ├── GeospatialManager.kt      # VPS accuracy + anchors
│       ├── RouteManager.kt           # OSRM + Google fallback
│       └── ui/NavigationHud.kt       # HUD cyberpunk Compose
├── scripts/
│   └── generate-keystore.sh     # Génération keystore + instructions secrets
├── vite.config.js
└── package.json
```

---

## Limitations connues

- **i18n** : 66/91 clés branchées — les 25 restantes (strings dynamiques avec interpolation) sont en français fixe
- **resolveAnchorOnRooftopAsync** (ARCore 1.40+) : API async non migrée — utilise encore `resolveAnchorOnTerrain` avec `@Suppress("DEPRECATION")` ; migration prévue
- **LNURL CORS** : non testé sur tous les providers Lightning — dépend des headers CORS du serveur de la wallet
- **Clés en localStorage** : clé Claude et JCDecaux stockées en clair dans le navigateur

---

## Licence

MIT — Données JCDecaux : [Open Licence](https://developer.jcdecaux.com/files/Open-Licence-en.pdf)
