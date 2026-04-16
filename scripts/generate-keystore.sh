#!/bin/bash
# VelohNav — Génération keystore Android
# Exécuter UNE SEULE FOIS sur ta machine locale, puis ajouter les 4 secrets à GitHub.

set -e
KEYSTORE="velohnav-release.jks"; ALIAS="velohnav"

read -sp "Mot de passe keystore : " SP; echo
read -sp "Mot de passe clé     : " KP; echo
read -p  "Prénom Nom           : " FN
read -p  "Organisation         : " ORG
read -p  "Pays (ex: LU)        : " CC

keytool -genkeypair -v \
  -keystore "$KEYSTORE" -alias "$ALIAS" \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass "$SP" -keypass "$KP" \
  -dname "CN=$FN, O=$ORG, C=$CC"

echo ""
echo "✅ Keystore créé : $KEYSTORE"
echo ""
echo "=== 4 secrets à ajouter sur GitHub ==="
echo "URL : https://github.com/Silexperience210/velohnav/settings/secrets/actions"
echo ""
echo "KEYSTORE_BASE64 :"
base64 -w 0 "$KEYSTORE"
echo ""
echo "KEY_ALIAS        : $ALIAS"
echo "KEY_PASSWORD     : (ce que tu as tapé pour 'clé')"
echo "STORE_PASSWORD   : (ce que tu as tapé pour 'keystore')"
echo ""
echo "⚠️  Ne jamais committer velohnav-release.jks dans git !"
