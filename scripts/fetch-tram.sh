#!/usr/bin/env bash
# Régénère src/data/tramT1.json depuis le dernier GTFS officiel (publié chaque
# semaine par l'ATP sur data.public.lu). Le zip (~17 Mo) est téléchargé dans un
# dossier temporaire puis supprimé : seul l'extrait T1 (~14 Kio) est versionné.
#
# Usage :  bash scripts/fetch-tram.sh
# Prérequis : curl, unzip, node, python3 (lecture de la réponse de l'API)
set -euo pipefail

API="https://data.public.lu/api/1/datasets/horaires-et-arrets-des-transport-publics-gtfs/"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Ressource la plus récente (l'API les liste de la plus récente à la plus ancienne)
URL="$(curl -fsS "$API" | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["resources"][0]["url"])')"
NAME="$(basename "$URL")"
echo "↓ $NAME"
curl -fsS -o "$TMP/gtfs.zip" "$URL"
mkdir "$TMP/raw"
unzip -q "$TMP/gtfs.zip" routes.txt trips.txt stop_times.txt stops.txt shapes.txt calendar.txt calendar_dates.txt -d "$TMP/raw"

node "$ROOT/scripts/extract-tram.mjs" "$TMP/raw" "$NAME"
echo "→ vérifier : npx vitest run src/utils/tram.test.js (les relevés datés du test peuvent devoir être mis à jour)"
