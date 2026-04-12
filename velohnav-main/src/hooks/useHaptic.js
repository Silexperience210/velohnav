import { useCallback } from 'react';

// Détection Capacitor
const IS_NATIVE = typeof window !== "undefined" &&
  !!(window.Capacitor?.isNativePlatform?.() || window.Capacitor?.platform === "android");

/**
 * Hook pour le feedback haptic (vibrations)
 * Fonctionne sur mobile natif (Capacitor) et web (Vibration API)
 */
export function useHaptic() {
  
  const vibrate = useCallback(async (pattern = 50) => {
    try {
      // Essayer Capacitor d'abord (meilleure intégration)
      if (IS_NATIVE) {
        const { Haptics } = await import('@capacitor/haptics');
        await Haptics.vibrate({ duration: pattern });
        return;
      }
      
      // Fallback Web API
      if (navigator.vibrate) {
        navigator.vibrate(pattern);
      }
    } catch (e) {
      console.warn('Haptic not available:', e);
    }
  }, []);

  const lightImpact = useCallback(async () => {
    if (!IS_NATIVE) {
      vibrate(10);
      return;
    }
    try {
      const { Haptics } = await import('@capacitor/haptics');
      await Haptics.impact({ style: 'LIGHT' });
    } catch {
      vibrate(10);
    }
  }, [vibrate]);

  const mediumImpact = useCallback(async () => {
    if (!IS_NATIVE) {
      vibrate(50);
      return;
    }
    try {
      const { Haptics } = await import('@capacitor/haptics');
      await Haptics.impact({ style: 'MEDIUM' });
    } catch {
      vibrate(50);
    }
  }, [vibrate]);

  const heavyImpact = useCallback(async () => {
    if (!IS_NATIVE) {
      vibrate(100);
      return;
    }
    try {
      const { Haptics } = await import('@capacitor/haptics');
      await Haptics.impact({ style: 'HEAVY' });
    } catch {
      vibrate(100);
    }
  }, [vibrate]);

  const notification = useCallback(async (type = 'SUCCESS') => {
    if (!IS_NATIVE) {
      // Pattern: court, pause, court pour succès
      // Pattern: long pour erreur
      vibrate(type === 'SUCCESS' ? [30, 50, 30] : 200);
      return;
    }
    try {
      const { Haptics } = await import('@capacitor/haptics');
      await Haptics.notification({ type });
    } catch {
      vibrate(type === 'SUCCESS' ? [30, 50, 30] : 200);
    }
  }, [vibrate]);

  // Vibration spéciale quand on est proche d'une station
  const proximityAlert = useCallback(async (distance) => {
    if (distance < 50) {
      await heavyImpact();
    } else if (distance < 100) {
      await mediumImpact();
    } else if (distance < 200) {
      await lightImpact();
    }
  }, [lightImpact, mediumImpact, heavyImpact]);

  return {
    vibrate,
    lightImpact,
    mediumImpact,
    heavyImpact,
    notification,
    proximityAlert,
    isSupported: IS_NATIVE || !!navigator.vibrate,
  };
}
