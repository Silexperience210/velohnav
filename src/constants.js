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
  { id:"T01", name:"Luxexpo",            lat:49.6267, lng:6.1651, lines:["T1"],         type:"tram" },
  { id:"T02", name:"Kirchberg P+R",      lat:49.6248, lng:6.1588, lines:["T1"],         type:"tram" },
  { id:"T03", name:"Philharmonie MUDAM", lat:49.6219, lng:6.1520, lines:["T1"],         type:"tram" },
  { id:"T04", name:"Européen",           lat:49.6183, lng:6.1432, lines:["T1"],         type:"tram" },
  { id:"T05", name:"Alphonse Weicker",   lat:49.6154, lng:6.1378, lines:["T1"],         type:"tram" },
  { id:"T06", name:"Hamilius",           lat:49.6118, lng:6.1299, lines:["T1","1","2"], type:"tram" },
  { id:"T07", name:"Place de Paris",     lat:49.6073, lng:6.1285, lines:["T1","16"],    type:"tram" },
  { id:"T08", name:"Stade de Lux.",      lat:49.6019, lng:6.1260, lines:["T1"],         type:"tram" },
  { id:"T09", name:"Lycée Bouneweg",     lat:49.5979, lng:6.1252, lines:["T1"],         type:"tram" },
  { id:"T10", name:"Gare Centrale",      lat:49.5998, lng:6.1340, lines:["T1","bus"],   type:"tram" },
  { id:"B01", name:"Gare Routière",      lat:49.6005, lng:6.1320, lines:["1","2","3","4","5","16","18"],type:"bus" },
  { id:"B02", name:"Cloche d'Or",        lat:49.5817, lng:6.1333, lines:["1","25"],     type:"bus" },
  { id:"B03", name:"Limpertsberg",       lat:49.6153, lng:6.1243, lines:["3","4"],      type:"bus" },
  { id:"B04", name:"Belair Résidence",   lat:49.6092, lng:6.1175, lines:["5"],          type:"bus" },
  { id:"B05", name:"Clausen Bierger",    lat:49.6107, lng:6.1442, lines:["9"],          type:"bus" },
  { id:"B06", name:"Bonnevoie Hollerich",lat:49.5948, lng:6.1322, lines:["2"],          type:"bus" },
  { id:"B07", name:"Merl Betzenberg",    lat:49.6078, lng:6.1082, lines:["6"],          type:"bus" },
  { id:"B08", name:"Cents Schleed",      lat:49.6152, lng:6.1624, lines:["14"],         type:"bus" },
  { id:"B09", name:"Kirchberg Campus",   lat:49.6196, lng:6.1558, lines:["27"],         type:"bus" },
  { id:"B10", name:"Grund Pfaffenthal",  lat:49.6082, lng:6.1394, lines:["9"],          type:"bus" },
  { id:"B11", name:"Verlorenkost",       lat:49.6133, lng:6.1205, lines:["4"],          type:"bus" },
  { id:"B12", name:"Cessange",           lat:49.5905, lng:6.1204, lines:["1","4"],      type:"bus" },
];
