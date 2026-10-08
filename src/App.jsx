import { useState, useEffect, useRef, useCallback, lazy, Suspense, startTransition } from "react";
import { t, useI18n } from "./i18n.js";
import { FALLBACK } from "./constants.js";
import { enrich, parseStation, addToHistory, fetchJCDecaux, startWatchingGPS, notifyStation,
         requestNotifPerm, launchNativeArNav, payLnAddress } from "./utils.js";
import { useWeather } from "./hooks/useWeather.js";
import { useTransit } from "./hooks/useTransit.js";
import { saveStations, loadStations } from "./hooks/useStationsCache.js";
import { fetchGBFSStations } from "./utils/gbfs.js";
import { recordAvailability } from "./hooks/useAvailability.js";
import "./ui/ui.css";
import { ToastProvider, useToast } from "./ui/Toast.jsx";
import { SatsReward } from "./ui/Lightning.jsx";
import { AppHeader, TabBar, OfflineStrip, TripStrip } from "./ui/shell.jsx";
import { Spinner } from "./ui/primitives.jsx";
import { useOnline } from "./ui/hooks.js";
import { tripSats } from "./ui/format.js";
const ARScreen    = lazy(() => import("./components/ARScreen.jsx"));
const AIScreen    = lazy(() => import("./components/AIScreen.jsx"));
const UiKit       = lazy(() => import("./ui/kit/UiKit.jsx"));
import MapScreen   from "./components/MapScreen.jsx";
import SettingsScreen from "./components/SettingsScreen.jsx";

const TABS = [
  { id:"ar",       icon:"ar" },
  { id:"map",      icon:"map" },
  { id:"ai",       icon:"ai" },
  { id:"settings", icon:"sliders" },
];

// Repli pendant le chargement d'un écran lazy (AR, IA) — jamais d'écran noir.
function ScreenFallback() {
  return (
    <div className="vn-screen" style={{ alignItems:"center", justifyContent:"center", gap:10, color:"var(--vn-text2)" }}
      role="status">
      <Spinner size={22}/>
      <span style={{ fontSize:13 }}>{t("ui.loading")}</span>
    </div>
  );
}

// ── Root App ───────────────────────────────────────────────────────
export default function App() {
  // Galerie du design system : ?kit (ou ?kit=map|ar|base), chunk séparé.
  const kit = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("kit") : null;
  if (kit !== null) return <Suspense fallback={<ScreenFallback/>}><UiKit view={kit || "base"}/></Suspense>;
  return <ToastProvider><Shell/></ToastProvider>;
}

function Shell() {
  useI18n(); // re-render complet au changement de langue
  const toast = useToast();
  const online = useOnline();
  const [tab,setTab] = useState("map"); // map par défaut — AR demande la caméra au render
  const [sel,setSel] = useState(null);
  const [apiKey,setApiKey]     = useState(()=>localStorage.getItem("velohnav_jcdKey")||"");
  const [lnAddr,setLnAddr]     = useState(()=>localStorage.getItem("velohnav_lnAddr")||"");
  const [lnOn,setLnOn]         = useState(()=>localStorage.getItem("velohnav_lnOn")==="true");
  const [ads,setAds]           = useState(()=>localStorage.getItem("velohnav_ads")==="true");
  // BUG-1/BUG-4 fix: mapsKey géré en state React → réactif + exposé dans Settings
  const [mapsKey,setMapsKey]   = useState(()=>localStorage.getItem("velohnav_mapsKey")||"");
  // Spatial Audio HRTF — guidage vocal 3D pendant nav AR
  const [spatialAudio, setSpatialAudio] = useState(()=>localStorage.getItem("velohnav_spatialAudio")==="true");
  const [stations,setStations] = useState(()=>enrich(FALLBACK,null));
  const [apiLive,setApiLive]   = useState(false);
  const [isMock,setIsMock]     = useState(true);
  // Source des dispos : "gbfs" | "jcdecaux" | "cache" | "demo"
  const [dataSource,setDataSource] = useState("demo");
  const [lastUpdate,setLastUpdate] = useState(null); // ms — horodatage des données affichées
  const [gpsPos,setGpsPos]     = useState(null);
  const [refreshing,setRefreshing] = useState(false);

  // Météo OpenMeteo — hook réactif à la position GPS
  const { weather } = useWeather(gpsPos);

  // Transports en commun (Transitous, sans clé) — partagé entre ARScreen
  // (multimodal switch) et AIScreen. Chargé uniquement quand l'un des deux
  // est affiché (fair use Transitous : pas de polling en arrière-plan).
  const { stops: transitStops, departures: transitDepartures } =
    useTransit(gpsPos, { active: tab==="ar" || tab==="ai" });

  // FIX #3 : Système de trajet — départ/arrivée pour Sats Rewards
  const [trip,setTrip] = useState(null); // null | { stationId, name, startAt }
  const [ending,setEnding] = useState(false);

  // Lifted AI conversation state (le message d'accueil est construit par AIScreen)
  const [aiHistory, setAiHistory] = useState([]);
  const [aiDisplay, setAiDisplay] = useState([]);

  // Persist settings
  useEffect(()=>{ localStorage.setItem("velohnav_jcdKey",   apiKey);    },[apiKey]);
  useEffect(()=>{ localStorage.setItem("velohnav_lnAddr",   lnAddr);    },[lnAddr]);
  useEffect(()=>{ localStorage.setItem("velohnav_lnOn",     lnOn);      },[lnOn]);
  useEffect(()=>{ localStorage.setItem("velohnav_ads",      ads);       },[ads]);
  useEffect(()=>{ localStorage.setItem("velohnav_mapsKey",  mapsKey);   },[mapsKey]);
  // v4 : HAFAS remplacé par Transitous — on purge l'ancienne clé stockée
  useEffect(()=>{ localStorage.removeItem("velohnav_hafasKey"); },[]);
  useEffect(()=>{ localStorage.setItem("velohnav_spatialAudio", spatialAudio); },[spatialAudio]);

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

  // Renvoie { source: "live"|"cache"|"demo", count } pour le feedback du refresh manuel
  const loadData = useCallback(async()=>{
    const userPos = gpsRef.current;
    let newStations = null, source = "demo";
    // 1. GBFS public cyclocity (sans clé) — chemin par défaut, retry intégré
    const gbfs = await fetchGBFSStations();
    if (gbfs) {
      newStations = enrich(gbfs, userPos);
      setApiLive(true); setIsMock(false); setDataSource("gbfs"); setLastUpdate(Date.now());
      source = "live";
    }
    // 2. Repli optionnel : JCDecaux si l'utilisateur a saisi une clé
    if (!newStations && apiKey) {
      try {
        const raw = await fetchJCDecaux(apiKey);
        if (raw && Array.isArray(raw)) {
          newStations = enrich(raw.map(parseStation), userPos);
          setApiLive(true); setIsMock(false); setDataSource("jcdecaux"); setLastUpdate(Date.now());
          source = "live";
        }
      } catch(e) { console.warn("JCDecaux load:", e); }
    }
    if (!newStations) {
      // Essayer le cache IndexedDB avant fallback statique
      const cached = await loadStations();
      if (cached?.stations?.length) {
        newStations = enrich(cached.stations, userPos);
        setApiLive(false); setIsMock(false); setDataSource("cache");
        setLastUpdate(Date.now() - (cached.age || 0));
        source = "cache";
      } else {
        newStations = enrich(FALLBACK, userPos);
        setApiLive(false); setIsMock(true); setDataSource("demo"); setLastUpdate(Date.now());
      }
    } else {
      // Fetch réussi → persister en cache pour offline
      saveStations(newStations).catch(e => console.warn("[Cache] save:", e));
      // + alimenter l'historique de dispo (prédiction d'arrivée) — throttlé 5min
      recordAvailability(newStations).catch(()=>{});
    }
    // FIX #14 : Comparer avec les stations précédentes → notifier si vide/faible
    newStations.forEach(s=>{
      const prev = prevStationsRef.current[s.id];
      if (prev !== undefined) notifyStation(s, prev);
      prevStationsRef.current[s.id] = s.bikes;
    });
    // Ré-enrichir avec la position COURANTE : le GPS a pu arriver pendant les
    // fetchs (sinon distances calculées depuis REF jusqu'au prochain tick GPS)
    setStations(enrich(newStations, gpsRef.current));
    return { source, count: newStations.length };
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

  // Réseau : bandeau offline permanent + toast au retour, avec relance des données
  const wasOnline = useRef(online);
  useEffect(()=>{
    if (online && !wasOnline.current) {
      toast.show({ tone:"good", icon:"wifi", title:t("ui.offline.back") });
      loadData();
    }
    wasOnline.current = online;
  },[online, loadData, toast]);

  // FIX #8 : Refresh manuel avec feedback (spinner + toast résultat)
  const handleRefresh = useCallback(async()=>{
    if (refreshing) return;
    setRefreshing(true);
    try {
      const r = await loadData();
      toast.show({ id:"refresh", tone: r.source==="live" ? "good" : "warn",
        title: t("ui.refresh.done"),
        msg: t("ui.refresh.done_desc", { n:r.count, src:t(`ui.data.${r.source}_desc`) }), duration:2200 });
    } catch {
      toast.show({ id:"refresh", tone:"bad", title:t("ui.refresh.fail") });
    }
    setRefreshing(false);
  },[loadData, refreshing, toast]);

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
    toast.show({ tone:"accent", icon:"bike", title:t("ui.trip.started"), msg:station.name, duration:2200 });
  },[toast]);

  // FIX #2 : Terminer un trajet → envoyer sats via LNURL-pay (⚡ héros si succès)
  const endTrip = useCallback(async()=>{
    if (!trip || ending) return;
    const durMin = Math.round((Date.now()-trip.startAt)/60000);
    const sats = tripSats(durMin);
    if (!(lnOn && lnAddr)) {
      setTrip(null);
      toast.show({ tone:"good", icon:"flag", title:t("ui.trip.ended"),
        msg:`${t("ui.trip.ended_desc", { min:durMin, name:trip.name })} · ${t("ui.sats.hint")}`, duration:4000 });
      return;
    }
    setEnding(true);
    const id = toast.show({ duration:0, render:()=> <SatsReward amount={sats} state="sending"
      detail={t("ui.sats.detail", { min:durMin, addr:lnAddr })}/> });
    const res = await payLnAddress(lnAddr, sats, `VelohNav trajet ${durMin}min depuis ${trip.name}`);
    setEnding(false);
    setTrip(null);
    toast.update(id, { duration: res.ok ? 5000 : 6000, render:({ close })=> res.ok
      ? <SatsReward amount={sats} state="sent" detail={t("ui.sats.detail", { min:durMin, addr:lnAddr })} onClose={close}/>
      : <SatsReward amount={sats} state="error" detail={res.error} onClose={close}/> });
  },[trip, ending, lnOn, lnAddr, toast]);

  // FIX #14 : Demander permission notifications au premier lancement
  useEffect(()=>{ requestNotifPerm(); },[]);

  // Changement d'onglet en transition : un écran lazy qui suspend ne remplace
  // plus l'UI (cause du crash React #426 sur l'onglet AI en v3.3).
  const goTab = useCallback(id=>startTransition(()=>setTab(id)),[]);

  const tabs = TABS.map(x=>({ ...x, label:t(`ui.tab.${x.id}`) }));

  return (
    <div className="vn-app">
      <AppHeader screen={tab}
        pos={{ mode: gpsPos ? "gps" : "none", accuracy: gpsPos?.acc ?? null }}
        data={{ apiLive, isMock, offline: !online, lastUpdate }}
        refreshing={refreshing} onRefresh={handleRefresh}/>

      {!online && <OfflineStrip lastUpdate={lastUpdate}/>}
      {trip && <TripStrip trip={trip} lnOn={lnOn && !!lnAddr} ending={ending} onEnd={endTrip}/>}

      <main id="vn-main" className="vn-main" role="tabpanel" aria-labelledby={`tab-${tab}`}>
        <Suspense fallback={<ScreenFallback/>}>
          <div key={tab} className="vn-screen">
            {tab==="ar"       &&<ARScreen  stations={stations} sel={sel} setSel={setSel} gpsPos={gpsPos}
              trip={trip} onStartTrip={startTrip} mapsKey={mapsKey} weather={weather}
              transitStops={transitStops} transitDepartures={transitDepartures}
              spatialAudio={spatialAudio}/>}
            {tab==="map"      &&<MapScreen stations={stations} sel={sel} setSel={setSel} gpsPos={gpsPos}
              trip={trip} onStartTrip={startTrip}
              mapsKey={mapsKey} weather={weather} lastUpdate={lastUpdate}
              onTabChange={goTab}/>}
            {tab==="ai"       &&<AIScreen  stations={stations}
              aiHistory={aiHistory} setAiHistory={setAiHistory}
              aiDisplay={aiDisplay} setAiDisplay={setAiDisplay}
              gpsPos={gpsPos} mapsKey={mapsKey} weather={weather}
              transitStops={transitStops} transitDepartures={transitDepartures}
              onLaunchAR={async nav=>{ return await launchNativeArNav(nav.lat,nav.lng,nav.name,nav.mode,mapsKey); }}/>}
            {tab==="settings" &&<SettingsScreen
              apiKey={apiKey}    setApiKey={setApiKey}
              lnAddr={lnAddr}    setLnAddr={setLnAddr}
              lnOn={lnOn}        setLnOn={setLnOn}
              ads={ads}          setAds={setAds}
              mapsKey={mapsKey}  setMapsKey={setMapsKey}
              spatialAudio={spatialAudio} setSpatialAudio={setSpatialAudio}
              onRefresh={handleRefresh} refreshing={refreshing}
              apiLive={apiLive} isMock={isMock} dataSource={dataSource} gpsPos={gpsPos}
              lastUpdate={lastUpdate} stationCount={stations.length} online={online}/>}
          </div>
        </Suspense>
      </main>
      <TabBar tabs={tabs} value={tab} onChange={goTab}/>
    </div>
  );
}
