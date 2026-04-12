import { useMemo } from 'react';

/**
 * Carte vectorielle minimaliste des quartiers de Luxembourg-ville
 * Style "tech/cyberpunk" avec contours simplifiés
 */

const C = {
  bg: "#080c0f",
  water: "rgba(59,130,246,0.15)",
  park: "rgba(46,204,143,0.08)",
  district: "rgba(255,255,255,0.03)",
  districtStroke: "rgba(255,255,255,0.08)",
  districtHover: "rgba(245,130,13,0.1)",
  mainRoad: "rgba(255,255,255,0.12)",
  secondaryRoad: "rgba(255,255,255,0.05)",
  text: "rgba(255,255,255,0.3)",
};

// Quartiers de Luxembourg avec coordonnées approximatives (normalisées 0-100)
const DISTRICTS = [
  {
    id: 'ville-haute',
    name: 'Ville Haute',
    path: 'M45,35 L55,32 L58,40 L52,48 L42,45 Z',
    center: { x: 50, y: 40 },
  },
  {
    id: 'grund',
    name: 'Grund',
    path: 'M48,50 L58,48 L62,58 L55,65 L45,60 Z',
    center: { x: 53, y: 55 },
  },
  {
    id: 'gare',
    name: 'Gare',
    path: 'M35,45 L45,42 L48,52 L40,58 L32,55 Z',
    center: { x: 40, y: 50 },
  },
  {
    id: 'kirchberg',
    name: 'Kirchberg',
    path: 'M60,25 L75,22 L78,35 L70,42 L58,38 Z',
    center: { x: 68, y: 32 },
  },
  {
    id: 'belair',
    name: 'Belair',
    path: 'M25,35 L38,32 L42,42 L35,48 L22,45 Z',
    center: { x: 32, y: 40 },
  },
  {
    id: 'limpertsberg',
    name: 'Limpertsberg',
    path: 'M55,20 L68,18 L72,28 L62,32 L52,28 Z',
    center: { x: 62, y: 25 },
  },
  {
    id: 'bonnevoie',
    name: 'Bonnevoie',
    path: 'M40,62 L52,60 L58,72 L48,80 L35,75 Z',
    center: { x: 47, y: 70 },
  },
  {
    id: 'merl',
    name: 'Merl',
    path: 'M15,45 L28,42 L32,55 L25,62 L12,58 Z',
    center: { x: 22, y: 52 },
  },
  {
    id: 'rollingergrund',
    name: 'Rollingergrund',
    path: 'M28,25 L42,22 L45,32 L38,38 L25,35 Z',
    center: { x: 35, y: 30 },
  },
  {
    id: 'weimerskirch',
    name: 'Weimerskirch',
    path: 'M65,15 L78,12 L82,22 L72,26 L62,22 Z',
    center: { x: 72, y: 20 },
  },
  {
    id: 'hamm',
    name: 'Hamm',
    path: 'M65,55 L78,52 L82,65 L72,72 L62,65 Z',
    center: { x: 72, y: 62 },
  },
  {
    id: 'cents',
    name: 'Cents',
    path: 'M75,45 L88,42 L92,55 L82,62 L72,55 Z',
    center: { x: 82, y: 52 },
  },
];

// Routes principales (lignes simplifiées)
const MAIN_ROADS = [
  // Boulevard Royal (est-ouest centre)
  { x1: 20, y1: 40, x2: 75, y2: 35 },
  // Avenue de la Liberté (nord-sud)
  { x1: 40, y1: 20, x2: 45, y2: 75 },
  // Route d'Esch (sud-ouest)
  { x1: 15, y1: 55, x2: 45, y2: 75 },
  // Pont Adolphe
  { x1: 45, y1: 48, x2: 55, y2: 52 },
  // Avenue Kennedy (Kirchberg)
  { x1: 60, y1: 25, x2: 78, y2: 30 },
];

// La Pétrusse (rivière)
const RIVERS = [
  'M42,45 Q45,55 48,65 T55,75',
];

// Zones vertes (parcs)
const PARKS = [
  // Pétrusse
  { cx: 35, cy: 50, rx: 8, ry: 12 },
  // Ed Klein
  { cx: 68, cy: 30, rx: 6, ry: 8 },
];

export function LuxembourgVectorMap({ 
  colors = C, 
  hoveredDistrict,
  onDistrictHover,
  onDistrictClick,
  showLabels = true,
}) {
  const themeColors = useMemo(() => ({ ...C, ...colors }), [colors]);

  return (
    <svg
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none', // Les clics passent à travers
      }}
      viewBox="0 0 100 100"
      preserveAspectRatio="xMidYMid slice"
    >
      {/* Fond eau (Alzette, Pétrusse) */}
      <g opacity="0.3">
        {RIVERS.map((path, i) => (
          <path
            key={i}
            d={path}
            fill="none"
            stroke={themeColors.water}
            strokeWidth="2"
            strokeLinecap="round"
          />
        ))}
      </g>

      {/* Zones vertes */}
      <g opacity="0.4">
        {PARKS.map((park, i) => (
          <ellipse
            key={i}
            cx={park.cx}
            cy={park.cy}
            rx={park.rx}
            ry={park.ry}
            fill={themeColors.park}
          />
        ))}
      </g>

      {/* Quartiers */}
      <g>
        {DISTRICTS.map((district) => {
          const isHovered = hoveredDistrict === district.id;
          return (
            <g key={district.id}>
              <path
                d={district.path}
                fill={isHovered ? themeColors.districtHover : themeColors.district}
                stroke={isHovered ? themeColors.accent : themeColors.districtStroke}
                strokeWidth={isHovered ? 0.8 : 0.3}
                style={{
                  transition: 'all 0.3s ease',
                  cursor: onDistrictClick ? 'pointer' : 'default',
                  pointerEvents: onDistrictClick ? 'auto' : 'none',
                }}
                onMouseEnter={() => onDistrictHover?.(district.id)}
                onMouseLeave={() => onDistrictHover?.(null)}
                onClick={() => onDistrictClick?.(district)}
              />
              
              {/* Labels des quartiers */}
              {showLabels && (
                <text
                  x={district.center.x}
                  y={district.center.y}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fill={isHovered ? themeColors.accent : themeColors.text}
                  fontSize="2.5"
                  fontFamily="'Courier New', monospace"
                  fontWeight={isHovered ? 700 : 500}
                  letterSpacing="0.3"
                  style={{
                    transition: 'all 0.3s ease',
                    pointerEvents: 'none',
                    textShadow: `0 1px 2px ${themeColors.bg}`,
                  }}
                >
                  {district.name.toUpperCase()}
                </text>
              )}
            </g>
          );
        })}
      </g>

      {/* Routes principales */}
      <g opacity="0.5">
        {MAIN_ROADS.map((road, i) => (
          <line
            key={i}
            x1={road.x1}
            y1={road.y1}
            x2={road.x2}
            y2={road.y2}
            stroke={themeColors.mainRoad}
            strokeWidth="0.5"
            strokeDasharray="2 1"
          />
        ))}
      </g>

      {/* Points d'intérêt marquants */}
      <g>
        {/* Gare Centrale */}
        <circle cx="40" cy="50" r="1.5" fill={themeColors.accent} opacity="0.6">
          <animate attributeName="r" values="1.5;2;1.5" dur="2s" repeatCount="indefinite" />
        </circle>
        
        {/* Centre historique */}
        <circle cx="50" cy="40" r="1" fill={themeColors.good} opacity="0.5" />
        
        {/* Européen (Kirchberg) */}
        <circle cx="68" cy="32" r="1.2" fill={themeColors.blue} opacity="0.5" />
      </g>

      {/* Bordure de la ville */}
      <rect
        x="5"
        y="5"
        width="90"
        height="90"
        fill="none"
        stroke={themeColors.districtStroke}
        strokeWidth="0.5"
        strokeDasharray="4 2"
        opacity="0.3"
        rx="5"
      />

      {/* Légende minimaliste */}
      <g transform="translate(5, 92)" opacity="0.6">
        <circle cx="2" cy="0" r="1.5" fill={themeColors.accent} />
        <text x="6" y="0.5" fill={themeColors.text} fontSize="2.5" fontFamily="'Courier New', monospace">
          GARE
        </text>
        
        <circle cx="25" cy="0" r="1.2" fill={themeColors.good} />
        <text x="29" y="0.5" fill={themeColors.text} fontSize="2.5" fontFamily="'Courier New', monospace">
          CENTRE
        </text>
        
        <circle cx="52" cy="0" r="1.2" fill={themeColors.blue} />
        <text x="56" y="0.5" fill={themeColors.text} fontSize="2.5" fontFamily="'Courier New', monospace">
          EUROPÉEN
        </text>
      </g>
    </svg>
  );
}

// Version ultra-minimaliste (juste les contours)
export function LuxembourgMinimalMap({ colors = C }) {
  const themeColors = useMemo(() => ({ ...C, ...colors }), [colors]);

  return (
    <svg
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        opacity: 0.4,
      }}
      viewBox="0 0 100 100"
      preserveAspectRatio="xMidYMid slice"
    >
      {/* Juste les contours des quartiers */}
      <g fill="none" stroke={themeColors.districtStroke} strokeWidth="0.2">
        {DISTRICTS.map((district) => (
          <path key={district.id} d={district.path} />
        ))}
      </g>

      {/* Routes principales uniquement */}
      <g stroke={themeColors.mainRoad} strokeWidth="0.3" opacity="0.5">
        {MAIN_ROADS.map((road, i) => (
          <line
            key={i}
            x1={road.x1}
            y1={road.y1}
            x2={road.x2}
            y2={road.y2}
          />
        ))}
      </g>

      {/* Eau */}
      <g fill="none" stroke={themeColors.water} strokeWidth="1" opacity="0.3">
        {RIVERS.map((path, i) => (
          <path key={i} d={path} />
        ))}
      </g>
    </svg>
  );
}
