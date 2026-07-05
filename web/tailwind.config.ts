import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eef4ff',
          100: '#d9e6ff',
          500: '#3b6cf6',
          600: '#2f57d6',
          700: '#2745ab',
        },
      },
    },
  },
  plugins: [],
};

export default config;
