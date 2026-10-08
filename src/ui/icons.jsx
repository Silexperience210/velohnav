// ── VelohNav v4 — jeu d'icônes SVG inline ───────────────────────────
// Grille 24×24, trait 1.75, extrémités arrondies, couleur = currentColor.
// Aucune dépendance, aucun emoji. Usage : <Icon name="bike" size={18}/>
// Les icônes sont décoratives par défaut (aria-hidden) ; passer `label`
// pour une icône porteuse de sens (role="img" + <title>).

const P = {
  // Mobilité
  bike: <><circle cx="5.5" cy="16.5" r="3.5"/><circle cx="18.5" cy="16.5" r="3.5"/><path d="M5.5 16.5 9 9h6l3.5 7.5M9 9 7.5 6H6m6 10.5L15 9m-1.5-3H16"/></>,
  ebike: <><circle cx="5.5" cy="16.5" r="3.5"/><circle cx="18.5" cy="16.5" r="3.5"/><path d="M5.5 16.5 9 9h4m-4 0L7.5 6H6m12.5 10.5L16 11"/><path d="m17 3-2.5 4h3L15 11" strokeWidth="1.6"/></>,
  dock: <><rect x="4" y="3" width="16" height="18" rx="3"/><path d="M10 16V8h2.75a2.25 2.25 0 0 1 0 4.5H10"/></>,
  walk: <><circle cx="13" cy="4.5" r="1.75"/><path d="m9 21 2.5-6.5L14 17v4m-6.5-9 2-3.5 4 .5 2 3.5 2.5 1M11.5 14.5 12.5 9"/></>,
  bus: <><rect x="4" y="3" width="16" height="15" rx="3"/><path d="M4 11h16M8 18v2.5M16 18v2.5M8 14.5h.01M16 14.5h.01M9 6.5h6"/></>,
  tram: <><rect x="5" y="5" width="14" height="13" rx="3"/><path d="M9 2.5h6M12 2.5V5M5 12h14M9 15h.01M15 15h.01M8 18l-2 3.5M16 18l2 3.5"/></>,
  route: <><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M8 19h8.5a3.5 3.5 0 0 0 0-7h-9a3.5 3.5 0 0 1 0-7H16"/></>,
  navigation: <path d="M12 2.5 19.5 21 12 17l-7.5 4L12 2.5Z"/>,
  pin: <><path d="M12 21.5s-7-6.1-7-11.5a7 7 0 0 1 14 0c0 5.4-7 11.5-7 11.5Z"/><circle cx="12" cy="10" r="2.5"/></>,
  locate: <><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></>,
  compass: <><circle cx="12" cy="12" r="9.5"/><path d="m15.5 8.5-2 5-5 2 2-5 5-2Z"/></>,
  ar: <><path d="M3 8V5.5A2.5 2.5 0 0 1 5.5 3H8M16 3h2.5A2.5 2.5 0 0 1 21 5.5V8M21 16v2.5a2.5 2.5 0 0 1-2.5 2.5H16M8 21H5.5A2.5 2.5 0 0 1 3 18.5V16"/><path d="m12 7 4.5 2.5v5L12 17l-4.5-2.5v-5L12 7Zm0 5 4.5-2.5M12 12v5m0-5L7.5 9.5"/></>,
  map: <><path d="M9 4 3.5 6v14L9 18l6 2 5.5-2V4L15 6 9 4Z"/><path d="M9 4v14M15 6v14"/></>,
  ai: <><path d="M12 3.5 13.6 8a2 2 0 0 0 1.3 1.3l4.6 1.6-4.6 1.6a2 2 0 0 0-1.3 1.3L12 18.5l-1.6-4.6a2 2 0 0 0-1.3-1.3L4.5 10.9l4.6-1.6A2 2 0 0 0 10.4 8L12 3.5Z"/><path d="M19 3v3m-1.5-1.5h3M5 18v2.5m-1.25-1.25h2.5"/></>,
  sliders: <><path d="M4 7h9m4 0h3M4 17h3m4 0h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></>,
  // Actions
  search: <><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></>,
  x: <path d="M6 6l12 12M18 6 6 18"/>,
  check: <path d="m5 12.5 4.5 4.5L19 7.5"/>,
  chevronDown: <path d="m6 9 6 6 6-6"/>,
  chevronRight: <path d="m9 6 6 6-6 6"/>,
  arrowUp: <path d="M12 19V5m-6 6 6-6 6 6"/>,
  arrowRight: <path d="M5 12h14m-6-6 6 6-6 6"/>,
  send: <path d="M4.5 12 20 4.5 15.5 20l-3.5-6.5L4.5 12Zm7.5 1.5 3.5-3.5"/>,
  refresh: <><path d="M20 11a8 8 0 0 0-14.3-4.9L4 8m0-4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16m0 4v-4h-4"/></>,
  external: <path d="M14 4h6v6m0-6-9 9M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>,
  play: <path d="M7 4.5v15l12-7.5-12-7.5Z"/>,
  stop: <rect x="6" y="6" width="12" height="12" rx="2"/>,
  layers: <><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/></>,
  // Navigation (manœuvres)
  turnLeft: <path d="M16 20v-7a4 4 0 0 0-4-4H5m4-4L5 9l4 4"/>,
  turnRight: <path d="M8 20v-7a4 4 0 0 1 4-4h7m-4-4 4 4-4 4"/>,
  sharpLeft: <path d="M17 20V9.5L7 18.5m0-6v6h6"/>,
  sharpRight: <path d="M7 20V9.5l10 9m0-6v6h-6"/>,
  straight: <path d="M12 20V4m-6 6 6-6 6 6"/>,
  uturn: <path d="M8 20V9a4 4 0 0 1 8 0v7m-4-4 4 4 4-4"/>,
  flag: <path d="M5 21V4m0 0h11l-2 4 2 4H5"/>,
  // État / système
  gps: <><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="7.5" strokeDasharray="2 3"/></>,
  satellite: <><path d="m13 7 4-4 4 4-4 4M7 13l-4 4 4 4 4-4M9 9l6 6M8.5 15.5 15.5 8.5"/><path d="M14.5 21a6.5 6.5 0 0 0 6.5-6.5M14.5 17.5a3 3 0 0 0 3-3"/></>,
  wifi: <path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.5 16a5 5 0 0 1 7 0M12 19.5h.01"/>,
  wifiOff: <path d="M3 3l18 18M8.5 16a5 5 0 0 1 7 0M5.5 12.5a9.5 9.5 0 0 1 4.3-2.3M14.2 10.2a9.5 9.5 0 0 1 4.3 2.3M2.5 9a14 14 0 0 1 4-2.7M10.6 5.1A14 14 0 0 1 21.5 9M12 19.5h.01"/>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  alert: <><path d="M12 3.5 21.5 20h-19L12 3.5Z"/><path d="M12 10v4.5M12 17.5h.01"/></>,
  info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.5h.01"/></>,
  shield: <path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.1 7.5 9.5 4.3-1.4 7.5-4.9 7.5-9.5V6L12 3Z"/>,
  key: <><circle cx="8" cy="15" r="4"/><path d="m11 12 9-9m-4 4 3 3m-5-1 2 2"/></>,
  globe: <><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z"/></>,
  headphones: <path d="M4 15v-3a8 8 0 0 1 16 0v3M4 15a2 2 0 0 1 2-2h1v7H6a2 2 0 0 1-2-2v-3Zm16 0a2 2 0 0 0-2-2h-1v7h1a2 2 0 0 0 2-2v-3Z"/>,
  cpu: <><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9.5 9.5h5v5h-5zM9 2.5V6m6-3.5V6M9 18v3.5m6-3.5v3.5M2.5 9H6m-3.5 6H6m12-6h3.5M18 15h3.5"/></>,
  battery: <><rect x="3" y="7" width="16" height="10" rx="2"/><path d="M21 10.5v3"/><path d="m11.5 8.5-2 3.5h3l-2 3.5" strokeWidth="1.5"/></>,
  megaphone: <path d="M4 10v4a1 1 0 0 0 1 1h2l6 4V5L7 9H5a1 1 0 0 0-1 1Zm13-1.5a5 5 0 0 1 0 7"/>,
  code: <path d="m8 7-5 5 5 5m8-10 5 5-5 5M14 4l-4 16"/>,
  // Météo
  sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/></>,
  cloudSun: <><path d="M8 4.5V3M3.5 9H2M4.8 5.8 3.7 4.7M12.3 5.8l1.1-1.1"/><path d="M5.2 11.4A3.5 3.5 0 0 1 11.6 8"/><path d="M8 20h9a4 4 0 1 0-.9-7.9A5.5 5.5 0 0 0 5.6 14 3 3 0 0 0 8 20Z"/></>,
  cloud: <path d="M7 19h10.5a4.5 4.5 0 1 0-1-8.9A6 6 0 0 0 5 12a3.5 3.5 0 0 0 2 7Z"/>,
  fog: <path d="M7 14h10.5a4.5 4.5 0 1 0-1-8.9A6 6 0 0 0 5 7M3 18h18M6 21.5h12"/>,
  rain: <><path d="M7 15h10.5a4.5 4.5 0 1 0-1-8.9A6 6 0 0 0 5 8a3.5 3.5 0 0 0 2 7Z"/><path d="m8 18-1 3m5-3-1 3m5-3-1 3"/></>,
  snow: <><path d="M7 15h10.5a4.5 4.5 0 1 0-1-8.9A6 6 0 0 0 5 8a3.5 3.5 0 0 0 2 7Z"/><path d="M8 19h.01M12 18h.01M16 19h.01M10 21.5h.01M14 21.5h.01"/></>,
  storm: <><path d="M7 15h10.5a4.5 4.5 0 1 0-1-8.9A6 6 0 0 0 5 8a3.5 3.5 0 0 0 2 7Z"/><path d="m13 14-2.5 4h3L11 22"/></>,
  wind: <path d="M3 8.5h10.5a2.5 2.5 0 1 0-2.5-2.5M3 12.5h15a3 3 0 1 1-3 3M3 16.5h7"/>,
  droplet: <path d="M12 3s6 6.3 6 11a6 6 0 0 1-12 0c0-4.7 6-11 6-11Z"/>,
  thermo: <path d="M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0ZM12 17.5v-6"/>,
  // Lightning
  bolt: <path d="M13.5 2.5 5 13.5h6l-1 8 8.5-11h-6l1-8Z"/>,
};

export const ICON_NAMES = Object.keys(P);

export function Icon({ name, size = 20, stroke = 1.75, label, style, className = "" }) {
  const body = P[name];
  if (!body) return null;
  const a11y = label ? { role: "img", "aria-label": label } : { "aria-hidden": true, focusable: "false" };
  return (
    <svg className={`vn-icon ${className}`} width={size} height={size} viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round"
      style={style} {...a11y}>
      {label && <title>{label}</title>}
      {body}
    </svg>
  );
}

// Logo VelohNav — roue stylisée traversée d'un éclair (seul glyphe « marque »).
export function LogoMark({ size = 22 }) {
  return (
    <svg className="vn-brand__mark" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <linearGradient id="vn-logo-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#FFB04A"/><stop offset="1" stopColor="#FF4A1C"/>
        </linearGradient>
      </defs>
      <circle cx="12" cy="12" r="9.25" fill="none" stroke="url(#vn-logo-g)" strokeWidth="2"/>
      <path d="M13.2 5.5 8 13h3.6l-.8 5.5L16 11h-3.6l.8-5.5Z" fill="url(#vn-logo-g)"/>
    </svg>
  );
}
