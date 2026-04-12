# 🧭 Implémentation AR Réelle avec Gyroscope

## Changements apportés

### 1. Hook `useDeviceOrientation`
**Fichier** : `src/hooks/useDeviceOrientation.js`

Remplace la boussole simulée par l'orientation réelle du téléphone :
- ✅ Utilise l'API `DeviceOrientationEvent`
- ✅ Gère les permissions iOS 13+ 
- ✅ Lissage des données (moyenne glissante sur 5 échantillons)
- ✅ Détection de `webkitCompassHeading` sur iOS (plus précis)
- ✅ Calcul du bearing (azimut) entre deux points GPS
- ✅ Détection du champ de vision (FOV)

### 2. Composant `ARScreen` réécrit
**Fichier** : `src/components/ARScreen.jsx`

Nouveau comportement :
- 📱 Les stations apparaissent uniquement quand tu pointes dans leur direction
- 🧭 Boussole numérique réelle (0-360° avec cardinal N/NE/E/etc.)
- 👁️ Indicateur "X stations visibles"
- 📍 Calcul dynamique position X selon bearing relatif
- 📏 Distance = hauteur Y (plus proche = plus bas à l'écran)
- 🔔 Modal de permission gyroscope

## Intégration dans App.jsx

Remplace l'ancien `ARScreen` (lignes 224-362) par :

```jsx
import { ARScreen } from './components/ARScreen';

// ... dans le render :
{tab==="ar" && <ARScreen stations={stations} sel={sel} setSel={setSel} gpsPos={gpsPos}/>}
```

## Fonctionnement

```
GPS User (lat, lng)
       ↓
Bearing calculé vers chaque station (0-360°)
       ↓
Comparé avec Heading du téléphone (orientation)
       ↓
Si |bearing - heading| < 30° (demi-FOV) → Visible
       ↓
Position X = mapping [-30°, +30°] → [0, screenWidth]
```

## Améliorations visibles

| Avant (Hardcoded) | Après (Gyroscope) |
|-------------------|-------------------|
| Pins fixes en grille | Pins bougent avec téléphone |
| Boussole qui défile toute seule | Vraie orientation Nord |
| 6 pins toujours visibles | Seulement celles dans le champ |
| Pas de lien GPS-orientation | Bearing calculé en temps réel |
| Animation CSS fake | Données capteurs réelles |

## Test

1. **Web** (Chrome Android / Safari iOS) :
   - Ouvrir l'app
   - Autoriser gyroscope (modal)
   - Autoriser caméra
   - Tourner le téléphone → les pins bougent !

2. **Android natif** (Capacitor) :
   - Les permissions sont déjà dans `capacitor.config.json`
   - Build : `npm run android`

## Troubleshooting

### iOS - Pas d'orientation
Safari 13+ nécessite une permission utilisateur. Le modal apparaît automatiquement.

### Android - Très sensible
Le lissage (buffer 5 échantillons) est actif mais le gyroscope Android peut être bruyant. 
À améliorer : ajouter un filtre de Kalman.

### Précision
Le `alpha` (boussole) dérive parfois sur Android. Sur iOS, `webkitCompassHeading` est plus stable car utilise le magnétomètre.

## Prochaines améliorations possibles

1. **Filtre de Kalman** : Pour lisser les secousses
2. **Altitude/Élévation** : Utiliser `geolocation.altitude` si dispo
3. **3D** : Utiliser `beta` et `gamma` pour position Y réelle (actuellement simulé)
4. **Radar** : Mini-carte radar en coin montrant toutes les stations autour
5. **Son** : Bips quand on pointe vers une station (accessibilité)

## Démo

```
Utilisateur à Luxembourg centre (49.61, 6.13)
Pointe vers Gare (Sud) → 180°
Station Gare à 200m, bearing 175°
→ Apparaît au centre de l'écran (dans FOV 60°)

Pointe vers Kirchberg (Nord-Est) → 45°
Station Kirchberg MUDAM à 1km, bearing 48°
→ Apparaît légèrement à droite du centre

Pointe vers Belair (Nord-Ouest) → 300°
Aucune station dans ce direction
→ "0 station en vue"
```
