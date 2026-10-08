# Tram T1 sur la carte

## Ce qui est affiché

- **Tracé** du T1 (Findel → Gasperich/Stadion, 24 arrêts, 16,3 km) et ses arrêts.
- **Rames à leur position théorique** : déduite de l'horaire officiel, recalculée
  chaque seconde, sans réseau. Au Luxembourg, aucun flux public ne donne la
  position réelle des véhicules : on n'affiche donc pas de « position GPS » du tram.
- **Fiche d'arrêt** (toucher un arrêt) : trois prochains départs par direction,
  avec le terminus des courses partielles (Luxexpo, Lycée Bouneweg), badge
  « Gratuit », itinéraire à pied.
- **Retards** : si Transitous publie un temps réel pour l'arrêt, il est appliqué
  aux départs de la fiche (`mergeRealtime`). Au 08/10/2026, Transitous renvoyait
  `realTime: false` pour toutes les courses T1 : en pratique, on affiche l'horaire seul.

## Données : extraction minimale

Source : GTFS « Horaires et arrêts des transports publics », Administration des
transports publics (ATP), data.public.lu, licence CC BY 4.0. Il est republié chaque
semaine et pèse environ 17 Mo zippés (75 Mo décompressés), dont 41 Mo pour `shapes.txt`.

`scripts/extract-tram.mjs` ne garde que la ligne T1 (`route_type` 0) :

| Contenu | Méthode | Taille |
|---|---|---|
| Tracé | shape du parcours complet, Douglas-Peucker à 2 m (970 → 211 points), polyline précision 5 | ~2 Kio |
| Arrêts | nom, position, distance le long du tracé | ~3 Kio |
| Profils de marche | 7 séquences d'arrêts avec leurs temps de parcours (constants toute la journée) | ~2 Kio |
| Courses | `[profil, heure de départ]`, regroupées par **type de jour** (même ensemble de courses), départs en delta | ~6 Kio |
| Calendrier | une lettre par jour de validité → type de jour | 67 octets |

Le total fait **14 Kio** (2,7 Kio gzip) pour 1 511 courses, contre 17 Mo pour le flux
complet. Le bundle principal grossit de 24 Kio, code compris (+6,5 Kio gzip).

Rafraîchir : `bash scripts/fetch-tram.sh` (télécharge, extrait, supprime le zip).

## Limites assumées

- **Validité** : les horaires couvrent la période publiée (actuellement
  jusqu'au 12/12/2026). Au-delà, l'app reprend le type de jour le plus fréquent
  pour le même jour de la semaine et l'indique (« Horaire estimé — à vérifier »).
  Pensez à régénérer les données à chaque version.
- **Heure** : les calculs se font à l'heure de Luxembourg, quelle que soit la zone du
  téléphone. Les courses de jour de service qui passent minuit sont prises en compte.
  Les nuits de changement d'heure, les courses après 2 h sont décalées d'une heure.
- **Mouvement** : progression linéaire entre deux arrêts, arrêt à quai entre
  arrivée et départ. Les accélérations ne sont pas modélisées, et les retards non plus
  (aucune donnée par véhicule).
- L'appariement temps réel compare l'heure prévue (HH:MM, heure de l'appareil côté
  Transitous) : sur un téléphone réglé sur un autre fuseau, les retards ne
  s'appliquent pas (l'horaire reste juste).
