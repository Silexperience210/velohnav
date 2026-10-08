import { useState, useEffect, useRef, useCallback, useMemo, lazy, Suspense } from "react";
import { t } from "../i18n.js";
import { C } from "../constants.js";
import { fDist, fWalk, bCol, nearestStop } from "../utils.js";
import { getWeatherAdvice } from "../hooks/useWeather.js";
import { useCompass } from "../hooks/useCompass.js";
import { useFusedHeading } from "../hooks/useFusedHeading.js";
import { useRoute } from "../hooks/useRoute.js";
import WeatherBanner from "./WeatherBanner.jsx";

// MapLibre (~1 Mo) chargé à la demande — hors du bundle initial
const MapView = lazy(() => import("./map/MapView.jsx"));

// Helper i18n pour le label de statut station
const statusKey = s => s.status==="CLOSED"?"station.closed":s.bikes===0?"station.empty":s.bikes<=2?"station.low":"station.available";

const fMin = sec => `${Math.max(1, Math.round(sec/60))} min`;

// ── MAP SCREEN ────────────────────────────────────────────────────

function MapScreen({ stations, sel, setSel, gpsPos, trip, onStartTrip, mapsKey, onTabChange, weather }) {
  const [filter, setFilter] = useState("all"); // all | bikes | docks | elec
  const [search, setSearch] = useState("");

  // Cap fusionné (boussole + course GPS) pour le cône de la position.
  // iOS exige un geste utilisateur pour la boussole → démarrage aussi au 1er toucher.
  const { heading: magHeading, start: startCompass } = useCompass();
  const heading = useFusedHeading(magHeading, gpsPos);
  const compassStarted = useRef(false);
  const ensureCompass = useCallback(() => {
    if (compassStarted.current) return;
    compassStarted.current = true;
    startCompass();
  }, [startCompass]);
  useEffect(() => {
    if (typeof DeviceOrientationEvent?.requestPermission !== "function") ensureCompass();
  }, [ensureCompass]);

  // Aperçu d'itinéraire « Y aller » : même hook que l'AR (BRouter → OSRM → Google)
  const [routeTarget, setRouteTarget] = useState(null); // station | null
  const { route, loading: routeLoading, error: routeError } =
    useRoute(gpsPos, routeTarget, "cycling", mapsKey);

  // Lancer navigation AR : sélectionner la station + switcher vers l'onglet AR
  // ARScreen lit velohnav_pendingNavMode au montage pour auto-démarrer la nav
  const launchArNav = useCallback((station, mode)=>{
    setSel(station.id);
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("velohnav_pendingNavMode", mode);
      localStorage.setItem("velohnav_pendingNavId", String(station.id));
    }
    onTabChange?.("ar");
  },[setSel, onTabChange]);

  // Stations filtrées pour affichage
  const displayed = useMemo(()=>{
    let s = stations;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      s = s.filter(st=>st.name.toLowerCase().includes(q));
    }
    if (filter==="bikes") s = s.filter(st=>st.bikes>0&&st.status==="OPEN");
    if (filter==="docks") s = s.filter(st=>st.docks>0&&st.status==="OPEN");
    if (filter==="elec")  s = s.filter(st=>st.elec>0&&st.status==="OPEN");
    return s;
  },[stations, filter, search]);

  // Tap sur la carte : id string (GeoJSON) → id station d'origine
  const onSelect = useCallback(sid=>{
    if (sid == null) { setSel(null); return; }
    const s = stations.find(x=>String(x.id)===sid);
    setSel(s ? s.id : null);
  },[stations, setSel]);

  const selStation = stations.find(s=>s.id===sel) ?? null;

  // Changer de station / fermer la fiche annule l'aperçu d'itinéraire
  useEffect(()=>{
    if (routeTarget && routeTarget.id !== sel) setRouteTarget(null);
  },[sel, routeTarget]);

  // Stats résumées (sur toutes les stations, pas juste filtrées)
  const nDispo=stations.filter(s=>s.bikes>0&&s.status==="OPEN").length;
  const nVide=stations.filter(s=>s.bikes===0&&s.status==="OPEN").length;
  const nElec=stations.reduce((n,s)=>n+(s.status==="OPEN"?s.elec||0:0),0);

  const FILTERS=[
    {id:"all",  label:t("map.filter_all"),    count:stations.length},
    {id:"bikes",label:t("map.filter_bikes"),count:nDispo},
    {id:"docks",label:t("map.filter_docks"), count:stations.filter(s=>s.docks>0&&s.status==="OPEN").length},
    {id:"elec", label:t("map.filter_elec"),  count:stations.filter(s=>s.elec>0&&s.status==="OPEN").length},
  ];

  if (!stations.length) return (
    <div style={{ flex:1,display:"flex",alignItems:"center",justifyContent:"center",background:C.bg }}>
      <div style={{ color:C.muted,fontSize:10,fontFamily:C.fnt }}>{t("map.loading")}</div>
    </div>
  );

  const routeShown = routeTarget && route && routeTarget.id === sel;

  return (
    <div style={{ flex:1,display:"flex",flexDirection:"column",background:C.bg,minHeight:0,position:"relative" }}>

      {/* ── Barre recherche ───────────────────────────────── */}
      <div style={{ padding:"8px 10px 0",flexShrink:0 }}>
        <div style={{ display:"flex",alignItems:"center",gap:6,
          background:"rgba(255,255,255,0.04)", border:`1px solid ${C.border}`,
          borderRadius:8, padding:"6px 10px" }}>
          <span style={{ color:C.muted, fontSize:12 }}>🔍</span>
          <input value={search} onChange={e=>setSearch(e.target.value)}
            placeholder={t("map.search")}
            style={{ flex:1, background:"transparent", border:"none", outline:"none",
              color:C.text, fontSize:11, fontFamily:C.fnt }}/>
          {search&&<span onPointerDown={()=>setSearch("")}
            style={{ color:C.muted, fontSize:12, cursor:"pointer" }}>✕</span>}
        </div>
      </div>

      {/* ── Filtres pills ─────────────────────────────────── */}
      <div style={{ display:"flex",gap:5,padding:"6px 10px 4px",flexShrink:0,overflowX:"auto" }}>
        {FILTERS.map(f=>(
          <div key={f.id} onPointerDown={()=>setFilter(f.id)}
            style={{ flexShrink:0, padding:"4px 10px",
              background: filter===f.id ? C.accentBg : "rgba(255,255,255,0.03)",
              border:`1px solid ${filter===f.id ? C.accent : C.border}`,
              borderRadius:12, cursor:"pointer",
              display:"flex", alignItems:"center", gap:4 }}>
            <span style={{ color:filter===f.id?C.accent:C.muted, fontSize:9, fontFamily:C.fnt }}>
              {f.label}
            </span>
            <span style={{ color:filter===f.id?C.accent:"#444", fontSize:8, fontFamily:C.fnt }}>
              {f.count}
            </span>
          </div>
        ))}
        {/* Stats inline */}
        <div style={{ marginLeft:"auto",flexShrink:0,display:"flex",alignItems:"center" }}>
          <span style={{ color:C.muted,fontSize:7,fontFamily:C.fnt }}>
            <span style={{ color:C.good }}>{nDispo}</span>✓{" "}
            <span style={{ color:C.bad }}>{nVide}</span>✗{" "}
            <span style={{ color:"#60A5FA" }}>{nElec}</span>⚡
          </span>
        </div>
      </div>

      {/* ── Carte MapLibre ───────────────────────────────── */}
      <div onPointerDown={ensureCompass}
        style={{ flex:1,position:"relative",margin:"0 10px 6px",minHeight:120,
          background:C.bg,border:`1px solid ${C.border}`,borderRadius:10,overflow:"hidden" }}>
        <Suspense fallback={
          <div style={{ position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",
            color:C.accent,fontFamily:C.fnt,fontSize:9,letterSpacing:2 }}>CHARGEMENT CARTE…</div>
        }>
          <MapView stations={displayed} selId={sel} onSelect={onSelect}
            gpsPos={gpsPos} heading={heading}
            routeCoords={routeShown ? route.coords : null}
            routeKey={routeShown ? `${routeTarget.id}_${route.computedAt}` : null}/>
        </Suspense>
      </div>

      {/* ── Fiche station sélectionnée (bas) ─────── */}
      {selStation ? (
        <div style={{ flexShrink:0, margin:"0 10px 10px",
          background:"rgba(8,12,15,0.97)", border:`1px solid ${C.border}`,
          borderTop:`2px solid ${bCol(selStation)}`, borderRadius:8,
          padding:"11px 14px" }}>
          <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8 }}>
            <div style={{ minWidth:0 }}>
              <div style={{ color:C.muted,fontSize:7,fontFamily:C.fnt,letterSpacing:1.5,marginBottom:2 }}>
                <span style={{ color:bCol(selStation) }}>{t(statusKey(selStation))}</span>
                {gpsPos && <> · {fDist(selStation.dist)} · {fWalk(selStation.dist)} {t("station.walk")}</>}
                {selStation.renting===false && selStation.status==="OPEN" && <> · {t("station.no_rent")}</>}
                {selStation.returning===false && selStation.status==="OPEN" && <> · {t("station.no_return")}</>}
                {selStation._mock&&" · " + t("ai.simulated")}
              </div>
              <div style={{ color:C.text,fontSize:14,fontFamily:C.fnt,fontWeight:700,
                overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{selStation.name}</div>
            </div>
            <div onPointerDown={()=>setSel(null)}
              style={{ padding:"5px 8px",background:"rgba(255,255,255,0.04)",
                border:`1px solid ${C.border}`,borderRadius:4,color:C.muted,
                fontSize:11,cursor:"pointer",flexShrink:0 }}>✕</div>
          </div>
          <div style={{ display:"flex",borderTop:`1px solid ${C.border}`,paddingTop:9 }}>
            {[
              {l:t("station.bikes"),  v:selStation.bikes, col:bCol(selStation)},
              {l:t("station.elec"), v:selStation.elec,  col:"#60A5FA"},
              {l:t("station.docks"),  v:selStation.docks, col:C.good},
              {l:t("station.capacity"),   v:selStation.cap,   col:C.muted},
            ].map((m,i,arr)=>(
              <div key={m.l} style={{ flex:1,textAlign:"center",
                borderRight:i<arr.length-1?`1px solid ${C.border}`:"none" }}>
                <div style={{ color:m.col,fontSize:18,fontFamily:C.fnt,fontWeight:700 }}>{m.v}</div>
                <div style={{ color:C.muted,fontSize:6,fontFamily:C.fnt,letterSpacing:0.5,marginTop:1 }}>{m.l}</div>
              </div>
            ))}
          </div>

          {/* Aperçu itinéraire vélo */}
          {routeTarget?.id===selStation.id && (
            <div style={{ marginTop:8,padding:"6px 9px",background:"rgba(245,130,13,0.06)",
              border:`1px solid ${C.accent}33`,borderRadius:5,
              color:C.muted,fontSize:8,fontFamily:C.fnt,display:"flex",gap:10,alignItems:"center" }}>
              <span style={{ color:C.accent,fontWeight:700,letterSpacing:1 }}>🚲 {t("map.route")}</span>
              {routeLoading && !route ? <span>{t("map.route_loading")}</span>
               : routeError && !route ? <span style={{ color:C.bad }}>{routeError}</span>
               : route ? <>
                  <span style={{ color:C.text,fontWeight:700 }}>{fDist(route.totalDist)}</span>
                  <span style={{ color:C.text,fontWeight:700 }}>{fMin(route.totalTime)}</span>
                  {route.totalAscent!=null && <span>D+ {route.totalAscent}m</span>}
                  <span style={{ marginLeft:"auto",color:"#444" }}>{route.provider}</span>
                </> : null}
            </div>
          )}

          {/* Actions */}
          <div style={{ marginTop:10,display:"flex",gap:6 }}>
            <div onPointerDown={()=>{ if(gpsPos) setRouteTarget(routeTarget?.id===selStation.id?null:selStation); }}
              style={{ flex:1.3,display:"flex",alignItems:"center",justifyContent:"center",gap:5,
                background:routeTarget?.id===selStation.id?C.accentBg:"rgba(245,130,13,0.08)",
                border:`1px solid ${gpsPos?C.accent:C.border}`,opacity:gpsPos?1:0.5,
                borderRadius:6,padding:"9px 0",cursor:gpsPos?"pointer":"default" }}>
              <span style={{ color:C.accent,fontSize:9,fontFamily:C.fnt,fontWeight:700,letterSpacing:1 }}>
                {gpsPos ? (routeTarget?.id===selStation.id ? t("map.route_hide") : t("map.go")) : t("map.gps_required")}
              </span>
            </div>
            <div onPointerDown={()=>launchArNav(selStation,"cycling")}
              style={{ flex:1,display:"flex",alignItems:"center",justifyContent:"center",gap:4,
                background:"rgba(59,130,246,0.12)",border:`1px solid #3B82F655`,
                borderRadius:6,padding:"9px 0",cursor:"pointer" }}>
              <span style={{ color:"#3B82F6",fontSize:9,fontFamily:C.fnt,fontWeight:700 }}>AR 🚲</span>
            </div>
            <div onPointerDown={()=>launchArNav(selStation,"walking")}
              style={{ flex:1,display:"flex",alignItems:"center",justifyContent:"center",gap:4,
                background:"rgba(167,139,250,0.12)",border:`1px solid #A78BFA55`,
                borderRadius:6,padding:"9px 0",cursor:"pointer" }}>
              <span style={{ color:"#A78BFA",fontSize:9,fontFamily:C.fnt,fontWeight:700 }}>AR 🚶</span>
            </div>
            {/* Démarrer un trajet (Sats Rewards) */}
            {!trip&&selStation.bikes>0&&onStartTrip&&(
              <div onPointerDown={()=>onStartTrip(selStation)}
                style={{ display:"flex",alignItems:"center",justifyContent:"center",gap:4,
                  background:"rgba(46,204,143,0.10)",border:`1px solid ${C.good}55`,
                  borderRadius:6,padding:"9px 10px",cursor:"pointer" }}>
                <span style={{ color:C.good,fontSize:8,fontFamily:C.fnt,fontWeight:700 }}>▶ {t("map.start_trip")}</span>
              </div>
            )}
          </div>

          {/* ── Bandeau météo + recommandation multimodale ── */}
          {weather && (
            <WeatherBanner
              weather={weather}
              advice={getWeatherAdvice(weather)}
              nearStop={nearestStop(selStation.lat, selStation.lng)}
              station={selStation}
            />
          )}
        </div>
      ) : (
        /* ── Légende compacte + météo inline quand rien n'est sélectionné ── */
        <div style={{ display:"flex",gap:10,padding:"5px 14px 10px",flexShrink:0,alignItems:"center",flexWrap:"wrap" }}>
          {[[C.good,"Dispo"],[C.warn,"Faible"],[C.bad,"Vide"],["#444","Fermé"],["#60A5FA","⚡ Élec"],[C.blue,"Vous"]].map(([c,l])=>(
            <div key={l} style={{ display:"flex",alignItems:"center",gap:3 }}>
              <div style={{ width:6,height:6,borderRadius:"50%",background:c,boxShadow:`0 0 4px ${c}` }}/>
              <span style={{ color:C.muted,fontSize:7,fontFamily:C.fnt }}>{l}</span>
            </div>
          ))}
          {weather&&(()=>{
            const advice = getWeatherAdvice(weather);
            const col = advice.mode==="bike"?C.good:advice.mode==="transit"?"#A78BFA":C.warn;
            return (
              <span style={{ color:col, fontSize:8, fontFamily:C.fnt,
                marginLeft:"auto", fontWeight:700 }}>
                {weather.icon} {weather.temp}°C
              </span>
            );
          })()}
        </div>
      )}
    </div>
  );
}

export default MapScreen;
