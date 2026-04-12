import { useState, useEffect, useCallback } from 'react';

export const THEMES = {
  DARK: 'dark',
  LIGHT: 'light',
  AUTO: 'auto',
};

// Couleurs pour chaque thème
export const THEME_COLORS = {
  dark: {
    bg: "#080c0f",
    card: "rgba(8,12,15,0.98)",
    border: "rgba(255,255,255,0.07)",
    accent: "#F5820D",
    accentBg: "rgba(245,130,13,0.12)",
    good: "#2ECC8F",
    warn: "#F5820D",
    bad: "#E03E3E",
    closed: "#444444",
    text: "#E2E6EE",
    muted: "#4A5568",
    grid: "rgba(245,130,13,0.03)",
    mapBg: "#0a1015",
    user: "#3B82F6",
  },
  light: {
    bg: "#f5f5f7",
    card: "rgba(255,255,255,0.98)",
    border: "rgba(0,0,0,0.08)",
    accent: "#E07000",
    accentBg: "rgba(224,112,0,0.1)",
    good: "#27AE60",
    warn: "#F39C12",
    bad: "#C0392B",
    closed: "#7f8c8d",
    text: "#1a1a1a",
    muted: "#666666",
    grid: "rgba(224,112,0,0.05)",
    mapBg: "#ffffff",
    user: "#2980B9",
  },
};

export function useTheme() {
  const [theme, setTheme] = useState(() => {
    // Récupérer depuis localStorage ou défaut
    if (typeof window !== 'undefined') {
      return localStorage.getItem('velohnav-theme') || THEMES.AUTO;
    }
    return THEMES.AUTO;
  });

  const [systemTheme, setSystemTheme] = useState(THEMES.DARK);

  // Détecter le thème système
  useEffect(() => {
    if (typeof window === 'undefined') return;
    
    const mediaQuery = window.matchMedia('(prefers-color-scheme: light)');
    setSystemTheme(mediaQuery.matches ? THEMES.LIGHT : THEMES.DARK);
    
    const handler = (e) => setSystemTheme(e.matches ? THEMES.LIGHT : THEMES.DARK);
    mediaQuery.addEventListener('change', handler);
    
    return () => mediaQuery.removeEventListener('change', handler);
  }, []);

  // Sauvegarder le choix
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('velohnav-theme', theme);
    }
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme(prev => {
      if (prev === THEMES.DARK) return THEMES.LIGHT;
      if (prev === THEMES.LIGHT) return THEMES.AUTO;
      return THEMES.DARK;
    });
  }, []);

  const activeTheme = theme === THEMES.AUTO ? systemTheme : theme;
  const colors = THEME_COLORS[activeTheme];
  const isDark = activeTheme === THEMES.DARK;

  return {
    theme,
    setTheme,
    activeTheme,
    toggleTheme,
    colors,
    isDark,
    THEMES,
  };
}
