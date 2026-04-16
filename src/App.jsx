import { useState, useEffect, useRef, useCallback } from "react";
import { t } from "./i18n.js";
import { C, REF, FALLBACK } from "./constants.js";
import { haversine, getBearing, fDist, bTag, bCol, enrich, parseStation,
         addToHistory, fetchJCDecaux, startWatchingGPS, notifyStation,
         requestNotifPerm, launchNativeArNav, payLnAddress } from "./utils.js";
import { useWeather } from "./hooks/useWeather.js";
import ARScreen    from "./components/ARScreen.jsx";
import MapScreen   from "./components/MapScreen.jsx";
import AIScreen    from "./components/AIScreen.jsx";
import SettingsScreen from "./components/SettingsScreen.jsx";

// ── Status Bar ─────────────────────────────────────────────────────
function StatusBar({ tab, gpsOk, apiLive, isMock, onRefresh, refreshing }) {
  // FIX: renommé t→now pour éviter de masquer la fonction t() de i18n
  const [now,setNow] = useState(new Date());
  useEffect(()=>{ const i=setInterval(()=>setNow(new Date()),1000); return()=>clearInterval(i); },[]);
  const LABELS = { ar:t("status.ar"), map:t("status.map"), ai:t("status.ai"), settings:t("status.settings") };
  return (
    <div style={{ padding:"9px 14px", display:"flex", justifyContent:"space-between", alignItems:"center",
      background:"rgba(8,12,15,0.97)", borderBottom:`1px solid ${C.border}`, flexShrink:0 }}>
      <div style={{ display:"flex", alignItems:"center", gap:8 }}>
        <div style={{ width:4, height:20, background:C.accent, boxShadow:`0 0 6px ${C.accent}` }}/>
        <div>
          <div style={{ color:C.text, fontSize:13, fontWeight:700, fontFamily:C.fnt, letterSpacing:3 }}>
            VELOH<span style={{ color:C.accent }}>NAV</span>
          </div>
          <div style={{ color:C.muted, fontSize:7, fontFamily:C.fnt, letterSpacing:1 }}>{LABELS[tab]}</div>
        </div>
      </div>
      <div style={{ display:"flex", gap:5, alignItems:"center" }}>
        {[
          { l:gpsOk?t("status.gps_ok"):t("status.gps_nok"),  col:gpsOk?C.good:C.warn },
          { l:apiLive?t("status.live"):isMock?t("status.demo"):t("status.error"), col:apiLive?C.good:isMock?C.warn:C.bad },
        ].map(s=>(
          <div key={s.l} style={{ display:"flex", alignItems:"center", gap:3, padding:"3px 6px",
            background:"rgba(0,0,0,0.4)", border:`1px solid ${C.border}`, borderRadius:3 }}>
            <div style={{ width:5,height:5,borderRadius:"50%",background:s.col,boxShadow:`0 0 4px ${s.col}` }}/>
            <span style={{ color:s.col, fontSize:7, fontFamily:C.fnt }}>{s.l}</span>
          </div>
        ))}
        {/* Bouton refresh manuel (#8) */}
        <div onPointerDown={onRefresh}
          style={{ padding:"3px 6px", background:"rgba(0,0,0,0.4)",
            border:`1px solid ${C.border}`, borderRadius:3, cursor:"pointer",
            fontSize:10, transform:refreshing?"rotate(180deg)":"rotate(0deg)",
            transition:"transform 0.5s", userSelect:"none" }}>
          🔄
        </div>
        <div style={{ color:C.text, fontSize:11, fontFamily:C.fnt, fontWeight:700,
          padding:"3px 6px", background:"rgba(0,0,0,0.4)", border:`1px solid ${C.border}`, borderRadius:3 }}>
          {now.toLocaleTimeString("fr",{hour:"2-digit",minute:"2-digit"})}
        </div>
      </div>
    </div>
  );
}

// ── DRAPEAU DAMIER (SVG inline) ───────────────────────────────────
// Drapeau de ligne d'arrivée flottant au-dessus de chaque pin AR.
// Taille et opacité pilotées par scale (distance).

// ── Nav Bar ────────────────────────────────────────────────────────
function NavBar({ tab, setTab }) {
  return (
    <div style={{ display:"flex",background:"rgba(8,12,15,0.98)",borderTop:`1px solid ${C.border}`,flexShrink:0 }}>
      {[{id:"ar",i:"⬡",l:"AR"},{id:"map",i:"◈",l:"MAP"},{id:"ai",i:"◎",l:"AI"},{id:"settings",i:"≡",l:"OPT"}].map(t=>(
        <div key={t.id} onPointerDown={()=>setTab(t.id)} style={{ flex:1,padding:"11px 0 9px",textAlign:"center",cursor:"pointer",
          borderTop:`2px solid ${tab===t.id?C.accent:"transparent"}`,transition:"border-color 0.15s" }}>
          <div style={{ fontSize:15,color:tab===t.id?C.accent:C.muted }}>{t.i}</div>
          <div style={{ fontSize:7,fontFamily:C.fnt,letterSpacing:2,marginTop:2,color:tab===t.id?C.accent:C.muted }}>{t.l}</div>
        </div>
      ))}
    </div>
  );
}

// ── ROOT ──────────────────────────────────────────────────────────

// ── Root App ───────────────────────────────────────────────────────
export default function App() {
  const [tab,setTab] = useState("map"); // map par défaut — AR demande la caméra au render
  const [sel,setSel] = useState(null);
  const [apiKey,setApiKey]     = useState(()=>localStorage.getItem("velohnav_jcdKey")||"");
  const [claudeKey,setClaudeKey] = useState(()=>localStorage.getItem("velohnav_claudeKey")||"");
  const [lnAddr,setLnAddr]     = useState(()=>localStorage.getItem("velohnav_lnAddr")||"");
  const [lnOn,setLnOn]         = useState(()=>localStorage.getItem("velohnav_lnOn")==="true");
  const [ads,setAds]           = useState(()=>localStorage.getItem("velohnav_ads")==="true");
  // BUG-1/BUG-4 fix: mapsKey géré en state React → réactif + exposé dans Settings
  const [mapsKey,setMapsKey]   = useState(()=>localStorage.getItem("velohnav_mapsKey")||"");
  const [stations,setStations] = useState(()=>enrich(FALLBACK,null));
  const [apiLive,setApiLive]   = useState(false);
  const [isMock,setIsMock]     = useState(true);
  const [gpsPos,setGpsPos]     = useState(null);
  const [refreshing,setRefreshing] = useState(false);

  // Météo OpenMeteo — hook réactif à la position GPS
  const { weather } = useWeather(gpsPos);

  // FIX #3 : Système de trajet — départ/arrivée pour Sats Rewards
  const [trip,setTrip] = useState(null); // null | { stationId, name, startAt }
  const [satsResult,setSatsResult] = useState(null);
  // BUG-2 fix: timer qui force un re-render chaque minute quand un trajet est en cours
  const [, setTick] = useState(0);
  useEffect(()=>{
    if (!trip) return;
    const t = setInterval(()=>setTick(n=>n+1), 30000); // re-render toutes les 30s
    return ()=>clearInterval(t);
  },[trip]);

  // Lifted AI conversation state
  const top0 = FALLBACK.find(s=>s.bikes>0);
  const [aiHistory, setAiHistory] = useState([]);
  const [aiDisplay, setAiDisplay] = useState([{ role:"ai",
    text: top0 ? `${FALLBACK.filter(s=>s.bikes>0).length}/${FALLBACK.length} stations dispos. Plus proche : ${top0.name} (${fDist(haversine(REF.lat,REF.lng,top0.lat,top0.lng))}, ${top0.bikes}🚲 ⚡${top0.elec}).` : "Chargement…"
  }]);

  // Persist settings
  useEffect(()=>{ localStorage.setItem("velohnav_jcdKey",   apiKey);    },[apiKey]);
  useEffect(()=>{ localStorage.setItem("velohnav_claudeKey",claudeKey); },[claudeKey]);
  useEffect(()=>{ localStorage.setItem("velohnav_lnAddr",   lnAddr);    },[lnAddr]);
  useEffect(()=>{ localStorage.setItem("velohnav_lnOn",     lnOn);      },[lnOn]);
  useEffect(()=>{ localStorage.setItem("velohnav_ads",      ads);       },[ads]);
  useEffect(()=>{ localStorage.setItem("velohnav_mapsKey",  mapsKey);   },[mapsKey]);

  // GPS
  useEffect(()=>{
    let stop=()=>{};
    startWatchingGPS(pos=>setGpsPos(pos)).then(fn=>{ if(fn) stop=fn; });
    return ()=>stop();
  },[]);
  useEffect(()=>{ setStations(prev=>enrich(prev,gpsPos)); },[gpsPos]);
  const gpsRef = useRef(null);
  useEffect(()=>{ gpsRef.current = gpsPos; },[gpsPos]);

  // Ref pour comparer stations prev/next → notifications (#14)
  const prevStationsRef = useRef({});

  const loadData = useCallback(async()=>{
    const userPos = gpsRef.current;
    let newStations = null;
    if (apiKey) {
      try {
        const raw = await fetchJCDecaux(apiKey);
        if (raw && Array.isArray(raw)) {
          newStations = enrich(raw.map(parseStation), userPos);
          setApiLive(true); setIsMock(false);
        }
      } catch(e) { console.warn("JCDecaux load:", e); }
    }
    if (!newStations) {
      newStations = enrich(FALLBACK, userPos);
      setApiLive(false); setIsMock(true);
    }
    // FIX #14 : Comparer avec les stations précédentes → notifier si vide/faible
    newStations.forEach(s=>{
      const prev = prevStationsRef.current[s.id];
      if (prev !== undefined) notifyStation(s, prev);
      prevStationsRef.current[s.id] = s.bikes;
    });
    setStations(newStations);
  },[apiKey]);

  useEffect(()=>{ loadData(); },[loadData]);
  // Refresh auto toutes les 60s
  useEffect(()=>{ const t=setInterval(loadData,60000); return()=>clearInterval(t); },[loadData]);
  // FIX #8 : Refresh quand l'app revient au premier plan
  useEffect(()=>{
    const onFocus = ()=>loadData();
    const onVisible = ()=>{ if(document.visibilityState==="visible") loadData(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return ()=>{
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  },[loadData]);

  // FIX #8 : Refresh manuel avec feedback visuel
  const handleRefresh = useCallback(async()=>{
    setRefreshing(true);
    await loadData();
    setTimeout(()=>setRefreshing(false), 600);
  },[loadData]);

  // FIX #13 : Ajouter à l'historique quand on sélectionne une station
  useEffect(()=>{
    if (sel) {
      const s = stations.find(st=>st.id===sel);
      if (s) addToHistory(s);
    }
  },[sel, stations]);

  // FIX #3 : Démarrer un trajet
  const startTrip = useCallback((station)=>{
    setTrip({ stationId:station.id, name:station.name, startAt:Date.now() });
    setSatsResult(null);
  },[]);

  // FIX #2 : Terminer un trajet → envoyer sats via LNURL-pay
  const endTrip = useCallback(async()=>{
    if (!trip) return;
    const durMin = Math.round((Date.now()-trip.startAt)/60000);
    const sats = Math.max(10, durMin * 2); // 2 sats/min, min 10 sats
    setTrip(null);
    if (lnOn && lnAddr) {
      setSatsResult({ok:null, msg:t("trip.sats_sending")});
      const res = await payLnAddress(lnAddr, sats, `VelohNav trajet ${durMin}min depuis ${trip.name}`);
      setSatsResult(res.ok
        ? {ok:true,  msg:t("trip.sats_sent", {n: sats})}
        : {ok:false, msg:`⚠ ${res.error}`});
      setTimeout(()=>setSatsResult(null), 4000);
    }
  },[trip, lnOn, lnAddr]);

  // FIX #14 : Demander permission notifications au premier lancement
  useEffect(()=>{ requestNotifPerm(); },[]);

  return (
    <div style={{ width:"100%",height:"100vh",display:"flex",flexDirection:"column",
      background:C.bg,overflow:"hidden",maxWidth:430,margin:"0 auto" }}>
      <StatusBar tab={tab} gpsOk={!!gpsPos} apiLive={apiLive} isMock={isMock}
        onRefresh={handleRefresh} refreshing={refreshing}/>

      {/* Banner trajet en cours (#3) */}
      {trip&&(
        <div style={{ background:"rgba(245,130,13,0.12)",borderBottom:`1px solid ${C.accent}44`,
          padding:"7px 14px",display:"flex",alignItems:"center",gap:10,flexShrink:0 }}>
          <span style={{ fontSize:14 }}>🚲</span>
          <div style={{ flex:1 }}>
            <div style={{ color:C.accent,fontSize:9,fontFamily:C.fnt,fontWeight:700 }}>{t("trip.in_progress")}</div>
            <div style={{ color:C.muted,fontSize:8,fontFamily:C.fnt }}>
              Depuis {trip.name} · {Math.round((Date.now()-trip.startAt)/60000)} min
            </div>
          </div>
          <div onPointerDown={endTrip}
            style={{ background:C.accentBg,border:`1px solid ${C.accent}`,borderRadius:5,
              padding:"5px 12px",color:C.accent,fontSize:8,fontFamily:C.fnt,
              fontWeight:700,cursor:"pointer" }}>
            {t("trip.arrive")}
          </div>
        </div>
      )}

      {/* Toast résultat sats (#2) */}
      {satsResult&&(
        <div style={{ background:satsResult.ok===true?"rgba(46,204,143,0.15)":satsResult.ok===false?"rgba(224,62,62,0.12)":"rgba(245,130,13,0.1)",
          borderBottom:`1px solid ${satsResult.ok===true?C.good:satsResult.ok===false?C.bad:C.accent}44`,
          padding:"7px 14px",textAlign:"center",flexShrink:0 }}>
          <span style={{ color:satsResult.ok===true?C.good:satsResult.ok===false?C.bad:C.warn,
            fontSize:10,fontFamily:C.fnt }}>{satsResult.msg}</span>
        </div>
      )}

      <div style={{ flex:1,display:"flex",flexDirection:"column",overflow:"hidden",minHeight:0 }}>
        {tab==="ar"       &&<ARScreen  stations={stations} sel={sel} setSel={setSel} gpsPos={gpsPos}
          trip={trip} onStartTrip={startTrip} mapsKey={mapsKey}/>}
        {tab==="map"      &&<MapScreen stations={stations} sel={sel} setSel={setSel} gpsPos={gpsPos}
          trip={trip} onStartTrip={startTrip}
          mapsKey={mapsKey} weather={weather}
          onTabChange={setTab}/>}
        {tab==="ai"       &&<AIScreen  stations={stations} claudeKey={claudeKey}
          aiHistory={aiHistory} setAiHistory={setAiHistory}
          aiDisplay={aiDisplay} setAiDisplay={setAiDisplay}/>}
        {tab==="settings" &&<SettingsScreen
          apiKey={apiKey}    setApiKey={setApiKey}
          claudeKey={claudeKey} setClaudeKey={setClaudeKey}
          lnAddr={lnAddr}    setLnAddr={setLnAddr}
          lnOn={lnOn}        setLnOn={setLnOn}
          ads={ads}          setAds={setAds}
          mapsKey={mapsKey}  setMapsKey={setMapsKey}
          onRefresh={loadData} apiLive={apiLive} isMock={isMock} gpsPos={gpsPos}/>}
      </div>
      <NavBar tab={tab} setTab={setTab}/>
    </div>
  );
}

