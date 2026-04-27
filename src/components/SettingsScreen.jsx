import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { t } from "../i18n.js";
import { C, COMPASS_LABELS, FOV } from "../constants.js";
import { haversine, getBearing, fDist, fWalk, bCol, bTag, pins } from "../utils.js";

import { useI18n } from "../i18n.js";

function SettingsScreen({ apiKey, setApiKey, claudeKey, setClaudeKey, onRefresh, apiLive, isMock, gpsPos, lnAddr, setLnAddr, lnOn, setLnOn, ads, setAds, mapsKey, setMapsKey, hafasKey="", setHafasKey, spatialAudio=false, setSpatialAudio=()=>{} }) {
  const [draft,setDraft]=useState(apiKey);
  const [saved,setSaved]=useState(false);
  const [claudeDraft,setClaudeDraft]=useState(claudeKey);
  const [claudeSaved,setClaudeSaved]=useState(false);
  const [mapsDraft,setMapsDraft]=useState(mapsKey||"");
  const [mapsSaved,setMapsSaved]=useState(false);
  const [lnSaved,setLnSaved]=useState(false);
  // i18n
  const { lang, setLanguage } = useI18n();

  useEffect(()=>{ setDraft(apiKey); },[apiKey]);
  useEffect(()=>{ setClaudeDraft(claudeKey); },[claudeKey]);
  useEffect(()=>{ setMapsDraft(mapsKey||""); },[mapsKey]);

  const saveKey=()=>{ setApiKey(draft.trim()); setSaved(true); setTimeout(()=>{ setSaved(false); onRefresh(); },1200); };
  const saveClaudeKey=()=>{ setClaudeKey(claudeDraft.trim()); setClaudeSaved(true); setTimeout(()=>setClaudeSaved(false),1500); };
  const saveMapsKey=()=>{ setMapsKey?.(mapsDraft.trim()); setMapsSaved(true); setTimeout(()=>setMapsSaved(false),1500); };
  // FIX : validation format Lightning Address (user@domain) avant sauvegarde
  const [lnError, setLnError] = useState("");
  const saveLn=()=>{
    const addr = lnAddr.trim();
    const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr);
    if (addr && !valid) { setLnError("Format invalide — ex: toi@getalby.com"); return; }
    setLnError(""); setLnSaved(true); setTimeout(()=>setLnSaved(false),1500);
  };

  const Toggle=({label,sub,val,set})=>(
    <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",
      padding:"11px 0",borderBottom:`1px solid ${C.border}` }}>
      <div style={{ flex:1,marginRight:12 }}>
        <div style={{ color:C.text,fontSize:11,fontFamily:C.fnt }}>{label}</div>
        {sub&&<div style={{ color:C.muted,fontSize:8,fontFamily:C.fnt,marginTop:2,lineHeight:1.5 }}>{sub}</div>}
      </div>
      <div onPointerDown={()=>set(v=>!v)} style={{ width:38,height:20,borderRadius:10,cursor:"pointer",position:"relative",flexShrink:0,
        background:val?C.accentBg:"rgba(255,255,255,0.04)",border:`1px solid ${val?C.accent:C.border}`,
        boxShadow:val?`0 0 8px ${C.accent}30`:"none",transition:"all 0.2s" }}>
        <div style={{ position:"absolute",top:3,width:14,height:14,borderRadius:"50%",
          background:val?C.accent:C.muted,left:val?21:3,transition:"left 0.2s,background 0.2s" }}/>
      </div>
    </div>
  );

  return (
    <div style={{ flex:1,overflowY:"auto",background:C.bg,minHeight:0 }}>
      <div style={{ margin:"14px 14px 0",background:"rgba(255,255,255,0.02)",
        border:`1px solid ${gpsPos?C.good+"40":C.border}`,borderRadius:7,padding:"11px 13px" }}>
        <div style={{ color:C.text,fontSize:11,fontFamily:C.fnt }}>{t("settings.gps")}</div>
        <div style={{ color:gpsPos?C.good:C.muted,fontSize:8,fontFamily:C.fnt,marginTop:2 }}>
          {gpsPos?`✓ ${gpsPos.lat.toFixed(5)}, ${gpsPos.lng.toFixed(5)} ±${gpsPos.acc}m`:t("settings.gps_waiting")}
        </div>
      </div>

      <div style={{ padding:"14px 14px 0" }}>
        <div style={{ color:C.muted,fontSize:8,fontFamily:C.fnt,letterSpacing:2,marginBottom:10 }}>{t("settings.jcd_key")}</div>
        <div style={{ background:"rgba(255,255,255,0.02)",border:`1px solid ${C.border}`,borderRadius:8,padding:"14px" }}>
          <div style={{ background:apiLive?"rgba(46,204,143,0.08)":"rgba(245,130,13,0.08)",
            border:`1px solid ${apiLive?C.good+"40":C.accent+"40"}`,borderRadius:4,padding:"7px 10px",marginBottom:10 }}>
            <div style={{ color:apiLive?C.good:C.accent,fontSize:9,fontFamily:C.fnt }}>
              {apiLive?t("settings.jcd_live"):isMock?t("settings.jcd_demo"):t("settings.jcd_invalid")}
            </div>
            {isMock&&<div style={{ color:C.muted,fontSize:8,fontFamily:C.fnt,marginTop:2 }}>developer.jcdecaux.com (gratuit)</div>}
          </div>
          <div style={{ display:"flex",gap:8 }}>
            <input value={draft} onChange={e=>setDraft(e.target.value)} placeholder="Clé API JCDecaux…" type="password"
              style={{ flex:1,background:"rgba(0,0,0,0.4)",border:`1px solid ${C.border}`,
                borderRadius:4,padding:"8px 10px",color:C.text,fontSize:11,fontFamily:C.fnt,outline:"none" }}/>
            <div onPointerDown={saveKey} style={{ background:saved?"rgba(46,204,143,0.15)":C.accentBg,
              border:`1px solid ${saved?C.good:C.accent}`,color:saved?C.good:C.accent,
              borderRadius:4,padding:"8px 12px",fontSize:9,fontFamily:C.fnt,cursor:"pointer",fontWeight:700,whiteSpace:"nowrap" }}>
              {saved?t("settings.ok"):t("settings.apply")}
            </div>
          </div>
          <div style={{ color:C.muted,fontSize:8,fontFamily:C.fnt,marginTop:8,lineHeight:1.8 }}>
            GET /vls/v3/stations?contract=Luxembourg{"\n"}
            available_bikes · electrical_bikes{"\n"}
            available_bike_stands · status · position · last_update
          </div>
        </div>
      </div>

      <div style={{ padding:"14px 14px 0" }}>
        <div style={{ color:C.muted,fontSize:8,fontFamily:C.fnt,letterSpacing:2,marginBottom:10 }}>{t("settings.claude_key")}</div>
        <div style={{ background:"rgba(255,255,255,0.02)",border:`1px solid ${C.border}`,borderRadius:8,padding:"14px" }}>
          <div style={{ background:claudeKey?"rgba(46,204,143,0.08)":"rgba(245,130,13,0.08)",
            border:`1px solid ${claudeKey?C.good+"40":C.accent+"40"}`,borderRadius:4,padding:"7px 10px",marginBottom:10 }}>
            <div style={{ color:claudeKey?C.good:C.accent,fontSize:9,fontFamily:C.fnt }}>
              {claudeKey?"✓ Clé Claude configurée — assistant IA actif":"⚠ Clé Claude requise pour l'onglet AI"}
            </div>
            {!claudeKey&&<div style={{ color:C.muted,fontSize:8,fontFamily:C.fnt,marginTop:2 }}>console.anthropic.com → API Keys</div>}
          </div>
          <div style={{ display:"flex",gap:8 }}>
            <input value={claudeDraft} onChange={e=>setClaudeDraft(e.target.value)} placeholder="sk-ant-..." type="password"
              style={{ flex:1,background:"rgba(0,0,0,0.4)",border:`1px solid ${C.border}`,
                borderRadius:4,padding:"8px 10px",color:C.text,fontSize:11,fontFamily:C.fnt,outline:"none" }}/>
            <div onPointerDown={saveClaudeKey} style={{ background:claudeSaved?"rgba(46,204,143,0.15)":C.accentBg,
              border:`1px solid ${claudeSaved?C.good:C.accent}`,color:claudeSaved?C.good:C.accent,
              borderRadius:4,padding:"8px 12px",fontSize:9,fontFamily:C.fnt,cursor:"pointer",fontWeight:700,whiteSpace:"nowrap" }}>
              {claudeSaved?"✓ OK":t("settings.apply")}
            </div>
          </div>
          <div style={{ color:C.muted,fontSize:8,fontFamily:C.fnt,marginTop:8,lineHeight:1.8 }}>
            Clé stockée localement uniquement · jamais transmise à un tiers
          </div>
        </div>
      </div>

      <div style={{ padding:"14px 14px 0" }}>
        <div style={{ color:C.muted,fontSize:8,fontFamily:C.fnt,letterSpacing:2,marginBottom:10 }}>{t("settings.ln_rewards")}</div>
        <div style={{ background:"rgba(255,255,255,0.02)",border:`1px solid ${C.border}`,borderRadius:8,padding:"0 14px" }}>
          <Toggle label="Activer" sub="Sats après chaque trajet via LNURL-pay self-custodial" val={lnOn} set={setLnOn}/>
          {lnOn&&<div style={{ paddingBottom:14 }}>
            <div style={{ color:C.muted,fontSize:8,fontFamily:C.fnt,letterSpacing:2,margin:"10px 0 6px" }}>LIGHTNING ADDRESS</div>
            <div style={{ display:"flex",gap:8 }}>
              <input value={lnAddr} onChange={e=>{setLnAddr(e.target.value);setLnError("");}} placeholder="toi@getalby.com"
                style={{ flex:1,background:"rgba(0,0,0,0.4)",
                  border:`1px solid ${lnError?C.bad:C.border}`,
                  borderRadius:4,padding:"8px 10px",color:"#FCD34D",fontSize:11,fontFamily:C.fnt,outline:"none" }}/>
              <div onPointerDown={saveLn} style={{
                background:lnSaved?"rgba(46,204,143,0.15)":C.accentBg,border:`1px solid ${lnSaved?C.good:C.accent}`,
                color:lnSaved?C.good:C.accent,borderRadius:4,padding:"8px 12px",
                fontSize:9,fontFamily:C.fnt,cursor:"pointer",fontWeight:700,whiteSpace:"nowrap" }}>
                {lnSaved?"✓ OK":t("settings.save")}
              </div>
            </div>
            {lnError&&<div style={{ color:C.bad,fontSize:8,fontFamily:C.fnt,marginTop:4 }}>⚠ {lnError}</div>}
            <div style={{ color:C.muted,fontSize:8,fontFamily:C.fnt,marginTop:7,lineHeight:1.8 }}>
              Alby · WoS · Phoenix · Blink · Zeus{"\n"}LNURL-pay · self-custodial · zéro serveur
            </div>
          </div>}
        </div>
      </div>

      <div style={{ padding:"14px 14px 0" }}>
        <div style={{ color:C.muted,fontSize:8,fontFamily:C.fnt,letterSpacing:2,marginBottom:10 }}>🚌 CLÉS API TRANSPORT</div>
        <div style={{ background:"rgba(255,255,255,0.02)",border:`1px solid ${C.border}`,borderRadius:8,padding:"14px",display:"flex",flexDirection:"column",gap:10 }}>
          <div>
            <div style={{ color:C.muted,fontSize:7,fontFamily:C.fnt,letterSpacing:1,marginBottom:6 }}>Google Maps (navigation AR fallback)</div>
            <div style={{ display:"flex",gap:8 }}>
              <input value={mapsDraft} onChange={e=>setMapsDraft(e.target.value)} placeholder="AIza..." type="password"
                style={{ flex:1,background:"rgba(0,0,0,0.4)",border:`1px solid ${C.border}`,
                  borderRadius:4,padding:"8px 10px",color:C.text,fontSize:11,fontFamily:C.fnt,outline:"none" }}/>
              <div onPointerDown={saveMapsKey} style={{ background:mapsSaved?"rgba(46,204,143,0.15)":C.accentBg,
                border:`1px solid ${mapsSaved?C.good:C.accent}`,color:mapsSaved?C.good:C.accent,
                borderRadius:4,padding:"8px 12px",fontSize:9,fontFamily:C.fnt,cursor:"pointer",fontWeight:700,whiteSpace:"nowrap" }}>
                {mapsSaved?"✓ OK":"APPLIQUER"}
              </div>
            </div>
          </div>
          <div>
            <div style={{ color:C.muted,fontSize:7,fontFamily:C.fnt,letterSpacing:1,marginBottom:6 }}>
              HAFAS ATP — bus RGTR temps réel {hafasKey ? "✓ Actif" : "· opendata-api@verkeiersverbond.lu"}
            </div>
            <div style={{ display:"flex",gap:8 }}>
              <input value={hafasKey||""} onChange={e=>setHafasKey?.(e.target.value.trim())}
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" type="password"
                style={{ flex:1,background:"rgba(0,0,0,0.4)",border:`1px solid ${hafasKey?C.good:C.border}`,
                  borderRadius:4,padding:"8px 10px",color:C.text,fontSize:10,fontFamily:C.fnt,outline:"none" }}/>
            </div>
          </div>
        </div>
      </div>

      <div style={{ padding:"14px" }}>
        <div style={{ color:C.muted,fontSize:8,fontFamily:C.fnt,letterSpacing:2,marginBottom:10 }}>APPLICATION</div>
        <div style={{ background:"rgba(255,255,255,0.02)",border:`1px solid ${C.border}`,borderRadius:8,padding:"0 14px" }}>
          <Toggle label="Publicités AR" sub="Overlays sponsors dans la vue caméra" val={ads} set={setAds}/>
          <Toggle label="🎧 Audio spatial 3D"
            sub="Guidage vocal HRTF — la voix vient de la direction du virage. Casque/écouteurs requis."
            val={spatialAudio} set={setSpatialAudio}/>
          {/* Sélecteur de langue */}
          <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",
            padding:"11px 0",borderBottom:`1px solid ${C.border}` }}>
            <div>
              <div style={{ color:C.text,fontSize:11,fontFamily:C.fnt }}>🌐 Langue / Language</div>
              <div style={{ color:C.muted,fontSize:8,fontFamily:C.fnt,marginTop:2 }}>Détection automatique au premier lancement</div>
            </div>
            <div style={{ display:"flex",gap:6 }}>
              {[["fr","FR 🇫🇷"],["en","EN 🇬🇧"]].map(([code,label])=>(
                <div key={code} onPointerDown={()=>setLanguage(code)}
                  style={{ padding:"5px 10px",borderRadius:6,cursor:"pointer",
                    background: lang===code ? C.accentBg : "rgba(255,255,255,0.04)",
                    border:`1px solid ${lang===code ? C.accent : C.border}`,
                    color: lang===code ? C.accent : C.muted,
                    fontSize:9, fontFamily:C.fnt, fontWeight:lang===code?700:400 }}>
                  {label}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      <div style={{ height:20 }}/>
    </div>
  );
}

// ── NAV ───────────────────────────────────────────────────────────

export default SettingsScreen;
