import { useState, useMemo } from 'react';

export const FILTER_MODES = {
  ALL: 'all',
  AVAILABLE: 'available',
  ELECTRIC: 'electric',
  NEARBY: 'nearby',
};

export function useMapFilters(stations, userPos) {
  const [activeFilter, setActiveFilter] = useState(FILTER_MODES.ALL);
  const [nearbyRadius, setNearbyRadius] = useState(500); // metres

  const filteredStations = useMemo(() => {
    switch (activeFilter) {
      case FILTER_MODES.AVAILABLE:
        return stations.filter(s => s.bikes > 0 && s.status === 'OPEN');
      
      case FILTER_MODES.ELECTRIC:
        return stations.filter(s => s.elec > 0);
      
      case FILTER_MODES.NEARBY:
        if (!userPos) return stations;
        return stations.filter(s => s.dist <= nearbyRadius);
      
      case FILTER_MODES.ALL:
      default:
        return stations;
    }
  }, [stations, activeFilter, nearbyRadius, userPos]);

  const counts = useMemo(() => ({
    all: stations.length,
    available: stations.filter(s => s.bikes > 0 && s.status === 'OPEN').length,
    electric: stations.filter(s => s.elec > 0).length,
    nearby: userPos ? stations.filter(s => s.dist <= nearbyRadius).length : stations.length,
  }), [stations, nearbyRadius, userPos]);

  return {
    activeFilter,
    setActiveFilter,
    nearbyRadius,
    setNearbyRadius,
    filteredStations,
    counts,
    FILTER_MODES,
  };
}
