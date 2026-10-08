// ── ⚡ Lightning — héros visuel de la récompense en sats ─────────────
// L'éclair se « trace » (stroke-dashoffset), se remplit, puis émet une
// lueur qui retombe. Un seul balayage lumineux traverse la carte. Pas de
// confettis, pas de rebond : un geste net, une fois.
import { useEffect, useState } from "react";
import { Icon } from "./icons.jsx";
import { Spinner } from "./primitives.jsx";
import { t } from "../i18n.js";

export function LightningBolt({ size = 32, strike = true }) {
  return (
    <svg className={`vn-bolt ${strike ? "vn-bolt--strike" : "vn-bolt--idle"}`} width={size} height={size}
      viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <linearGradient id="vn-bolt-g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FFE08A"/><stop offset="0.55" stopColor="#FFC53D"/><stop offset="1" stopColor="#F5820D"/>
        </linearGradient>
        <filter id="vn-bolt-blur" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="2.4"/></filter>
      </defs>
      <path className="vn-bolt__glow" d="M13.5 2.5 5 13.5h6l-1 8 8.5-11h-6l1-8Z" fill="#FFB020" filter="url(#vn-bolt-blur)"/>
      <path className="vn-bolt__fill" d="M13.5 2.5 5 13.5h6l-1 8 8.5-11h-6l1-8Z" fill="url(#vn-bolt-g)"/>
      <path className="vn-bolt__path" d="M13.5 2.5 5 13.5h6l-1 8 8.5-11h-6l1-8Z" fill="none"
        stroke="#FFE08A" strokeWidth="1.2" strokeLinejoin="round" pathLength="64"/>
    </svg>
  );
}

/** Compte de 0 → n en ~600 ms (ease-out), valeur finale immédiate si animations réduites. */
export function useCountUp(n, ms = 600) {
  const [v, setV] = useState(0);
  useEffect(() => {
    if (typeof window === "undefined" || !window.requestAnimationFrame) { setV(n); return; }
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    if (reduce) { setV(n); return; }
    let raf, start;
    const step = ts => {
      start ??= ts;
      const p = Math.min(1, (ts - start) / ms);
      setV(Math.round(n * (1 - (1 - p) ** 3)));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [n, ms]);
  return v;
}

/**
 * SatsReward — carte de récompense.
 * state : "sending" (paiement LNURL en cours) | "sent" (⚡ héros) | "error"
 */
export function SatsReward({ amount, state = "sent", detail, onClose }) {
  const shown = useCountUp(state === "sent" ? amount : 0);
  return (
    <div className="vn-sats" role="status" aria-live="polite">
      <div style={{ width: 40, height: 40, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        {state === "sending" ? <span style={{ color: "var(--vn-sats)" }}><Spinner size={22}/></span>
          : state === "error" ? <span style={{ color: "var(--vn-bad)" }}><Icon name="alert" size={22}/></span>
          : <LightningBolt size={34}/>}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        {state === "sent" ? (
          <div className="vn-sats__amount">+{shown}<span className="vn-sats__unit">SATS</span></div>
        ) : (
          <div style={{ fontSize: 14, fontWeight: 600, color: state === "error" ? "var(--vn-bad)" : "var(--vn-text)" }}>
            {state === "sending" ? t("ui.sats.sending", { n: amount }) : t("ui.sats.failed")}
          </div>
        )}
        {detail && <div style={{ fontSize: 12, color: "var(--vn-text2)", marginTop: 2 }}>{detail}</div>}
      </div>
      {onClose && (
        <button type="button" className="vn-iconbtn vn-iconbtn--sm" aria-label={t("ui.close")} onClick={onClose}>
          <Icon name="x" size={16}/>
        </button>
      )}
    </div>
  );
}
