# 🚲 VelohNav

**AR bike-sharing app for the Luxembourg Vel'OH! network**

Prototype web React — visualisation en réalité augmentée des stations JCDecaux avec assistant IA intégré.

![VelohNav](https://img.shields.io/badge/status-prototype-orange) ![React](https://img.shields.io/badge/React-18-blue) ![License](https://img.shields.io/badge/license-MIT-green)

---

## ✨ Features

| Onglet | Description |
|--------|-------------|
| **AR** | Vue caméra simulée avec pins AR interactifs, boussole, carte station sélectionnée |
| **MAP** | Carte 2D de toutes les stations avec distances Haversine réelles |
| **AI** | Assistant Claude (claude-sonnet) avec contexte live des stations |
| **OPT** | Clé API JCDecaux, Lightning Address (Sats Rewards), Publicités AR |

---

## 🗺️ Données

- **GPS stations** : coordonnées réelles du réseau Vel'OH! Luxembourg (116 stations)
- **Distances** : calcul Haversine depuis Ville-Haute (prototype) → GPS natif en production
- **API** : `GET https://api.jcdecaux.com/vls/v3/stations?contract=Luxembourg&apiKey=KEY`
- **Champs utilisés** : `available_bikes` · `electrical_bikes` · `mechanical_bikes` · `available_bike_stands` · `status` · `position` · `last_update`

> ⚠️ L'API JCDecaux bloque les requêtes CORS depuis un navigateur. En app Android native (Retrofit), aucun problème.

---

## 🚀 Installation

```bash
git clone https://github.com/YOUR_USERNAME/velohnav.git
cd velohnav
npm install
npm run dev
```

---

## ⚡ Sats Rewards (optionnel)

Entre ta **Lightning Address** dans OPT (ex: `toi@getalby.com`).  
Après chaque trajet validé → sats envoyés via **LNURL-pay**, self-custodial, zéro serveur intermédiaire.

Compatible : Alby · Wallet of Satoshi · Phoenix · Blink · Zeus

---

## 🏗️ Stack Android (production)

| Couche | Techno |
|--------|--------|
| AR     | ARCore Geospatial API + Sceneview |
| GPS    | FusedLocationProviderClient |
| API    | Retrofit2 + JCDecaux v3 |
| IA     | Gemini Nano on-device (AICore) |
| UI     | Jetpack Compose + Material3 |
| LN     | LNURL-pay client |

---

## 📂 Structure

```
velohnav/
├── src/
│   ├── App.jsx       # Composant principal (AR, Map, AI, Settings)
│   └── main.jsx      # Entry point React
├── index.html
├── vite.config.js
├── package.json
└── README.md
```

---

## 🔑 Clé API JCDecaux

Inscription gratuite : [developer.jcdecaux.com](https://developer.jcdecaux.com)  
À entrer dans l'onglet **OPT** de l'app.

---

## 📄 Licence

MIT — Open Data JCDecaux : [licence](https://developer.jcdecaux.com/files/Open-Licence-en.pdf)
