#!/usr/bin/env bash
# Télécharge le modèle IA embarqué dans public/models/ pour le packager dans
# l'APK Android (évite le téléchargement ~0,3 Go au premier lancement).
#
# Usage :  bash scripts/fetch-model.sh
# Prérequis : pip install huggingface_hub  (fournit huggingface-cli)
#
# Note : le modèle (255 Mo en q4f16, 294 Mo en q4) alourdit l'APK d'autant. Si tu préfères un APK léger,
# ne lance PAS ce script — l'app téléchargera le modèle au premier lancement
# (et le mettra en cache). C'est le comportement par défaut.
set -euo pipefail

MODEL="onnx-community/LFM2.5-350M-ONNX"
DEST="public/models/LFM2.5-350M-ONNX"

if [ -f "$DEST/config.json" ]; then
  echo "✓ Modèle déjà présent dans $DEST"
  exit 0
fi

mkdir -p "$DEST"

if command -v huggingface-cli >/dev/null 2>&1; then
  echo "Téléchargement via huggingface-cli → $DEST"
  # Seulement les fichiers utilisés (configs + les deux variantes, voir
  # src/ai/modelPolicy.js VARIANTS, graphes ET poids .onnx_data) : le dépôt complet
  # dépasse 3 Go.
  huggingface-cli download "$MODEL" --local-dir "$DEST" \
    --include "*.json" "*.jinja" "onnx/model_q4f16.onnx*" "onnx/model_q4.onnx*"
else
  echo "⚠ huggingface-cli absent. Installe-le puis relance :"
  echo "   pip install huggingface_hub"
  echo "   bash scripts/fetch-model.sh"
  exit 1
fi

echo "✓ Modèle téléchargé dans $DEST"
du -sh "$DEST"
