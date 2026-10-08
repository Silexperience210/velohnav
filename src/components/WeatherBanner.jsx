import { useState } from "react";
import { t } from "../i18n.js";
import { Icon } from "../ui/icons.jsx";
import { Badge } from "../ui/primitives.jsx";
import { wmo, adviceView, reasonLabel } from "../ui/weather.js";
import { cardinal, fmtDist } from "../ui/format.js";

// Bannière météo compacte + conseil multimodal.
// Contrat de props inchangé (MapScreen l'utilise tel quel) :
//   weather  { temp, rain, wind, windDir, code }   — hooks/useWeather
//   advice   { mode: bike|mixed|transit, reason }  — getWeatherAdvice()
//   nearStop { name, type, lines[], distM, lat, lng } | null — utils.nearestStop()
//   station  { name } | null
// Nouveaux props optionnels : defaultExpanded (bool), style.
function WeatherBanner({ weather, advice, nearStop, station, defaultExpanded = false, style }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  if (!weather) return null;

  const w = wmo(weather.code);
  const adv = adviceView(advice);
  const reason = reasonLabel(advice?.reason);
  const dir = cardinal(weather.windDir);
  const toneColor = { good: "var(--vn-good)", warn: "var(--vn-warn)", transit: "var(--vn-transit)" }[adv.tone];
  const stopIcon = nearStop?.type === "tram" ? "tram" : "bus";
  const canExpand = adv.mode === "bike" || !!nearStop;

  return (
    <div className="vn-wx" style={{ marginTop: 10, ...style }}>
      <button type="button" className="vn-wx__main" aria-expanded={canExpand ? expanded : undefined}
        aria-label={t("ui.wx.details")} disabled={!canExpand} style={{ cursor: canExpand ? "pointer" : "default" }}
        onClick={() => setExpanded(e => !e)}>
        <span style={{ color: "var(--vn-text)", display: "flex" }}><Icon name={w.icon} size={26} stroke={1.6}/></span>
        <span className="vn-wx__temp">{weather.temp}°</span>
        <span style={{ minWidth: 0, flex: 1 }}>
          <span style={{ display: "block", fontSize: 13, fontWeight: 600, color: "var(--vn-text)" }}>{w.label}</span>
          <span className="vn-wx__metrics">
            <span className="vn-wx__metric" aria-label={t("ui.wx.wind_aria", { kmh: weather.wind, dir })}>
              <Icon name="navigation" size={12} stroke={2} style={{ transform: `rotate(${((weather.windDir ?? 0) + 180) % 360}deg)` }}/>
              {weather.wind} km/h {dir}
            </span>
            <span className="vn-wx__metric" aria-label={t("ui.wx.rain_aria", { mm: weather.rain })}
              style={weather.rain > 0 ? { color: "var(--vn-elec)" } : undefined}>
              <Icon name="droplet" size={12} stroke={2}/>{weather.rain} mm/h
            </span>
          </span>
        </span>
        {canExpand && <span className="vn-wx__chev"><Icon name="chevronDown" size={18}/></span>}
      </button>

      <div className="vn-wx__advice">
        <span style={{ color: toneColor, display: "flex" }}><Icon name={adv.icon} size={16}/></span>
        <span style={{ color: "var(--vn-text)", fontWeight: 600 }}>{adv.title}</span>
        {reason && <Badge tone={adv.tone} style={{ marginLeft: "auto" }}>{reason}</Badge>}
      </div>

      {expanded && canExpand && (
        <div className="vn-wx__detail">
          {adv.mode === "bike" && (
            <div style={{ fontSize: 13, color: "var(--vn-text2)", lineHeight: 1.5 }}>
              {t("ui.wx.bike_ok", { name: station?.name ?? t("ui.wx.this_station") })}
            </div>
          )}
          {adv.mode !== "bike" && nearStop && (
            <>
              <div style={{ fontSize: 13, color: "var(--vn-text2)", lineHeight: 1.5 }}>
                {t(adv.mode === "transit" ? "ui.wx.transit_desc" : "ui.wx.mixed_desc", { reason })}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: adv.mode === "mixed" ? "1fr 1fr" : "1fr", gap: 8 }}>
                {adv.mode === "mixed" && (
                  <div className="vn-card" style={{ padding: "10px 12px", borderColor: "rgba(245,130,13,0.3)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--vn-accent)", fontWeight: 600, fontSize: 13 }}>
                      <Icon name="bike" size={16}/>{t("ui.wx.bike_ok_short")}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--vn-text2)", marginTop: 4 }}>{t("ui.wx.bike_ok_sub")}</div>
                  </div>
                )}
                <a className="vn-card" href={`https://www.openstreetmap.org/?mlat=${nearStop.lat}&mlon=${nearStop.lng}#map=18/${nearStop.lat}/${nearStop.lng}`}
                  target="_blank" rel="noopener noreferrer"
                  style={{ padding: "10px 12px", textDecoration: "none", borderColor: "rgba(167,139,250,0.3)", display: "block" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--vn-transit)", fontWeight: 600, fontSize: 13 }}>
                    <Icon name={stopIcon} size={16}/>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{nearStop.name}</span>
                    <Icon name="external" size={13} style={{ marginLeft: "auto", color: "var(--vn-text3)" }}/>
                  </div>
                  <div className="vn-num" style={{ fontSize: 12, color: "var(--vn-text2)", marginTop: 4 }}>
                    {t("ui.wx.stop_meta", { lines: nearStop.lines.join(" · "), dist: fmtDist(nearStop.distM) })}
                  </div>
                </a>
              </div>
              {adv.mode === "transit" && (
                <div style={{ fontSize: 12, color: "var(--vn-text3)", lineHeight: 1.45 }}>{t("ui.wx.tip")}</div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default WeatherBanner;
