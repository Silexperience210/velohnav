# Navigation AR native — AR ancrée au sol (et localisation Google en option)

## Le mode principal : AR ancrée au sol, sans Google

La navigation AR native (`ArNavigationActivity`) fonctionne **sans clé, sans compte
et hors ligne** (hors calcul de l'itinéraire) : elle n'utilise que le suivi local
d'ARCore (caméra + centrale inertielle), gratuit.

1. **Ancrage** : l'utilisateur vise le sol devant lui ; un essai d'impact
   (*hit-test*) sur un plan horizontal détecté fixe la hauteur du sol et y pose une
   ancre ARCore. Le tracé est rattaché à cette ancre et **part des pieds** de
   l'utilisateur : ses pieds sont associés au point de l'itinéraire le plus proche de
   la position GPS (jusqu'à 25 m), si bien que l'erreur GPS ne décale pas le départ.
   Sans plan détecté au bout de 6 s, le sol est estimé à 1,35 m sous l'objectif
   (badge « AR SOL » orange au lieu de vert ; « Recaler » refait l'ancrage).
2. **Orientation** : un seul angle relie le repère ARCore (orientation arbitraire au
   démarrage) au nord. Il est mesuré **à l'ancrage**, en moyennant sur 1,5 s l'écart
   entre le cap boussole de l'axe de la caméra (capteur de rotation + déclinaison
   magnétique) et la direction de visée donnée par ARCore au même instant. Il n'est
   **jamais** recalculé image par image à partir du cap brut : c'était la source du
   tremblement et du décalage latéral de la vue boussole.
3. **Maintien** : ensuite, c'est le suivi d'ARCore qui garde le tracé en place.
   Deux corrections seulement, ponctuelles :
   - **trajectoire marchée** : après une quinzaine de mètres, la trajectoire ARCore
     est comparée à la trajectoire GPS (moindres carrés, rotation pure) ; si l'angle
     diffère nettement (≥ 3°), il est corrigé ;
   - **ré-ancrage en continuité** tous les 60 m (dérive du suivi), sans saut : la
     position est déduite du suivi ARCore, pas du GPS.
4. **Rendu** : des chevrons tous les 2,5 m (de 4 m derrière à 60 m devant) et une
   flèche à chaque manœuvre, posés au sol et orientés selon la route. La projection
   à l'écran est celle d'ARCore : pose réelle de la caméra et intrinsèques réelles
   (champ de vision) — plus d'estimation.

Le guidage **GPS seul** n'est utilisé que si ARCore ne fournit aucune image, ne
parvient pas à suivre la scène, ou si l'appareil n'a pas de boussole, ou sur
demande (« Passer en mode GPS »).

La géométrie est dans `GroundAnchor.kt` (Kotlin pur), testée sur JVM :
`./gradlew :app:testDebugUnitTest` (`GroundAnchorTest` : point connu, cap connu,
position connue, départ aux pieds, stabilité, correction par la trajectoire).

## En option : localisation Google (ARCore Geospatial / VPS)

Si une clé est présente, ARCore Geospatial est activé en plus : quand il atteint
±5 m et ±10° de cap, il **recale** le même tracé au sol (cap et position absolus),
puis porte la progression (badge « VPS ±x m »). C'est un **bonus** : sans clé il
n'est même pas demandé, et une clé refusée n'interrompt rien (une ligne discrète
l'indique, pour l'administrateur). Google n'accepte la requête que si **trois
conditions** sont réunies ; sinon ARCore répond `ERROR_NOT_AUTHORIZED`.

| Condition | Où | Symptôme si absente |
|---|---|---|
| 1. La clé est **dans l'APK** | build (`MAPS_API_KEY`) | encart « compilée sans clé Google » ; logcat `API key diag: native=0c` |
| 2. L'API **ARCore** est activée sur le projet de la clé | Google Cloud Console | encart « Google refuse la clé » |
| 3. La clé autorise **ce paquet + ce certificat** (SHA-1) | Google Cloud Console | encart « Google refuse la clé » |

## 1. Mettre la clé dans l'APK

`android/app/build.gradle` lit `MAPS_API_KEY`, dans cet ordre : propriété Gradle
(`-PMAPS_API_KEY=…` ou `gradle.properties`), puis `android/local.properties`,
puis la variable d'environnement `MAPS_API_KEY`.

- **CI** (`.github/workflows/apk.yml`) : le secret `MAPS_API_KEY` est écrit dans
  `android/local.properties`. Jusqu'à ce correctif, `build.gradle` ne lisait PAS ce
  fichier : **tous les APK de la CI partaient sans clé**.
- **Poste local** : ajouter `MAPS_API_KEY=AIza…` dans `android/local.properties`
  (fichier non versionné).

Le build affiche `MAPS_API_KEY absente : ARCore Geospatial sera refusé` si la clé
manque.

## 2. Activer l'API ARCore

Google Cloud Console → projet de la clé → **API et services → Bibliothèque** →
rechercher **« ARCore API »** → **Activer**.

## 3. Restreindre la clé au paquet + empreinte SHA-1

Google Cloud Console → **API et services → Identifiants** → la clé :

- **Restrictions relatives aux applications** : *Applications Android* →
  **Ajouter** : nom de paquet `com.silexperience.velohnav` + empreinte **SHA-1** du
  certificat qui signe l'APK installé. Une ligne par certificat (debug ET release).
- **Restrictions relatives aux API** : cocher **ARCore API**.

Les modifications peuvent mettre **jusqu'à 5 minutes** à s'appliquer.

### Quelle empreinte SHA-1 ?

Celle du certificat qui a signé **l'APK effectivement installé** :

```bash
# Depuis l'APK (Java requis)
keytool -printcert -jarfile app-release.apk | grep SHA1
# ou, avec les build-tools Android
apksigner verify --print-certs app-release.apk | grep SHA-1
# Depuis le keystore de release
keytool -list -v -keystore velohnav-release.jks -alias <alias> | grep SHA1
```

La CI imprime désormais l'empreinte de chaque APK produit (étape « Empreintes SHA-1 »).

**Piège de l'APK debug de la CI** : sans le secret `DEBUG_KEYSTORE_BASE64`, il est
signé par un keystore de debug **généré à neuf à chaque exécution** — son SHA-1
change à chaque build et ne peut donc pas être autorisé durablement. Deux solutions :

- installer l'APK **release** (keystore stable, secret `KEYSTORE_BASE64`) ;
- ou fournir un keystore de debug fixe : `base64 -w0 ~/.android/debug.keystore`
  → secret `DEBUG_KEYSTORE_BASE64` (alias `androiddebugkey`, mots de passe
  `android`, convention Android), puis autoriser son SHA-1.

### Clé partagée avec Google Directions

`RouteManager` utilise aussi la clé (repli après BRouter et OSRM) pour l'API Web
Directions. Une clé restreinte « Applications Android » est refusée par les API
Web (`REQUEST_DENIED`) tant que les en-têtes `X-Android-Package` /
`X-Android-Cert` ne sont pas envoyés, ce que le code ne fait pas. Le guidage n'en
dépend pas (BRouter d'abord), mais si le repli Google est voulu, saisir dans
Réglages une **seconde clé** limitée à « Directions API ».

## Vérifier

```bash
adb logcat -s ArNavActivity ArNavViewModel GeospatialManager
```

- `API key diag: native=39c` → la clé est dans l'APK (0c = absente) ;
- `Earth state=ENABLED tracking=true` puis `VPS OK (±… m)` → autorisation acceptée ;
- `Geospatial indisponible (ERROR_NOT_AUTHORIZED) — AR au sol seule` → revoir les points 2 et 3 ;
- `Ancré au sol (INITIAL) lacet=…° sol=détecté` → l'AR au sol est posée ;
- `Lacet corrigé par la trajectoire : … → …` → correction d'orientation en marchant.

Le VPS a aussi besoin d'**extérieur** et de **bâtiments couverts par Street View** :
en intérieur ou en zone non couverte, il ne converge pas — et l'AR au sol continue
seule, sans attente ni compte à rebours.

## Alternative : authentification sans clé

Google recommande sur Android l'authentification « keyless » (client OAuth de
type Android, même paquet + SHA-1, dépendance `play-services-auth`, sans
meta-data `com.google.android.geo.API_KEY`). Non implémentée ici : elle demande
les mêmes empreintes SHA-1, et la clé reste nécessaire pour Directions.

## Évolution possible (non implémentée) : marqueurs ancrés aux stations

Pour un ancrage **exact**, toujours hors ligne, sans compte ni facture : une image
de référence (QR code ou marqueur visuel) posée à chaque station Vel'OH!, dont la
position et l'orientation sont relevées une fois.

- **Principe** : ARCore *Augmented Images* reconnaît l'image dans le flux caméra et
  en donne la pose 6 DoF au centimètre près. Connaissant la position géographique et
  l'orientation du marqueur, on obtient directement l'angle nord ↔ ARCore et la
  position de l'utilisateur : ni boussole (perturbée en ville), ni GPS, ni Google.
- **Intégration** : un `AugmentedImageDatabase` embarqué dans l'APK (quelques Ko par
  image) ; à la détection, un ancrage `ABSOLUTE` (déjà prévu par `GroundAligner.anchorAbsolute`)
  avec le cap et la position tirés du marqueur. Le reste (chevrons, ré-ancrage,
  trajectoire) ne change pas.
- **À prévoir** : fabrication et pose physique des marqueurs (accord de l'exploitant),
  relevé précis de chaque pose (position ± 0,5 m, orientation ± 2°), marqueurs
  suffisamment grands (≥ 15 cm, lisibles à 1–3 m) et contrastés, entretien
  (vandalisme, salissures). Le marqueur ne sert qu'au départ d'une station ; en cours
  de route, le mode au sol actuel prend le relais.
