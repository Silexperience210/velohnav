import { useState, useEffect, useRef } from "react";
import { t, useI18n } from "../i18n.js";
import { version } from "../../package.json";
import { isSentryConfigured, getSentryEnabled, setSentryEnabled } from "../sentry.js";
import { Icon } from "../ui/icons.jsx";
import { Badge, Button, Card, Field, Input, Row, Section, SegmentedControl, Switch } from "../ui/primitives.jsx";
import { fmtAgo, positioning } from "../ui/format.js";

const LN_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// État de feedback éphémère d'un bouton : idle → success|error → idle
function useFlash(ms = 1600) {
  const [state, setState] = useState("idle");
  const timer = useRef();
  useEffect(() => () => clearTimeout(timer.current), []);
  const flash = s => { setState(s); clearTimeout(timer.current); timer.current = setTimeout(() => setState("idle"), ms); };
  return [state, flash];
}

// Clé API optionnelle : brouillon local, appliquée au clic (feedback direct).
function KeyField({ label, hint, value, onApply, placeholder }) {
  const [draft, setDraft] = useState(value || "");
  const [state, flash] = useFlash();
  useEffect(() => { setDraft(value || ""); }, [value]);
  const dirty = draft.trim() !== (value || "");
  return (
    <Field label={<span style={{ display: "flex", alignItems: "center", gap: 6 }}>
      {label}<Badge tone={value ? "good" : "neutral"}>{value ? t("ui.set.key_on") : t("ui.set.key_off")}</Badge></span>}
      hint={hint}>
      {a11y => (
        <div style={{ display: "flex", gap: 8 }}>
          <Input {...a11y} mono type="password" autoComplete="off" spellCheck={false}
            value={draft} placeholder={placeholder} onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && dirty) { onApply(draft.trim()); flash("success"); } }}/>
          <Button variant={dirty ? "primary" : "secondary"} state={state} disabled={!dirty && state === "idle"}
            onClick={() => { onApply(draft.trim()); flash("success"); }}>
            {state === "success" ? t("ui.set.saved") : t("ui.set.apply")}
          </Button>
        </div>
      )}
    </Field>
  );
}

function SettingsScreen({ apiKey, setApiKey, onRefresh, refreshing = false, apiLive, isMock, gpsPos,
                          lnAddr, setLnAddr, lnOn, setLnOn, ads, setAds, mapsKey, setMapsKey,
                          hafasKey = "", setHafasKey, spatialAudio = false, setSpatialAudio = () => {},
                          lastUpdate = null, stationCount = 0, online = true }) {
  const { lang, setLanguage } = useI18n();
  const [advanced, setAdvanced] = useState(false);
  const [sentryOn, setSentryOn] = useState(getSentryEnabled);
  const sentryReady = isSentryConfigured();

  // Lightning : brouillon validé avant enregistrement (une adresse invalide n'est jamais persistée)
  const [lnDraft, setLnDraft] = useState(lnAddr || "");
  const [lnError, setLnError] = useState("");
  const [lnState, flashLn] = useFlash();
  useEffect(() => { setLnDraft(lnAddr || ""); }, [lnAddr]);
  const saveLn = () => {
    const addr = lnDraft.trim();
    if (addr && !LN_RE.test(addr)) { setLnError(t("ui.set.ln_invalid")); flashLn("error"); return; }
    setLnError(""); setLnAddr(addr); flashLn("success");
  };

  const pos = positioning(gpsPos ? "gps" : "none", gpsPos?.acc ?? null);
  const src = !online ? "offline" : apiLive ? "live" : isMock ? "demo" : "cache";
  const srcTone = { live: "good", demo: "warn", cache: "accent", offline: "warn" }[src];

  return (
    <div className="vn-scroll" style={{ flex: 1, minHeight: 0, paddingBottom: 24 }}>

      {/* ── État ─────────────────────────────────────────────── */}
      <Section title={t("ui.set.status")} id="set-status">
        <Card pad={false}>
          <Row icon="gps" iconColor={gpsPos ? "var(--vn-good)" : undefined} title={t("ui.set.gps")}
            sub={gpsPos
              ? <span className="vn-num vn-mono" style={{ fontSize: 12 }}>{gpsPos.lat.toFixed(5)}, {gpsPos.lng.toFixed(5)}</span>
              : t("ui.set.gps_wait")}
            right={<Badge tone={pos.tone}>{gpsPos ? `±${gpsPos.acc} m` : "—"}</Badge>}/>
          <Row icon="layers" title={t("ui.set.data")}
            sub={<>
              <Badge tone={srcTone} style={{ marginRight: 6 }}>{t(`ui.data.${src}`)}</Badge>
              <span className="vn-num">{stationCount} stations · {t("ui.updated", { ago: fmtAgo(lastUpdate) })}</span>
            </>}
            right={<Button size="sm" icon="refresh" loading={refreshing} onClick={onRefresh}>{t("ui.set.refresh")}</Button>}/>
        </Card>
      </Section>

      {/* ── Récompenses Lightning ───────────────────────────── */}
      <Section title={t("ui.set.rewards")} id="set-ln">
        <Card pad={false}>
          <Row icon="bolt" iconColor="var(--vn-sats)" title={t("ui.set.ln_on")} sub={t("ui.set.ln_on_sub")}
            right={<Switch checked={lnOn} onChange={setLnOn} label={t("ui.set.ln_on")}/>}/>
          {lnOn && (
            <div style={{ padding: "4px 14px 14px", borderTop: "1px solid var(--vn-border)" }}>
              <Field label={t("ui.set.ln_addr")} hint={t("ui.set.ln_hint")} error={lnError}>
                {a11y => (
                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <Input {...a11y} mono type="email" inputMode="email" autoComplete="off" spellCheck={false}
                      placeholder="vous@getalby.com" value={lnDraft}
                      onChange={e => { setLnDraft(e.target.value); setLnError(""); }}
                      onKeyDown={e => e.key === "Enter" && saveLn()}
                      style={{ color: "var(--vn-sats)" }}/>
                    <Button variant={lnDraft.trim() !== (lnAddr || "") ? "primary" : "secondary"} state={lnState} onClick={saveLn}>
                      {lnState === "success" ? t("ui.set.saved") : t("ui.set.save")}
                    </Button>
                  </div>
                )}
              </Field>
            </div>
          )}
        </Card>
      </Section>

      {/* ── Navigation ──────────────────────────────────────── */}
      <Section title={t("ui.set.nav")} id="set-nav">
        <Card pad={false}>
          <Row icon="headphones" title={t("ui.set.audio")} sub={t("ui.set.audio_sub")}
            right={<Switch checked={spatialAudio} onChange={setSpatialAudio} label={t("ui.set.audio")}/>}/>
          <Row icon="megaphone" title={t("ui.set.ads")} sub={t("ui.set.ads_sub")}
            right={<Switch checked={ads} onChange={setAds} label={t("ui.set.ads")}/>}/>
        </Card>
      </Section>

      {/* ── Langue ──────────────────────────────────────────── */}
      <Section title={t("ui.set.lang")} id="set-lang">
        <Card>
          <SegmentedControl label={t("ui.set.lang")} value={lang} onChange={setLanguage}
            options={[{ value: "fr", label: "Français" }, { value: "en", label: "English" }]}/>
          <div className="vn-field__hint" style={{ marginTop: 8 }}>{t("ui.set.lang_sub")}</div>
        </Card>
      </Section>

      {/* ── Confidentialité ─────────────────────────────────── */}
      <Section title={t("ui.set.privacy")} id="set-privacy">
        <Card pad={false}>
          <Row icon="shield" title={t("ui.set.sentry")}
            sub={sentryReady ? t("ui.set.sentry_sub") : t("ui.set.sentry_na")}
            right={<Switch checked={sentryReady && sentryOn} disabled={!sentryReady} label={t("ui.set.sentry")}
              onChange={v => { setSentryOn(v); setSentryEnabled(v); }}/>}/>
          <Row icon="cpu" iconColor="var(--vn-good)" title={t("ui.set.ai_local")} sub={t("ui.set.ai_local_sub")}/>
        </Card>
      </Section>

      {/* ── Avancé / optionnel ──────────────────────────────── */}
      <Section title={t("ui.set.advanced")} id="set-adv">
        <Card pad={false}>
          <button type="button" className="vn-row vn-row--btn" aria-expanded={advanced} aria-controls="set-adv-body"
            onClick={() => setAdvanced(a => !a)}>
            <span className="vn-row__icon"><Icon name="key" size={16}/></span>
            <span className="vn-row__body">
              <span className="vn-row__title" style={{ display: "block" }}>{t("ui.set.advanced")}</span>
              <span className="vn-row__sub" style={{ display: "block" }}>{t("ui.set.advanced_sub")}</span>
            </span>
            <span style={{ color: "var(--vn-text3)", transition: "transform 180ms", transform: advanced ? "rotate(180deg)" : "none" }}>
              <Icon name="chevronDown" size={18}/>
            </span>
          </button>
          {advanced && (
            <div id="set-adv-body" style={{ padding: "4px 14px 16px", display: "flex", flexDirection: "column", gap: 16,
              borderTop: "1px solid var(--vn-border)", paddingTop: 14 }}>
              <KeyField label={t("ui.set.jcd")} hint={t("ui.set.jcd_hint")} value={apiKey} placeholder="••••••••"
                onApply={v => { setApiKey(v); setTimeout(() => onRefresh?.(), 300); }}/>
              <KeyField label={t("ui.set.maps")} hint={t("ui.set.maps_hint")} value={mapsKey} placeholder="AIza…"
                onApply={v => setMapsKey?.(v)}/>
              <KeyField label={t("ui.set.hafas")} hint={t("ui.set.hafas_hint")} value={hafasKey}
                placeholder="xxxxxxxx-xxxx-…" onApply={v => setHafasKey?.(v)}/>
            </div>
          )}
        </Card>
      </Section>

      {/* ── À propos ────────────────────────────────────────── */}
      <Section title={t("ui.set.about")} id="set-about">
        <Card pad={false}>
          <Row icon="code" title={t("ui.set.version")}
            right={<span className="vn-mono vn-num" style={{ fontSize: 13, color: "var(--vn-text2)" }}>v{version}</span>}/>
          <div style={{ padding: "12px 14px 14px", borderTop: "1px solid var(--vn-border)" }}>
            <div className="vn-eyebrow" style={{ marginBottom: 8 }}>{t("ui.set.licenses")}</div>
            <ul style={{ listStyle: "none", display: "flex", flexDirection: "column", gap: 6 }}>
              {["osm", "ofm", "maplibre", "transitous", "meteo", "qwen", "veloh"].map(k => (
                <li key={k} style={{ display: "flex", gap: 8, fontSize: 12, color: "var(--vn-text2)", lineHeight: 1.45 }}>
                  <span style={{ color: "var(--vn-text3)", marginTop: 1 }}><Icon name="chevronRight" size={12} stroke={2}/></span>
                  {t(`ui.lic.${k}`)}
                </li>
              ))}
            </ul>
          </div>
        </Card>
      </Section>
    </div>
  );
}

export default SettingsScreen;
