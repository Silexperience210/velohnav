# ARCore Geospatial — mise en service (administrateur)

La navigation AR native (`ArNavigationActivity`) localise le téléphone avec
**ARCore Geospatial** (VPS : précision ~1 m et cap exact, à partir des images
Street View). Google n'accepte la requête que si **trois conditions** sont réunies.
Si l'une manque, ARCore répond `ERROR_NOT_AUTHORIZED` : l'application bascule
alors immédiatement en guidage GPS et affiche l'encart « AR précise
indisponible » avec la cause. Rien de tout cela ne se corrige dans le code
applicatif : c'est de la configuration.

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
- `Earth en erreur permanente (ERROR_NOT_AUTHORIZED)` → revoir les points 2 et 3.

Le VPS a aussi besoin d'**extérieur** et de **bâtiments couverts par Street View** :
en intérieur ou en zone non couverte, il ne converge pas et l'application passe
en GPS au bout de 25 s (compte à rebours affiché, bouton « Passer en mode GPS »).

## Alternative : authentification sans clé

Google recommande sur Android l'authentification « keyless » (client OAuth de
type Android, même paquet + SHA-1, dépendance `play-services-auth`, sans
meta-data `com.google.android.geo.API_KEY`). Non implémentée ici : elle demande
les mêmes empreintes SHA-1, et la clé reste nécessaire pour Directions.
