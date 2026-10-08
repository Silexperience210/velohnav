// ── VelohNav v4 — design tokens ─────────────────────────────────────
// Source unique des valeurs de design. Les mêmes valeurs existent en
// variables CSS (--vn-*) dans ui.css : les composants utilisent les
// classes CSS ; ce module sert aux styles dynamiques (couleur selon l'état
// d'une station, canvas, SVG) et aux tests de contraste.
//
// Contraste (WCAG, sur bg #07090B) : text 17.6:1 · text2 9.3:1 · text3 5.6:1
// → tout texte informatif est ≥ 4.5:1 (l'ancien muted #4A5568 était à 2.6:1).

export const color = {
  bg:        "#07090B",   // fond app — noir profond
  surface1:  "#0D1014",   // cartes, barres
  surface2:  "#13171C",   // champs, éléments surélevés
  surface3:  "#1B2027",   // hover / pressed
  border:    "rgba(255,255,255,0.08)",
  borderStrong: "rgba(255,255,255,0.14)",

  text:      "#ECEFF4",   // texte principal
  text2:     "#A9B1BD",   // texte secondaire
  text3:     "#808A99",   // légendes, métadonnées (≥ 4.5:1)

  accent:    "#F5820D",   // orange VelohNav (identité existante)
  accentHot: "#FF4A1C",   // rouge-orange — dégradés, alertes de marque
  accentInk: "#140A02",   // texte posé sur l'accent
  accentSoft:"rgba(245,130,13,0.14)",

  good:      "#2ECC8F",   // dispo / succès
  warn:      "#F2B33D",   // faible / attention (distinct de l'accent)
  bad:       "#F0524A",   // vide / erreur
  closed:    "#5C6573",   // station fermée
  elec:      "#5AA9FF",   // vélos électriques
  transit:   "#A78BFA",   // bus / tram
  user:      "#F5F7FA",   // position utilisateur
  sats:      "#FFC53D",   // ⚡ Lightning — or chaud
};

export const space = { 0:0, 1:2, 2:4, 3:6, 4:8, 5:12, 6:16, 7:20, 8:24, 9:32, 10:40 };
export const radius = { xs:4, sm:6, md:8, lg:12, xl:16, pill:999 };

export const font = {
  sans: `system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", "Helvetica Neue", Arial, sans-serif`,
  mono: `ui-monospace, "SF Mono", "JetBrains Mono", "Roboto Mono", "DejaVu Sans Mono", Menlo, Consolas, monospace`,
};
// Échelle typographique (px) — 11 est le minimum absolu (eyebrows en capitales).
export const text = { xs:11, sm:12, md:13, base:14, lg:16, xl:20, xxl:26, hero:34 };

export const shadow = {
  sm:   "0 1px 2px rgba(0,0,0,0.5)",
  md:   "0 6px 20px rgba(0,0,0,0.45)",
  sheet:"0 -12px 40px rgba(0,0,0,0.6)",
  glow: c => `0 0 0 1px ${c}33, 0 0 16px ${c}33`,
};

export const duration = { fast:120, base:180, slow:260, sheet:320 };
export const easing = {
  out:   "cubic-bezier(0.2, 0.8, 0.2, 1)",   // sortie nette, sans rebond
  inOut: "cubic-bezier(0.4, 0, 0.2, 1)",
};

export const z = { map:0, overlay:10, chrome:20, sheet:40, header:50, toast:80, modal:90 };

// Taille de cible tactile minimale (WCAG 2.5.5 / Material).
export const HIT = 44;

// ── Contraste WCAG ───────────────────────────────────────────────────
function lum(hex) {
  const n = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map(i => parseInt(n.slice(i, i + 2), 16) / 255)
    .map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** Rapport de contraste entre deux couleurs hexadécimales (#RRGGBB). */
export function contrast(a, b) {
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}
