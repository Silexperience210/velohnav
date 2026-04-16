// VelohNav — constantes globales (design, données, configuration)
// ─────────────────────────────────────────────────────────────────

export const C = {
  bg:"#080c0f", border:"rgba(255,255,255,0.07)",
  accent:"#F5820D", accentBg:"rgba(245,130,13,0.12)",
  good:"#2ECC8F", warn:"#F5820D", bad:"#E03E3E",
  blue:"#3B82F6", text:"#E2E6EE", muted:"#4A5568",
  fnt:"'Courier New', monospace",
};

export const REF = { lat:49.6080, lng:6.1295 };

export const FALLBACK = [
  { id:1,  name:"Gare Centrale",       lat:49.59995, lng:6.13385, cap:20, b:7, e:5 },
  { id:4,  name:"Place d'Armes",       lat:49.61118, lng:6.13091, cap:15, b:5, e:4 },
  { id:2,  name:"Hamilius",             lat:49.61143, lng:6.12975, cap:25, b:2, e:1 },
  { id:7,  name:"Clausen",              lat:49.61021, lng:6.14437, cap:12, b:4, e:3 },
  { id:14, name:"Kirchberg MUDAM",      lat:49.61921, lng:6.15178, cap:22, b:9, e:7 },
  { id:21, name:"Limpertsberg",         lat:49.61571, lng:6.12462, cap:20, b:3, e:2 },
  { id:33, name:"Bonnevoie",            lat:49.59650, lng:6.13750, cap:18, b:0, e:0 },
  { id:45, name:"Belair",               lat:49.60890, lng:6.11940, cap:16, b:6, e:4 },
].map(s=>({ id:s.id, name:s.name, lat:s.lat, lng:s.lng, cap:s.cap,
  bikes:s.b, elec:s.e, meca:0, docks:s.cap-s.b,
  status:s.b===0&&s.id===33?"CLOSED":"OPEN", _mock:true }));

export const COMPASS_LABELS = ["N","NE","E","SE","S","SO","O","NO"];
export const FOV = 68;

export const WMO_LABEL = {
  0:"Ciel clair", 1:"Peu nuageux", 2:"Partiellement nuageux", 3:"Couvert",
  45:"Brouillard", 48:"Brouillard givrant",
  51:"Bruine légère", 53:"Bruine modérée", 55:"Bruine dense",
  61:"Pluie légère", 63:"Pluie modérée", 65:"Pluie forte",
  71:"Neige légère", 73:"Neige modérée", 75:"Neige forte",
  80:"Averses légères", 81:"Averses modérées", 82:"Averses violentes",
  85:"Averses de neige légères", 86:"Averses de neige fortes",
  95:"Orage", 96:"Orage avec grêle", 99:"Orage violent avec grêle",
};
export const WMO_ICON = {
  0:"☀️", 1:"🌤", 2:"⛅", 3:"☁️", 45:"🌫", 48:"🌫",
  51:"🌦", 53:"🌦", 55:"🌧", 61:"🌧", 63:"🌧", 65:"🌧",
  71:"🌨", 73:"❄️", 75:"❄️", 80:"🌦", 81:"🌧", 82:"⛈",
  85:"🌨", 86:"❄️", 95:"⛈", 96:"⛈", 99:"⛈",
};

export const TRANSIT_STOPS = [
  // ── Ligne T1 Luxtram — 24 arrêts complets (Findel → Gasperich/Stadion) ──
  // Horaires : 04h20→00h06 (vers Stadion) | 04h00→23h17 (vers Findel) — tous les jours
  // Fréquence : 3-4 min (LuxExpo↔Lycée Bouneweg) | 8 min (vers Findel/Stadion) | 15 min heures creuses
  // Gratuit depuis mars 2020 — 16 km — 10 hubs d'interconnexion

  // Kirchberg & Findel (nord-est)
  { id:"T01", name:"Findel / Aéroport",      lat:49.6308, lng:6.2073, lines:["T1"],                    veloh:false, hub:true  },
  { id:"T02", name:"Héienhaff P+R",          lat:49.6280, lng:6.1980, lines:["T1"],                    veloh:false, hub:false },
  { id:"T03", name:"Luxexpo",                lat:49.6267, lng:6.1651, lines:["T1","bus"],               veloh:true,  hub:true  },
  { id:"T04", name:"Alphonse Weicker",       lat:49.6225, lng:6.1570, lines:["T1"],                    veloh:false, hub:false },
  { id:"T05", name:"Nationalbibliothéik",    lat:49.6200, lng:6.1518, lines:["T1"],                    veloh:false, hub:false },
  { id:"T06", name:"Universitéit",           lat:49.6180, lng:6.1472, lines:["T1"],                    veloh:false, hub:false },
  { id:"T07", name:"Coque",                  lat:49.6161, lng:6.1432, lines:["T1"],                    veloh:false, hub:false },
  { id:"T08", name:"Parlement Européen",     lat:49.6142, lng:6.1408, lines:["T1"],                    veloh:true,  hub:false },
  { id:"T09", name:"Philharmonie / MUDAM",   lat:49.6127, lng:6.1378, lines:["T1"],                    veloh:true,  hub:false },
  // Pont Rouge → Centre-Ville
  { id:"T10", name:"Rout Bréck / Pafendall", lat:49.6112, lng:6.1340, lines:["T1","funiculaire","CFL"],veloh:true,  hub:true  },
  { id:"T11", name:"Théâter",                lat:49.6127, lng:6.1280, lines:["T1"],                    veloh:true,  hub:false },
  { id:"T12", name:"Faïencerie",             lat:49.6138, lng:6.1262, lines:["T1"],                    veloh:false, hub:false },
  { id:"T13", name:"Place de l'Étoile",      lat:49.6118, lng:6.1235, lines:["T1","bus"],              veloh:true,  hub:true  },
  { id:"T14", name:"Hamilius",               lat:49.6118, lng:6.1299, lines:["T1","1","2","4","16"],   veloh:true,  hub:true  },
  // Gare → Bonnevoie
  { id:"T15", name:"Paräisserplatz",         lat:49.6073, lng:6.1285, lines:["T1"],                    veloh:true,  hub:false },
  { id:"T16", name:"Gare Centrale",          lat:49.5998, lng:6.1340, lines:["T1","bus","CFL"],        veloh:true,  hub:true  },
  { id:"T17", name:"Lycée Bouneweg",         lat:49.5965, lng:6.1330, lines:["T1"],                    veloh:false, hub:false },
  // Cloche d'Or → Gasperich
  { id:"T18", name:"Hollerich",              lat:49.5935, lng:6.1295, lines:["T1"],                    veloh:false, hub:false },
  { id:"T19", name:"Howald",                 lat:49.5900, lng:6.1265, lines:["T1","CFL"],              veloh:false, hub:true  },
  { id:"T20", name:"Cloche d'Or",            lat:49.5840, lng:6.1230, lines:["T1","bus"],              veloh:false, hub:true  },
  { id:"T21", name:"Lycée Vauban",           lat:49.5812, lng:6.1195, lines:["T1"],                    veloh:false, hub:false },
  { id:"T22", name:"Gasperich Q.",           lat:49.5785, lng:6.1178, lines:["T1"],                    veloh:false, hub:false },
  { id:"T23", name:"Gasperich / Stadion",    lat:49.5748, lng:6.1152, lines:["T1","bus"],              veloh:false, hub:true  },
];
