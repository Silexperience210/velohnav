# VelohNav

**Multimodal AI assistant for Vel'OH!, Luxembourg tram and RGTR buses.**

[![CI](https://github.com/Silexperience210/velohnav/actions/workflows/apk.yml/badge.svg)](https://github.com/Silexperience210/velohnav/actions/workflows/apk.yml)
![React](https://img.shields.io/badge/React-18-61DAFB?logo=react)
![Capacitor](https://img.shields.io/badge/Capacitor-8-119EFF?logo=capacitor)
![License](https://img.shields.io/badge/license-MIT-green)

[🎬 Open the motion showcase](docs/showcase.html)

---

## What it is

VelohNav is a privacy-first Android app for multimodal trips in Luxembourg. It combines live Vel'OH! (JCDecaux) bike-share data, the Luxembourg tram (T1), the RGTR bus network via mobiliteit.lu, an on-device AI assistant, AR turn-by-turn navigation, weather-aware ride advice and mixed-mode routing — without sending your location or questions to the cloud.

![Map, AI assistant, and AR mockups](docs/mockups-composite.png)

---

## Features

### 🗺️ Live Vel'OH! stations
- Real-time bikes, e-bikes and free docks from the JCDecaux Vel'OH! GBFS feed.
- Filters: available bikes, free docks, electric.
- Search by station name.
- Tap a station to start AR navigation or a trip.

### 🤖 Local AI assistant
- **LFM2.5 runs on the phone** (native CPU, ~30 tokens/s, ~1.2 s load).
- Ask in English or French: "Nearest station?", "Which station is empty?", "Weather?", "Route to Kirchberg", "Next RGTR bus?", "Next tram?".
- Numbers and facts always come from app data, never from the model's imagination.
- A fallback deterministic engine answers even when the model is unavailable.

### 🥽 AR navigation
- Camera overlay with turn-by-turn directions.
- Compass + GPS fusion.
- Picks the best walking or cycling route from your location.

### 🌦️ Weather-aware advice
- Current conditions and hourly forecast.
- A simple bike score tells you if it's a good moment to ride.
- Automatic multimodal suggestion when the weather degrades.

### 🚌 Bus, tram & multimodal
- Real-time RGTR bus departures and Luxembourg tram (T1) times from mobiliteit.lu via Transitous / MOTIS.
- Mixed-mode routing: bike to a Vel'OH! station, then bus or tram.

### 🔒 100 % private
- No cloud LLM.
- No tracking.
- No account required.
- Optional Lightning rewards are paid directly to your wallet via LNURL-pay.

---

## Motion showcase

Open `docs/showcase.html` in a browser for a 42-second animated tour of the app:

```bash
open docs/showcase.html        # macOS
xdg-open docs/showcase.html    # Linux
```

---

## Tech stack

| Layer | Technology |
|-------|------------|
| UI | React 18 + Vite 5 |
| Mobile bridge | Capacitor 8 |
| Map | MapLibre GL + OpenFreeMap |
| Local model | LFM2.5 via transformers.js + custom native CPU backend (C++/llama.cpp) |
| AR | ARCore (Android) |
| Weather | Open-Meteo |
| Routing | OSRM + BRouter |
| Transit | mobiliteit.lu · Transitous / MOTIS |
| Crypto | Bitcoin Lightning via LNURL-pay |
| Tests | Vitest |

---

## Quick start

```bash
git clone https://github.com/Silexperience210/velohnav.git
cd velohnav
npm install
npm run dev        # PWA on http://localhost:5173
npm test           # run the test suite
```

### Build debug APK

```bash
npm run build
npx cap sync android
cd android && ./gradlew assembleDebug
# → android/app/build/outputs/apk/debug/app-debug.apk
```

The GitHub Actions workflow builds a debug APK on every push.

---

## Supported devices

- **Android 10+** for the native APK.
- **ARCore** required for the AR navigation features.
- The local AI model runs on CPU; GPU acceleration is attempted but disabled automatically on chipsets that fail the self-test (e.g. Adreno 660).

---

## License

MIT — Data © Vel'OH! / Ville de Luxembourg, mobiliteit.lu / RGTR / Tram Luxembourg, Transitous, OpenStreetMap contributors, Open-Meteo.
