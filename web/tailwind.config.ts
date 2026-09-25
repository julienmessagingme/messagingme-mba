import type { Config } from 'tailwindcss';
import { alerte, brand, danger, ink, navy, succes } from './lib/couleurs';

// Design system Engage Me. Les valeurs vivent dans `lib/couleurs.ts` (le canevas de scénario les lit aussi) :
// `brand` = seul accent, `ink` = neutres navy-tintés, `danger` / `alerte` / `succes` = une teinte par état.
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand,
        navy,
        ink,
        danger,
        alerte,
        succes,
        // Couleur de SÉRIE des graphiques (la part « IA » d'une répartition) : une information, pas un décor.
        // Elle n'a pas d'échelle, et `tests/web-palette-tailwind.test.ts` garde qu'on ne lui en demande pas.
        violet: '#6E5AE0',
        // Un seul fond de page, pour la coquille comme pour les écrans hors coquille.
        surface: { DEFAULT: '#FFFFFF', subtle: '#F7F9FC' },
      },
      fontFamily: {
        sans: ['var(--font-geist-sans)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-geist-mono)', 'ui-monospace', 'monospace'],
      },
      // Réservées à ce qui FLOTTE (menus, modales, popovers) : une carte posée dans la page n'a qu'une bordure.
      boxShadow: {
        'mm-sm': '0 1px 3px rgba(11,27,43,0.08), 0 1px 2px rgba(11,27,43,0.04)',
        'mm-md': '0 4px 14px rgba(11,27,43,0.08), 0 2px 4px rgba(11,27,43,0.04)',
        'mm-lg': '0 12px 28px rgba(11,27,43,0.12), 0 4px 8px rgba(11,27,43,0.05)',
      },
    },
  },
  plugins: [],
};

export default config;
