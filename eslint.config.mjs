// Une seule règle, et elle vient d'une panne : le 2026-10-21, des méthodes de `PgUserStore` recopiées dans un objet
// (`{ getByEmail: deps.comptes.getByEmail }`) ont perdu leur `this`, et la connexion Google a rendu 500 pendant 19 h.
// Ni le compilateur ni des tests montés sur des objets littéraux ne pouvaient le voir. Les tests restent dehors :
// `expect(faux.methode)` y est l'usage normal.
// Les cas d'avant la règle (tous vérifiés : des fermetures sans `this`) sont gelés dans `eslint-suppressions.json` :
// seul un cas NOUVEAU fait échouer `npm run lint`, que la CI lance.
import tseslint from 'typescript-eslint';

export default tseslint.config({
  files: ['src/**/*.ts', 'db/**/*.ts'],
  languageOptions: { parser: tseslint.parser, parserOptions: { projectService: true } },
  linterOptions: { reportUnusedDisableDirectives: 'off' },
  plugins: { '@typescript-eslint': tseslint.plugin },
  rules: { '@typescript-eslint/unbound-method': 'error' },
});
