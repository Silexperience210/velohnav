import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { t } from "../i18n.js";
import { C, COMPASS_LABELS, FOV } from "../constants.js";
import { haversine, getBearing, fDist, fWalk, bCol, bTag, pins } from "../utils.js";

import { nearestStop, getWeatherAdvice } from "../utils.js";
import { C } from "../constants.js";

function WeatherBanner({ weather, advice, nearStop, station }) {
  const [expanded, setExpanded] = useState(false);
  if (!weather) return null;

  const modeColor = advice.mode==="bike" ? C.good : advice.mode==="transit" ? "#A78BFA" : C.warn;
  const modeIcon  = advice.mode==="bike" ? "🚲" : advice.mode==="transit" ? "🚌" : "🚲→🚌";
  const modeLabel = advice.mode==="bike"
    ? "CONDITIONS IDÉALES POUR LE VÉLO"
    : advice.mode==="transit"
    ? "PRÉFÉRER LES TRANSPORTS EN COMMUN"
    : "CONDITIONS MIXTES — VÉLO OU TC";

  return (
    <div style={{ marginTop:8, borderRadius:7, overflow:"hidden",
      border:`1px solid ${modeColor}33`, background:`rgba(8,12,15,0.95)` }}>

      {/* Ligne principale — tap pour expandre */}
      <div onPointerDown={()=>setExpanded(e=>!e)}
        style={{ display:"flex", alignItems:"center", gap:8,
          padding:"9px 12px", cursor:"pointer" }}>
        {/* Icône météo + temp */}
        <div style={{ fontSize:20, lineHeight:1 }}>{weather.icon}</div>
        <div style={{ flex:1 }}>
          <div style={{ color:modeColor, fontSize:8, fontFamily:C.fnt,
            fontWeight:700, letterSpacing:1.5 }}>{modeLabel}</div>
          <div style={{ color:C.muted, fontSize:7, fontFamily:C.fnt, marginTop:1 }}>
            {weather.temp}°C · {weather.label}
            {weather.rain > 0 && ` · 💧${weather.rain}mm/h`}
            {weather.wind > 15 && ` · 💨${weather.wind}km/h`}
          </div>
        </div>
        <div style={{ color:C.muted, fontSize:10 }}>{expanded?"▲":"▼"}</div>
      </div>

      {/* Détail expandable */}
      {expanded && (
        <div style={{ borderTop:`1px solid ${C.border}`, padding:"10px 12px" }}>

          {advice.mode === "bike" && (
            <div style={{ color:C.muted, fontSize:8, fontFamily:C.fnt, lineHeight:1.8 }}>
              ✅ Pas de pluie, vent faible.{"\n"}
              <span style={{ color:C.good }}>Trajet vélo recommandé</span> depuis {station?.name ?? "cette station"}.
            </div>
          )}

          {advice.mode === "transit" && nearStop && (
            <div>
              <div style={{ color:C.muted, fontSize:8, fontFamily:C.fnt,
                lineHeight:1.8, marginBottom:8 }}>
                ⚠️ {advice.reason} — le vélo est déconseillé.{"\n"}
                Arrêt TC le plus proche de ta destination :
              </div>
              <div style={{ display:"flex", alignItems:"center", gap:8,
                background:"rgba(167,139,250,0.08)", border:"1px solid rgba(167,139,250,0.25)",
                borderRadius:6, padding:"8px 10px" }}>
                <span style={{ fontSize:16 }}>{nearStop.type==="tram"?"🚊":"🚌"}</span>
                <div style={{ flex:1 }}>
                  <div style={{ color:"#A78BFA", fontSize:10, fontFamily:C.fnt, fontWeight:700 }}>
                    {nearStop.name}
                  </div>
                  <div style={{ color:C.muted, fontSize:7, fontFamily:C.fnt }}>
                    {nearStop.lines.join(" · ")} · à {nearStop.distM < 1000
                      ? `${nearStop.distM}m`
                      : `${(nearStop.distM/1000).toFixed(1)}km`}
                  </div>
                </div>
                {/* Lien Google Maps vers l'arrêt */}
                <a href={`https://maps.google.com/?q=${nearStop.lat},${nearStop.lng}`}
                  target="_blank" rel="noopener noreferrer"
                  style={{ color:"#A78BFA", fontSize:14, textDecoration:"none" }}>🗺</a>
              </div>
              <div style={{ color:C.muted, fontSize:7, fontFamily:C.fnt,
                marginTop:6, lineHeight:1.6 }}>
                💡 Prends un Vel'OH! jusqu'à cet arrêt, puis continue en TC.{"\n"}
                Horaires en temps réel : mobiliteit.lu
              </div>
            </div>
          )}

          {advice.mode === "mixed" && nearStop && (
            <div>
              <div style={{ color:C.muted, fontSize:8, fontFamily:C.fnt,
                lineHeight:1.8, marginBottom:8 }}>
                ⚡ {advice.reason} — conditions acceptables mais changeantes.{"\n"}
                Si tu préfères éviter le risque :
              </div>
              <div style={{ display:"flex", gap:8 }}>
                <div style={{ flex:1, background:C.accentBg,
                  border:`1px solid ${C.accent}44`, borderRadius:6,
                  padding:"7px 8px", textAlign:"center" }}>
                  <div style={{ fontSize:14 }}>🚲</div>
                  <div style={{ color:C.accent, fontSize:7, fontFamily:C.fnt,
                    fontWeight:700, marginTop:2 }}>VÉLO OK</div>
                  <div style={{ color:C.muted, fontSize:6, fontFamily:C.fnt }}>
                    Vêtements imperméables conseillés
                  </div>
                </div>
                <div style={{ flex:1, background:"rgba(167,139,250,0.08)",
                  border:"1px solid rgba(167,139,250,0.25)", borderRadius:6,
                  padding:"7px 8px", textAlign:"center" }}>
                  <div style={{ fontSize:14 }}>{nearStop.type==="tram"?"🚊":"🚌"}</div>
                  <div style={{ color:"#A78BFA", fontSize:7, fontFamily:C.fnt,
                    fontWeight:700, marginTop:2 }}>{nearStop.name}</div>
                  <div style={{ color:C.muted, fontSize:6, fontFamily:C.fnt }}>
                    {nearStop.lines.join(" · ")} · {nearStop.distM < 1000
                      ? `${nearStop.distM}m`
                      : `${(nearStop.distM/1000).toFixed(1)}km`}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}



export default WeatherBanner;
