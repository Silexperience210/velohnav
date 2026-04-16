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

// ── Fischer Boulangerie — 63 points de vente (Lu + Fr) ────────────
// Source : fischer1913.com/fr-lu/boulangeries — géocodés via Nominatim
export const FISCHER_STORES = [
  // Luxembourg-Ville centre
  { name:"Fischer Gare",               addr:"28 Place de la Gare",         lat:49.59983, lng:6.13293 },
  { name:"Fischer Alima Gare",         addr:"1 Rue Charles VI",            lat:49.60438, lng:6.13495 },
  { name:"Fischer Place de Paris",     addr:"33 rue du Fort Elisabeth",    lat:49.60342, lng:6.13171 },
  { name:"Fischer Rue de Strasbourg",  addr:"33 rue de Strasbourg",        lat:49.60036, lng:6.12868 },
  { name:"Fischer Rue des Capucins",   addr:"15 rue des Capucins",         lat:49.61253, lng:6.12968 },
  { name:"Fischer Aldringen",          addr:"21 Avenue Monterey",          lat:49.61065, lng:6.12728 },
  { name:"Fischer Porte-Neuve",        addr:"11 Avenue de la Porte Neuve", lat:49.61267, lng:6.12739 },
  { name:"Fischer Place de l'Étoile",  addr:"56 Bd G.D. Charlotte",        lat:49.61180, lng:6.12350 },
  { name:"Fischer Av. X Septembre",    addr:"14 Av. du X Septembre",       lat:49.61040, lng:6.13280 },
  { name:"Fischer Glacis",             addr:"4 avenue Pasteur",            lat:49.61824, lng:6.12427 },
  { name:"Fischer Parking Bouillon",   addr:"60 rue de Bouillon",          lat:49.58805, lng:6.09357 },
  { name:"Fischer Bonnevoie",          addr:"117 Rue de Bonnevoie",        lat:49.59826, lng:6.13765 },
  { name:"Fischer Belair",             addr:"1 Rue Théodore Eberhardt",    lat:49.60890, lng:6.11940 },
  { name:"Fischer Centre Hospitalier", addr:"5 Rue Barblé",                lat:49.61868, lng:6.09734 },
  { name:"Fischer Cessange",           addr:"6 Rue de la Forêt",           lat:49.58939, lng:6.10613 },
  { name:"Fischer Gasperich",          addr:"16-18 Rue Robert Stumper",    lat:49.58148, lng:6.11762 },
  // Kirchberg
  { name:"Fischer BnL Kirchberg",      addr:"37D Av. John F. Kennedy",     lat:49.62976, lng:6.16524 },
  { name:"Fischer Kirchberg Pixel",    addr:"15 rue Edward Steichen",      lat:49.63123, lng:6.17342 },
  // Luxembourg périphérie
  { name:"Fischer Cents",              addr:"150 Route de Trèves",         lat:49.61600, lng:6.15800 },
  { name:"Fischer Strassen Pall",      addr:"237 route d'Arlon, Strassen", lat:49.62017, lng:6.06899 },
  { name:"Fischer Bertrange City",     addr:"80 Route de Longwy",          lat:49.60171, lng:6.06505 },
  { name:"Fischer Bereldange ACG",     addr:"107 Route de Luxembourg",     lat:49.65190, lng:6.12860 },
  { name:"Fischer Steinsel Pall",      addr:"6 Paul Eyschen, Steinsel",    lat:49.67743, lng:6.12536 },
  { name:"Fischer Münsbach",           addr:"237 Rue Principale",          lat:49.63366, lng:6.26669 },
  { name:"Fischer Contern",            addr:"11 Rue de Moutfort",          lat:49.59968, lng:6.25980 },
  { name:"Fischer Mensdorf",           addr:"Rue Strachen",                lat:49.62900, lng:6.30400 },
  // Sud
  { name:"Fischer Esch-sur-Alzette",   addr:"57 Rue de l'Alzette",         lat:49.49424, lng:5.98215 },
  { name:"Fischer Esch Gare",          addr:"54 Av. J.F. Kennedy, Esch",   lat:49.49500, lng:5.98400 },
  { name:"Fischer Belval Plaza",       addr:"7 Av. du Rock'nRoll, Esch",   lat:49.50600, lng:5.94500 },
  { name:"Fischer Differdange",        addr:"24 Av. de la Liberté",        lat:49.52396, lng:5.88913 },
  { name:"Fischer Gravity Differdange",addr:"4 rue John Ernest Dolibois",  lat:49.52000, lng:5.89500 },
  { name:"Fischer Niederkorn",         addr:"2 Rue de Longwy",             lat:49.52000, lng:5.88000 },
  { name:"Fischer Petange",            addr:"12 Route de Luxembourg",      lat:49.55700, lng:5.88100 },
  { name:"Fischer Soleuvre",           addr:"1 Place de l'Indépendance",   lat:49.50000, lng:5.91000 },
  { name:"Fischer Bascharage",         addr:"117 Av. de Luxembourg",       lat:49.56616, lng:5.90858 },
  { name:"Fischer Dudelange",          addr:"33 Place de l'Hôtel de ville",lat:49.47894, lng:6.08545 },
  { name:"Fischer CHEM Dudelange",     addr:"rue de l'Hôpital, Dudelange", lat:49.48200, lng:6.08000 },
  { name:"Fischer Rumelange",          addr:"23-27 Grand-Rue",             lat:49.46500, lng:6.02200 },
  { name:"Fischer Schifflange",        addr:"Z.A.E. Op Herbett",           lat:49.50500, lng:6.02000 },
  { name:"Fischer Mondercange",        addr:"Rue d'Ehlerange",             lat:49.52500, lng:5.96000 },
  { name:"Fischer Bettembourg",        addr:"23 route d'Esch",             lat:49.51789, lng:6.06747 },
  { name:"Fischer Globus Bettembourg", addr:"123 Z.A.E. Wolser A",         lat:49.51000, lng:6.05000 },
  { name:"Fischer Shopping Park Bett.",addr:"261 route de Luxembourg",     lat:49.52000, lng:6.04500 },
  { name:"Fischer Mondorf-les-Bains",  addr:"Av. Lou Hemmer",              lat:49.50559, lng:6.27630 },
  { name:"Fischer Frisange",           addr:"8 Rue de Luxembourg",         lat:49.51500, lng:6.15000 },
  { name:"Fischer Steinfort",          addr:"2A Rue Ermesinde",            lat:49.65930, lng:5.91821 },
  { name:"Fischer Bauhaus Capellen",   addr:"37-39 Parc Capelle",          lat:49.67000, lng:5.95000 },
  { name:"Fischer Oberpallen Pall",    addr:"2 Route d'Arlon, Oberpallen", lat:49.75000, lng:5.86000 },
  // Centre
  { name:"Fischer Mersch",             addr:"42 Rue G.D. Charlotte",       lat:49.75000, lng:6.09000 },
  { name:"Fischer Junglinster Globus", addr:"Z.I. Laangwiss",              lat:49.71300, lng:6.22100 },
  // Est
  { name:"Fischer Echternach",         addr:"38 rue de la Gare",           lat:49.81460, lng:6.41820 },
  { name:"Fischer Rewe Echternach",    addr:"121 Route de Luxembourg, Echt.",lat:49.80000, lng:6.40000 },
  { name:"Fischer Wasserbillig",       addr:"50 Grand-Rue",                lat:49.71500, lng:6.50000 },
  { name:"Fischer Larochette",         addr:"6 Place Bleiche",             lat:49.78500, lng:6.23000 },
  { name:"Fischer Contern",            addr:"11 Rue de Moutfort",          lat:49.59968, lng:6.25980 },
  // Nord
  { name:"Fischer Ettelbruck",         addr:"Place Marie Adélaïde",        lat:49.84590, lng:6.09784 },
  { name:"Fischer Ettelbruck Grand-Rue",addr:"55 Grand-Rue, Ettelbruck",   lat:49.84700, lng:6.09600 },
  { name:"Fischer Diekirch",           addr:"1 Grand-Rue",                 lat:49.84508, lng:6.09829 },
  { name:"Fischer Ingeldorf",          addr:"Rue du Cimetière, Ingeldorf", lat:49.87000, lng:6.21000 },
  { name:"Fischer Wiltz",              addr:"51 Grand-Rue",                lat:49.96497, lng:5.93576 },
  { name:"Fischer Marnach",            addr:"9 Marbuergerstrooss",         lat:50.05000, lng:6.05000 },
  { name:"Fischer Pommerloch",         addr:"19 Route de Bastogne",        lat:50.00000, lng:5.89000 },
  { name:"Fischer Pommerloch II",      addr:"26 Bastnicherstrooss",        lat:50.00200, lng:5.89200 },
  { name:"Fischer Schmiede Huldange",  addr:"3 Op d'Schmëtt",              lat:50.12000, lng:6.03000 },
  // France
  { name:"Fischer Manom",              addr:"Route de Mondorf, Manom FR",  lat:49.37000, lng:6.18000 },
  { name:"Fischer Maizières",          addr:"Sortie A31 N°35 Hauconcourt", lat:49.26000, lng:6.16000 },
];
