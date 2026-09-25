import type { Config } from 'tailwindcss';
import { alerte, brand, danger, ink, navy, succes } from './lib/couleurs';

// Design system Engage Me. Les valeurs vivent dans `lib/couleurs.ts` (le canevas de scénario les lit aussi) :
// `brand` = seul accent, `ink` = neutres navy-tintés, `danger` / `alerte` / `succes` = une teinte par état.
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    /**
     * TROIS RAYONS, ET AUCUN AUTRE N'EST GÉNÉRÉ. Le thème est REMPLACÉ, pas étendu : `rounded-lg`, `rounded-2xl`
     * ou `rounded` tout court ne produisent plus rien, et `tests/web-formes.test.ts` refuse qu'on les écrive.
     * La console en portait six (4, 6, 8, 12, 16 px et la pilule), choisis à la main d'un écran à l'autre.
     * - `controle` : ce qu'on manipule (bouton, champ, menu, onglet, étiquette).
     * - `carte` : ce qui contient (carte, panneau, modale, bulle de message).
     * - `full` : la pilule et le rond (pastille d'état, avatar, interrupteur).
     * Un contrôle posé dans une carte a un rayon plus petit qu'elle : les deux courbes restent parallèles.
     */
    borderRadius: {
      none: '0',
      controle: '0.375rem',
      carte: '0.625rem',
      full: '9999px',
    },
    extend: {
      /**
       * DEUX LARGEURS DE CONTENU. Six coexistaient (`max-w-2xl` à `max-w-7xl`) : une page sautait de largeur en
       * changeant d'onglet. `liste` pour ce qui aligne des colonnes (tableaux, cartes en grille, écrans denses),
       * `formulaire` pour ce qui se lit et se remplit de haut en bas (réglages, un seul formulaire).
       */
      maxWidth: {
        liste: '72rem',
        formulaire: '48rem',
      },
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
