// Palette cyberpunk VelohNav
export const C = {
  bg:"#080c0f", border:"rgba(255,255,255,0.07)",
  accent:"#F5820D", accentBg:"rgba(245,130,13,0.12)",
  good:"#2ECC8F", warn:"#F5820D", bad:"#E03E3E",
  blue:"#3B82F6", text:"#E2E6EE", muted:"#4A5568",
  fnt:"'Courier New', monospace",
};
export const bCol = s => s.status==="CLOSED"?"#444":s.bikes===0?C.bad:s.bikes<=2?C.warn:C.good;
export const bTag = s => {
  if (s.status==="CLOSED") return "FERMÉ";
  if (s.bikes===0)         return "VIDE";
  if (s.bikes<=2)          return "FAIBLE";
  return "DISPO";
};
