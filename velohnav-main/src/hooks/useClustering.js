import { useMemo } from 'react';

/**
 * Regroupe les stations proches en clusters
 * @param {Array} stations - Liste des stations
 * @param {number} zoom - Niveau de zoom (0-20)
 * @param {Object} bounds - Bounds de la carte {minLat, maxLat, minLng, maxLng}
 */
export function useClustering(stations, zoom, bounds) {
  return useMemo(() => {
    if (!stations.length || !bounds) return [];
    
    // Seuil de clustering basé sur le zoom
    // Plus on est zoomé, moins on cluster
    const clusterThreshold = Math.max(0.001, 0.02 / Math.pow(2, zoom / 5));
    
    const clusters = [];
    const processed = new Set();
    
    stations.forEach((station, idx) => {
      if (processed.has(idx)) return;
      
      // Trouver toutes les stations proches
      const cluster = {
        id: `cluster-${idx}`,
        lat: station.lat,
        lng: station.lng,
        stations: [station],
        center: { lat: station.lat, lng: station.lng },
        isCluster: false,
      };
      
      stations.forEach((other, otherIdx) => {
        if (idx === otherIdx || processed.has(otherIdx)) return;
        
        const dist = Math.sqrt(
          Math.pow(station.lat - other.lat, 2) + 
          Math.pow(station.lng - other.lng, 2)
        );
        
        if (dist < clusterThreshold) {
          cluster.stations.push(other);
          processed.add(otherIdx);
          
          // Recalculer le centre
          cluster.center.lat = cluster.stations.reduce((sum, s) => sum + s.lat, 0) / cluster.stations.length;
          cluster.center.lng = cluster.stations.reduce((sum, s) => sum + s.lng, 0) / cluster.stations.length;
        }
      });
      
      cluster.isCluster = cluster.stations.length > 1;
      cluster.id = cluster.isCluster ? `cluster-${idx}` : station.id;
      clusters.push(cluster);
      processed.add(idx);
    });
    
    return clusters;
  }, [stations, zoom, bounds]);
}

/**
 * Calcule le niveau de zoom optimal pour voir tous les points
 */
export function getOptimalZoom(stations, containerWidth, containerHeight) {
  if (!stations.length) return 15;
  
  const lats = stations.map(s => s.lat);
  const lngs = stations.map(s => s.lng);
  
  const latRange = Math.max(...lats) - Math.min(...lats);
  const lngRange = Math.max(...lngs) - Math.min(...lngs);
  
  // Approximation simple
  const zoomLat = Math.log2(containerHeight / (latRange * 100000));
  const zoomLng = Math.log2(containerWidth / (lngRange * 100000));
  
  return Math.min(18, Math.max(12, Math.floor(Math.min(zoomLat, zoomLng))));
}
