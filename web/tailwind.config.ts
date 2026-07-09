import type { Config } from 'tailwindcss';

// Design system MM Business Agent (tokens colors_and_type.css). `brand` = bleu MM (accent
// primaire), `ink` = neutres navy-tintés, `navy` = marque foncée, + accents sémantiques.
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#E0F2FF',
          100: '#B8E0FF',
          200: '#6FC2FE',
          300: '#33ABFE',
          400: '#009AFE',
          500: '#0080D6',
          600: '#0066AA',
          700: '#004E82',
          800: '#003559',
          900: '#001E33',
        },
        navy: {
          50: '#EEEFF5',
          100: '#D4D7E4',
          200: '#A8ADC8',
          300: '#6E76A1',
          400: '#424A7A',
          500: '#2B3162',
          600: '#202550',
          700: '#181C40',
          800: '#10132E',
          900: '#080A1C',
        },
        ink: {
          50: '#F4F5F9',
          100: '#E7E9F0',
          200: '#D0D3E1',
          300: '#A6ABC6',
          400: '#7379A0',
          500: '#4A507A',
          600: '#2C3360',
          700: '#1E2349',
          800: '#131735',
          900: '#0B0E24',
        },
        mint: {
          50: '#E7FBEC',
          100: '#C2F4CE',
          200: '#8AE7A0',
          300: '#4ED777',
          400: '#17C74E',
          500: '#12A641',
          600: '#0E8334',
          700: '#0A6527',
        },
        gold: '#E5A53B',
        coral: '#E4604A',
        sky: '#3A8BD8',
        violet: '#6E5AE0',
        surface: { DEFAULT: '#FFFFFF', 2: '#F4F7FA', subtle: '#F7F9FC', muted: '#EEF2F7' },
      },
      fontFamily: {
        sans: ['var(--font-pjs)', 'Plus Jakarta Sans', 'Inter', 'system-ui', 'sans-serif'],
      },
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
