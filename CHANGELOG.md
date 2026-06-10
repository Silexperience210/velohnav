# Changelog

## v3.3.0 — 2026-06-10

### 🐛 Corrections
- **`nearestStop` : distances est-ouest surestimées de ~54%** — la formule équirectangulaire n'appliquait pas `cos(lat)` au delta de longitude (à 49.6°N, 1° de lng ≈ 72 km, pas 111). Le multimodal switch pouvait choisir un mauvais arrêt pivot.
- **Obstacles Nostr : bypass du décay 24h** — un event avec `created_at` dans le futur survivait indéfiniment au filtre d'âge. Tout `created_at` > now+5min est désormais rejeté (`nostr/core.verifyEvent`).
- README : alpha du filtre boussole documenté à 0.25, le code utilise 0.08.

### 🧭 Cap fusionné GPS + magnétomètre (`useFusedHeading`)
- Fusion circulaire du cap magnétique et de la course GPS, pondérée par la vitesse (0% à l'arrêt → 85% à 16 km/h, EMA 0.35 sur la course, TTL 5s).
- Élimine la dérive magnétique urbaine (±15-25°) pour les pins, le tracé AR et l'audio spatial.

### ⛰ ETA dénivelé + reco vélo électrique
- `brouterToRoute` extrait le profil altimétrique (coordonnées 3D BRouter) → `totalAscent`/`totalDescent` via accumulateur à hystérésis ±2m (anti-bruit SRTM).
- `climbEtaFactor` : 1m de D+ ≈ 9m de plat (vélo) / 8m (marche), clamp 1.6×/1.5× — appliqué aux temps OSRM/Google uniquement (BRouter intègre déjà la pente).
- Badge HUD `⛰ D+ Xm` + `⚡ élec conseillé` dès 40m de D+.
- Champ `provider` ajouté à toutes les routes (brouter/osrm/google).

### 🌍 Ghost Trails mondiaux (Nostr)
- Publication du record local par segment (kind 30078, d-tag `velohnav-ghost-{o}__{d}__{mode}`, PoW 15 bits, clé éphémère).
- Au démarrage de la nav : fetch parallèle local + mondial, on court contre le plus rapide. Badge `🌍 REC MONDIAL`.
- Anti-cheat `isPlausibleRun` : vitesses moy/max par mode, timestamps croissants depuis t=0, bbox Luxembourg, cohérence totalTime, distance min 100m, durée min 30s. Appliqué en réception ET avant publication.

### 🔮 Prédiction de disponibilité (`useAvailability`)
- Historique par (station, jour, quart d'heure) en IndexedDB (store `avail`, DB v4), alimenté par le refresh 60s (throttle 5 min), moyenne mobile n≤20.
- Predictive Routing v2 : alerte anticipée "risque de saturation/vide à l'arrivée (~Xmin)" basée sur l'ETA de la route — garde-fous : ≥8 échantillons, stock actuel ≤2, dispo prédite <0.8.

### 🛡 Anti-spam Nostr (NIP-13)
- Nouveau socle `src/nostr/core.js` (hex, build/verify NIP-01, mining PoW async avec yields UI, validation cible déclarée anti-recyclage).
- Obstacles : PoW 18 bits exigé en réception, miné à la publication sans bloquer l'UI.

### ✅ Tests
- 46 nouveaux tests (101 au total) : PoW, forge `created_at` futur, anti-cheat ghosts, math circulaire de fusion, hystérésis dénivelé, clamps ETA, fix cos(lat), buckets temporels.

---

## v3.2.3 — 2026-06-05

Routage vélo **réel** via BRouter — corrige le point #3 de l'audit.

### ✨ Routage

#### BRouter — vrais profils vélo / piéton
- Le serveur OSRM public (`router.project-osrm.org`) **ignore le profil** et
  renvoie toujours un routage voiture : vélo = piéton = voiture (même tracé,
  même ETA). Vérifié.
- Nouveau routeur primaire **BRouter** (`brouter.de`, gratuit, sans clé, CORS *) :
  - `cycling` → profil `trekking` · `walking` → `hiking-beta` · `driving` → `car-fast`
  - Tracé GeoJSON réel + turn-by-turn via `voicehints` (`timode=2`), angle de
    virage → modifier (`slight left`, `sharp right`, `uturn`…).
- Chaîne de fallback : **BRouter → OSRM (dépannage voiture) → Google Directions**
  (si clé). Cache IndexedDB préfixé par fournisseur (pas de mélange vélo/voiture).
- Côté natif Android : `RouteManager.fetchBRouter` + parsing voicehints →
  `NavigationStep` (placement des flèches AR aux points de virage réels).
- `brouter.de` ajouté au `network_security_config`.
- 7 tests purs ajoutés (`useRoute.test.js`) : `angleToModifier` + `brouterToRoute`.

### 📦 Versions
- `package.json` : 3.2.2 → 3.2.3
- `android/app/build.gradle` : versionCode 35 → 36, versionName 3.2.2 → 3.2.3

## v3.2.2 — 2026-06-05

Release correctifs de sécurité (audit). Deux failles trouvées et corrigées.

### 🔒 Sécurité / correctifs

#### Vérification Schnorr des obstacles Nostr réparée (régression v3.2.x)
- `schnorr.verify` de `@noble/secp256k1` v3 est **synchrone** et exige un `sha256`
  synchrone configuré globalement. Sans lui, `verifyEvent` renvoyait `false` pour
  **tout** event — même valide — ce qui rejetait silencieusement **tous** les
  obstacles crowd-sourced reçus (feature morte).
- Ajout de la dépendance `@noble/hashes` et configuration `hashes.sha256` à
  l'import de `useObstacles.js`.
- 4 tests de non-régression ajoutés (`useObstacles.test.js`) : event valide accepté,
  contenu falsifié / id incohérent / signature d'une autre clé rejetés.

#### La clé API JCDecaux ne fuit plus via un proxy CORS tiers
- `fetchJCDecaux` ne route plus l'URL (qui contient la clé API) vers `corsproxy.io`.
  Sur Android (Capacitor) l'appel direct ignore CORS ; en PWA web pur, on retombe
  sur le cache IndexedDB / les données de démonstration.

### 📦 Versions
- `package.json` : 3.2.0 → 3.2.2
- `android/app/build.gradle` : versionCode 34 → 35, versionName 3.2.0 → 3.2.2

> Note : la sélection du mode (vélo/marche/voiture) reste sans effet sur le tracé
> car le serveur OSRM public ignore le profil (routage voiture). Correctif backend
> à planifier (OSRM self-hosted / BRouter / GraphHopper).

## v3.2.0 — 2026-06-04

Release mineure : mode nuit AR, lazy loading ARScreen, cache OSRM IndexedDB, et correctifs build.

### ✨ Nouveautés

#### 🌙 Mode nuit AR
- Détection automatique 20h00–06h00 (override possible via `localStorage`)
- Tracé canvas en néon : cyan `#00F0FF` (vélo) / orange `#FF6B00` (marche)
- Glow x1.5 sur la route, opacité augmentée, vignettage renforcé pour le contraste
- Composants impactés : `ARScreen.jsx`, `RouteOverlay.jsx`, hook `useDarkMode.js`

#### ⚡ Lazy load ARScreen
- `React.lazy()` + `Suspense` : ARScreen n'est chargé que quand l'onglet AR est ouvert
- **Bundle initial** : 305 kB → 227 kB (-25%)
- Chunk AR séparé : 80 kB (gzip 25 kB)

#### 💾 Cache OSRM IndexedDB
- Remplace le `localStorage` pour les itinéraires calculés
- Store dédié `"routes"` dans la même IndexedDB `velohnav`
- Même TTL 30 min, mais capacité bien supérieure + pas de pollution `localStorage`
- DB version bumpée à 3 (compatibilité `stations`, `meta`, `ghosts`)

### 🔧 Correctifs build
- `useMultimodalSwitch.js` : fermeture correcte du `useCallback`
- `ArNavigationActivity.kt` : remplacement `isDestroyed` par `lifecycle.currentState` (compatibilité AndroidX)

---

## v3.1.2 — 2026-06-04

Patch release : correctifs navigation AR (intent predictive, stale closures, cleanup Nostr, atomicité Android) + sécurité config.

### 🐛 Bugs corrigés

#### Predictive routing toujours en mode "pickup"
**Cause** : `trip?.active` dans `ARScreen.jsx` alors que l'objet `trip` n'a pas de champ `active`. L'heuristique d'intent retournait donc toujours `"pickup"`, même quand l'utilisateur avait déjà un vélo et cherchait un dock (`"dropoff"`).

**Fix** : `trip?.active` remplacé par `!!trip`.

#### Stale closure sur la navigation auto Map → AR
**Cause** : le `useEffect` d'auto-démarrage de la nav avait un tableau de dépendances vide `[]`. Il capturait `stations` et `startNav` du premier render. Si les stations mettaient du temps à charger, la nav auto échouait silencieusement.

**Fix** : ajout de `[stations, startNav, setSel]` dans les dépendances.

#### Recalcul parasite de `originStation` à chaque refresh
**Cause** : `originStation` dépendait du tableau `stations` (nouvelle référence à chaque `loadData` toutes les 60s). Le hook recalculait l'origine du Ghost Trail en permanence.

**Fix** : `stations` sorti des deps via `useRef`.

#### Sauvegarde Ghost Trail avec mauvaise station
**Cause** : `navStation` était utilisé dans le cleanup du `useEffect` d'enregistrement sans être dans les dépendances.

**Fix** : `navStationRef` ajouté pour stabiliser la référence dans le cleanup.

#### Re-évaluation spam de `useMultimodalSwitch`
**Cause** : `evaluateSwitch` était recréée à chaque render, déclenchant les `useEffect` en boucle.

**Fix** : `evaluateSwitch` wrappé dans `useCallback`.

#### Obstacles Nostr falsifiables
**Cause** : aucune vérification de signature Schnorr BIP-340 sur les events reçus. N'importe qui pouvait injecter de faux obstacles.

**Fix** : `verifyEvent()` + `schnorr.verify()` ajoutés avant le parsing.

#### Fuite de connexions WebSocket Nostr
**Cause** : le pool WebSocket singleton n'était jamais fermé.

**Fix** : `beforeunload` listener qui appelle `pool.close()`.

#### Incrément non atomique du watchdog ARCore
**Cause** : `@Volatile private var sessionUpdateCount` avec `++` n'est pas atomique cross-thread.

**Fix** : `AtomicInteger` avec `incrementAndGet()`.

#### Crash potentiel du watchdog si Activity détruite
**Cause** : le `Toast` du watchdog s'affichait sans vérifier `isFinishing`/`isDestroyed`.

**Fix** : check `isFinishing || isDestroyed` avant toute UI.

#### Divergence profil OSRM natif/web
**Cause** : natif utilisait `"bike"`, web `"cycling"`. OSRM standard attend `"bicycle"`.

**Fix** : alignement sur `"bicycle"`.

### 🔒 Sécurité
- Ajout d'une `Content-Security-Policy` dans `index.html`
- `vite.config.js` : `sourcemap: true` pour rendre Sentry utilisable
- CI : `set +x` pour masquer l'écriture des secrets dans les logs

### 🧪 Qualité
- `vite.config.js` : environnement de test passé de `node` à `jsdom`

---

## v3.1.1 — 2026-04-29

Patch release : 4 bugs critiques sur la navigation AR.

### 🐛 Bugs corrigés

#### Tracé qui part à gauche / droite alors que la station est en face
**Cause** : `projection.js` clampait à ±75° du FOV. Pour un point physiquement *derrière* la caméra (cas du DEMI-TOUR où la destination est dans le dos de l'utilisateur), la projection plaquait le point sur les bords de l'écran et donnait l'illusion d'une route qui virait. Visuellement désastreux : l'utilisateur voit un tracé qui part en oblique alors que la rue est droite devant lui.

**Fix** :
- `projection.js` : aucun point à `relBear > 90°` n'est projeté (retourne `null`). Clamp resserré à `±PROJ_FOV_H` (50°) pour que `x` reste **strictement dans `[0, W]`**.
- Nouvelles helpers : `detectWrongWay()` (détecte si la majorité de la polyline est derrière) et `distanceToRoute()` (distance min point → polyline).
- `RouteOverlay.jsx` : si `detectWrongWay` retourne `true`, on n'affiche plus le tracé canvas et un overlay plein écran **« MAUVAIS SENS — Fais demi-tour »** prend le relais avec une grande flèche animée.

#### Caméra qui freeze après quelques minutes de navigation
**Cause** : aucun watchdog sur le `MediaStream`. Si Android tue le stream (autre app prend la caméra, lifecycle pause, OOM), aucun mécanisme de relance.

**Fix** dans `ARScreen.jsx` :
- Listener `onended` sur chaque `VideoTrack` → bascule en état `lost` puis relance auto.
- Listener `visibilitychange` + `focus` → relance si stream cassé au retour foreground.
- Ping périodique 5s qui vérifie `track.readyState` et `stream.active`.
- Nouvel état UI `lost` avec bouton manuel « CAMÉRA ARRÊTÉE — appuie pour relancer ».
- Garde `camRestartingRef` pour éviter les double-mount lors des cleanups.

#### Pas de recalcul d'itinéraire quand on dévie
**Cause** : `useRoute` re-fetchait aveuglément à chaque changement de GPS rounded à 4 décimales (~11m), sans détection de déviation. Le cache 24h pouvait servir des routes obsolètes.

**Fix** dans `useRoute.js` :
- Détection off-route : si `distanceToRoute(gps, polyline) > 35m` pendant `> 4s` → re-route forcé avec `skipCache: true`.
- Cooldown de 8s entre deux re-routes pour éviter le spam.
- Refetch « calme » sur la route uniquement quand on a bougé de plus de 60m depuis le dernier calcul (au lieu de tous les 11m).
- TTL du cache route réduit de 24h à 30 min.
- Hook expose maintenant `offRoute`, `recalculating`, `manualRecalc()`.
- `RouteOverlay` affiche un bandeau **« HORS ITINÉRAIRE »** + bouton ↻ RECALCULER manuel.

#### Message « Clé API ARCore non disponible » récurrent
**Cause** : confusion entre la clé Maps Platform et la clé ARCore Geospatial. Le manifest utilise `com.google.android.geo.API_KEY` qui doit avoir l'**API ARCore** activée dans Google Cloud Console (en plus du Maps SDK), avec billing actif et restrictions Android (package + SHA-1).

**Fix** côté Android natif :
- `ArNavigationActivity` : log diagnostic au démarrage (`API key diag: native=Xc · intent=Yc`) — jamais la clé en clair, juste sa longueur, pour permettre de diagnostiquer si la clé est injectée par Gradle ou par l'intent web.
- `GeospatialManager` : message `ERROR_NOT_AUTHORIZED` enrichi avec les étapes concrètes de configuration (Cloud Console → API ARCore + restriction package + SHA-1).
- Le fallback GPS automatique sur erreur permanente était déjà implémenté en v3.1.0 ; le diagnostic est maintenant clair.

### ✨ i18n
Nouvelles clés (fr + en) : `nav.wrong_way`, `nav.wrong_way_desc`, `nav.off_route`, `nav.off_route_desc`, `nav.recalculating`, `nav.recalc_btn`, `nav.cam_lost`.

### 🧪 Tests
- 12 nouveaux tests unitaires pour `projection.js` (projectPoint, detectWrongWay, distanceToRoute).
- **55/55 tests passent** (avant : 43/43).

### 📦 Versions
- `package.json` : 3.1.0 → 3.1.1
- `android/app/build.gradle` : versionCode 31 → 32, versionName 3.1.0 → 3.1.1

---

## v3.1.0 — 2026-04-27

Release majeure : Wind-aware ETA + Predictive routing + Ghost Trail + Nostr obstacles + Multimodal switch + HRTF spatial audio.

Voir l'historique git pour le détail.
