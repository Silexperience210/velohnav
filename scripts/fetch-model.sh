#!/usr/bin/env bash
# Télécharge le modèle IA embarqué dans public/models/ pour le packager dans
# l'APK Android (évite le téléchargement ~1 Go au premier lancement).
#
# Usage :  bash scripts/fetch-model.sh
# Prérequis : pip install huggingface_hub  (fournit huggingface-cli)
#
# Note : le modèle (~1 Go) rend l'APK ~1 Go. Si tu préfères un APK léger,
# ne lance PAS ce script — l'app téléchargera le modèle au premier lancement
# (et le mettra en cache). C'est le comportement par défaut.
set -euo pipefail

MODEL="onnx-community/Qwen2.5-1.5B-Instruct"
DEST="public/models/Qwen2.5-1.5B-Instruct"

if [ -f "$DEST/config.json" ]; then
  echo "✓ Modèle déjà présent dans $DEST"
  exit 0
fi

mkdir -p "$DEST"

if command -v huggingface-cli >/dev/null 2>&1; then
  echo "Téléchargement via huggingface-cli → $DEST"
  huggingface-cli download "$MODEL" --local-dir "$DEST"
else
  echo "⚠ huggingface-cli absent. Installe-le puis relance :"
  echo "   pip install huggingface_hub"
  echo "   bash scripts/fetch-model.sh"
  exit 1
fi

echo "✓ Modèle téléchargé dans $DEST"
du -sh "$DEST"
