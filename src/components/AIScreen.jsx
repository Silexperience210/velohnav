import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { t } from "../i18n.js";
import { C, COMPASS_LABELS, FOV } from "../constants.js";
import { haversine, getBearing, fDist, fWalk, bCol, bTag, pins } from "../utils.js";


function AIScreen({ stations, claudeKey, aiHistory, setAiHistory, aiDisplay, setAiDisplay }) {
  const top = stations.find(s=>s.bikes>0);
  const initMsg = top
    ? `${stations.filter(s=>s.bikes>0).length}/${stations.length} stations dispos. Plus proche : ${top.name} (${fDist(top.dist)}, ${top.bikes}🚲 ⚡${top.elec}).`
    : t("map.loading");

  const [input,   setInput]   = useState("");
  const [busy,    setBusy]    = useState(false);
  const endRef = useRef();
  useEffect(()=>endRef.current?.scrollIntoView({behavior:"smooth"}),[aiDisplay]);

  // Mise à jour du message d'accueil quand les données passent de mock → live
  useEffect(()=>{
    if (aiHistory.length === 0) {
      setAiDisplay([{ role:"ai", text:initMsg }]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[stations]);

  // FIX : systemPrompt dans useMemo — évite de recréer sendText à chaque render
  // et élimine le risque de closure stale sur une const recalculée inline.
  const systemPrompt = useMemo(()=>{
    // Historique des 5 dernières stations visitées (#13)
    const hist = getHistory().slice(0,5);
    const histTxt = hist.length
      ? `\nStations récemment visitées par l'utilisateur : ${hist.map(h=>h.name).join(", ")}.`
      : "";
    return `Tu es VELOH·AI, l'assistant de VelohNav pour le réseau Vel'OH! Luxembourg.
Réponds en français, de façon concise (3-4 lignes max).
Données actuelles (triées par distance) :
${stations.map(s=>`• ${s.name} | ${s.bikes} vélos (⚡${s.elec} élec., 🔧${s.meca} méca.) | ${s.docks} docks | ${fDist(s.dist)} | ${bTag(s)}`).join("\n")}${histTxt}
Réponds uniquement sur la mobilité Veloh, les itinéraires, ou l'app.`;
  },[stations]);

  const sendText = useCallback(async(text)=>{
    const q=(text||input).trim();
    if(!q||busy) return;
    if (!claudeKey) {
      setAiDisplay(d=>[...d,{role:"user",text:q},{role:"ai",text:t("ai.missing_key")}]);
      setInput(""); return;
    }
    setInput(""); setBusy(true);
    setAiDisplay(d=>[...d,{role:"user",text:q}]);
    // FIX : historique borné à 20 messages max → évite de dépasser le context window Claude
    const hist = [...aiHistory,{role:"user",content:q}].slice(-20);
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages",{
        method:"POST",
        headers:{
          "Content-Type":"application/json",
          "x-api-key": claudeKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        // max_tokens 400 → 800 : évite les réponses tronquées sur itinéraires complexes
        body:JSON.stringify({ model:"claude-haiku-4-5-20251001", max_tokens:800,
          system:systemPrompt, messages:hist }),
      });
      const data = await r.json();
      if (!r.ok) {
        // FIX : cas spécial 401 → message clair pour l'utilisateur
        const errMsg = r.status === 401
          ? t("ai.invalid_key")
          : data?.error?.message ?? `Erreur API (${r.status})`;
        setAiDisplay(d=>[...d,{role:"ai",text:`⚠ ${errMsg}`}]);
      } else {
        const reply = data.content?.[0]?.text ?? "Erreur de réponse.";
        setAiHistory([...hist,{role:"assistant",content:reply}]);
        setAiDisplay(d=>[...d,{role:"ai",text:reply}]);
      }
    } catch(e) {
      setAiDisplay(d=>[...d,{role:"ai",text:`Erreur réseau : ${e.message ?? "connexion impossible"}.`}]);
    }
    setBusy(false);
  },[input,busy,aiHistory,claudeKey,systemPrompt,setAiHistory,setAiDisplay]);

  const QUICK = [t("ai.q1"),t("ai.q2"),t("ai.q3"),t("ai.q4")];

  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", background:C.bg, minHeight:0 }}>
      <div style={{ padding:"9px 14px 7px", borderBottom:`1px solid ${C.border}`, flexShrink:0 }}>
        <div style={{ color:C.accent, fontSize:10, fontFamily:C.fnt, fontWeight:700, letterSpacing:2 }}>{t("ai.title")}</div>
        <div style={{ color:C.muted, fontSize:8, fontFamily:C.fnt }}>
          Claude · {stations.length} stations · {stations.some(s=>!s._mock)?t("ai.live"):t("station.simulated")}
        </div>
      </div>
      <div style={{ flex:1, overflowY:"auto", padding:"11px 14px", display:"flex", flexDirection:"column", gap:9 }}>
        {aiDisplay.map((m,i)=>(
          <div key={i} style={{ alignSelf:m.role==="user"?"flex-end":"flex-start", maxWidth:"88%" }}>
            {m.role==="ai"&&<div style={{ color:C.accent, fontSize:7, fontFamily:C.fnt, letterSpacing:2, marginBottom:3 }}>{t("ai.title")}</div>}
            <div style={{ background:m.role==="user"?C.accentBg:"rgba(255,255,255,0.04)",
              border:`1px solid ${m.role==="user"?C.accent+"55":C.border}`,
              borderRadius:m.role==="user"?"10px 10px 2px 10px":"10px 10px 10px 2px", padding:"9px 12px" }}>
              <div style={{ color:m.role==="user"?C.accent:C.text, fontSize:10, fontFamily:C.fnt, lineHeight:1.7, whiteSpace:"pre-wrap" }}>
                {m.text}
              </div>
            </div>
          </div>
        ))}
        {busy&&(
          <div style={{ alignSelf:"flex-start" }}>
            <div style={{ color:C.accent, fontSize:7, fontFamily:C.fnt, letterSpacing:2, marginBottom:3 }}>{t("ai.title")}</div>
            <div style={{ background:"rgba(255,255,255,0.04)", border:`1px solid ${C.border}`,
              borderRadius:"10px 10px 10px 2px", padding:"10px 14px", display:"flex", gap:6, alignItems:"center" }}>
              {[0,1,2].map(i=><div key={i} style={{ width:6,height:6,borderRadius:"50%",background:C.accent,opacity:0.7,transform:`scale(${i===1?1.2:0.8})` }}/>)}
              <span style={{ color:C.muted, fontSize:8, fontFamily:C.fnt, marginLeft:4 }}>en train de répondre…</span>
            </div>
          </div>
        )}
        <div ref={endRef}/>
      </div>
      <div style={{ display:"flex", gap:6, padding:"5px 14px 7px", overflowX:"auto", flexShrink:0 }}>
        {QUICK.map(q=>(
          <div key={q} onPointerDown={()=>sendText(q)} style={{ flexShrink:0, background:"transparent",
            border:`1px solid ${C.border}`, color:C.muted, borderRadius:14, padding:"4px 10px",
            fontSize:8, fontFamily:C.fnt, cursor:"pointer", whiteSpace:"nowrap" }}>{q}</div>
        ))}
      </div>
      <div style={{ display:"flex", gap:8, padding:"7px 14px 13px", borderTop:`1px solid ${C.border}`, flexShrink:0 }}>
        <input value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&sendText(input)}
          placeholder={t("ai.placeholder")}
          style={{ flex:1, background:"rgba(255,255,255,0.03)", border:`1px solid ${C.border}`,
            borderRadius:5, padding:"9px 11px", color:C.text, fontSize:10, fontFamily:C.fnt, outline:"none" }}/>
        <div onPointerDown={()=>sendText(input)} style={{
          background:busy?"rgba(255,255,255,0.04)":C.accentBg,
          border:`1px solid ${busy?C.border:C.accent}`, color:busy?C.muted:C.accent,
          borderRadius:5, padding:"9px 16px", fontSize:11, fontFamily:C.fnt, fontWeight:700, cursor:busy?"not-allowed":"pointer",
        }}>▶</div>
      </div>
    </div>
  );
}

// ── SETTINGS ──────────────────────────────────────────────────────

export default AIScreen;
