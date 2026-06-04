# Changelog

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
