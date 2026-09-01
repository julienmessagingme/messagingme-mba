import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Les chemins PUBLICS servis par l'API à travers le front.
 *
 * L'API n'a AUCUN port hôte publié : le proxy ne route que `mba-web`. Ces quatre rewrites sont donc le seul
 * chemin qui relie le monde extérieur au backend, et deux d'entre eux voyagent déjà dans des messages
 * livrés (`/r/:code` dans un lien tracé, `/m/:fichier` dans un visuel RCS). En perdre un ne casse pas un
 * écran : ça casse des liens qu'on ne peut plus corriger, et une intégration tierce déjà branchée.
 *
 * 🔴 Ces rewrites sont GELÉS AU BUILD de l'image web. Ce test ne remplace pas la règle de déploiement
 * (`up -d --build` dès que ce fichier bouge, cf. CLAUDE.md) : il empêche seulement qu'une ligne disparaisse
 * d'un refactor sans que personne ne le voie avant la production.
 */
const config = readFileSync(new URL('../web/next.config.mjs', import.meta.url), 'utf8');

describe('rewrites du front vers l’API', () => {
  const attendus = [
    { source: '/api/backend/:path*', pourquoi: 'toute la console' },
    { source: '/r/:code', pourquoi: 'liens tracés DÉJÀ livrés dans des messages' },
    { source: '/m/:fichier', pourquoi: 'visuels RCS DÉJÀ envoyés' },
    { source: '/mcp', pourquoi: 'serveur MCP, adresse donnée aux intégrateurs' },
  ];

  for (const { source, pourquoi } of attendus) {
    it(`🔴 « ${source} » est routé vers le backend (${pourquoi})`, () => {
      expect(config, `rewrite « ${source} » manquant`).toContain(`source: '${source}'`);
    });
  }
});
