// Utilitaires géographiques — VelohNav
export function haversine(la1,ln1,la2,ln2) {
  const R=6371000,dL=(la2-la1)*Math.PI/180,dl=(ln2-ln1)*Math.PI/180;
  const a=Math.sin(dL/2)**2+Math.cos(la1*Math.PI/180)*Math.cos(la2*Math.PI/180)*Math.sin(dl/2)**2;
  return Math.round(R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a)));
}
export function getBearing(la1,ln1,la2,ln2){
  const φ1=la1*Math.PI/180,φ2=la2*Math.PI/180,Δλ=(ln2-ln1)*Math.PI/180;
  const y=Math.sin(Δλ)*Math.cos(φ2);
  const x=Math.cos(φ1)*Math.sin(φ2)-Math.sin(φ1)*Math.cos(φ2)*Math.cos(Δλ);
  return(Math.atan2(y,x)*180/Math.PI+360)%360;
}
export const fDist = m => m<1000 ? `${m}m` : `${(m/1000).toFixed(1)}km`;
export const fWalk = m => m < 40 ? "< 1 min" : `${Math.ceil(m/80)} min`;
