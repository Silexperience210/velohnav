# Changelog

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
