import { THEMES } from '../hooks/useTheme';

export function ThemeToggle({ theme, toggleTheme, isDark, colors }) {
  const icons = {
    [THEMES.DARK]: '🌙',
    [THEMES.LIGHT]: '☀️',
    [THEMES.AUTO]: '◐',
  };

  const labels = {
    [THEMES.DARK]: 'Sombre',
    [THEMES.LIGHT]: 'Clair',
    [THEMES.AUTO]: 'Auto',
  };

  return (
    <button
      onPointerDown={toggleTheme}
      style={{
        position: 'absolute',
        top: 50,
        right: 10,
        width: 40,
        height: 40,
        background: colors.card,
        border: `1px solid ${colors.border}`,
        borderRadius: '50%',
        fontSize: 18,
        cursor: 'pointer',
        zIndex: 25,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
      }}
      title={`Thème: ${labels[theme]}`}
    >
      {icons[theme]}
    </button>
  );
}
