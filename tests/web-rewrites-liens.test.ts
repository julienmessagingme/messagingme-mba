import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * PARITÉ entre les routes publiques du backend et les rewrites de Next.
 *
 * 🔴 POURQUOI CE TEST EXISTE : un défaut PARTI EN PRODUCTION le 2026-09-02. Le lot d'attribution des clics a
 * monté `GET /r/:code/:jeton` côté API et soumis à Meta des templates portant `/r/<code>/{{1}}`, mais le
 * rewrite de Next ne couvrait que `/r/:code`. Or un rewrite Next ne capture QU'UN segment : la forme
 * attribuée n'atteignait jamais le backend, et Next rendait une 404.
 *
 * Ce que ça aurait coûté : un template APPROUVÉ par Meta porte son URL POUR TOUJOURS. Le premier envoi aurait
 * livré à chaque destinataire un lien mort, irréparable autrement qu'en resoumettant un template. Le défaut a
 * été trouvé en vérifiant les deux formes APRÈS déploiement, avant tout envoi ; personne ne l'a subi.
 *
 * ⚠️ Ce que ce test ne peut PAS voir : l'image web fige ses rewrites AU BUILD. Un fichier correct ici et un
 * `up -d` sans `--build` laissent quand même le proxy dans son état d'avant. La règle est dans le CLAUDE.md.
 *
 * La leçon, plus large que ce fichier : deux moitiés d'un chemin public vivent dans deux dépôts de
 * configuration différents (le routeur Fastify et le proxy Next), et rien dans le langage ne les relie. Une
 * route publique neuve n'est pas livrée tant que son rewrite ne l'est pas.
 */

const lire = (...bouts: string[]): string => readFileSync(join(process.cwd(), ...bouts), 'utf8');

/** Les chemins montés par `registerLinks`, lus dans le code réel plutôt que recopiés ici. */
function routesDuRedirecteur(): string[] {
  const src = lire('src', 'http', 'links.ts');
  return [...src.matchAll(/app\.get\('([^']+)'/g)].map((m) => m[1]!);
}

/** Les `source` des rewrites déclarés par Next. */
function sourcesDesRewrites(): string[] {
  const conf = lire('web', 'next.config.mjs');
  return [...conf.matchAll(/source:\s*'([^']+)'/g)].map((m) => m[1]!);
}

describe('les routes publiques du redirecteur ont toutes leur rewrite', () => {
  it('le redirecteur monte bien les DEUX formes, anonyme et attribuée', () => {
    // Si cette attente casse, c'est que les routes ont bougé : le test suivant devient alors le vrai gardien,
    // et celui-ci sert à dire ce qui a changé.
    expect(routesDuRedirecteur()).toEqual(['/r/:code', '/r/:code/:jeton']);
  });

  it('🔴 CHAQUE route montée a son rewrite : un rewrite Next ne capture QU’UN segment', () => {
    const rewrites = sourcesDesRewrites();
    for (const route of routesDuRedirecteur()) {
      expect(rewrites, `la route ${route} est montée côté API mais n’a AUCUN rewrite : elle rendra une 404`)
        .toContain(route);
    }
  });

  it('la forme ANONYME reste servie, et elle ne doit jamais disparaître', () => {
    // Elle circule dans des messages DÉJÀ LIVRÉS, portés par des templates dont Meta a figé l'URL. C'est la
    // porte à sens unique du CLAUDE.md : la retirer casserait tous ces liens, sans recours.
    expect(sourcesDesRewrites()).toContain('/r/:code');
  });

  it('les autres chemins courts servis par le backend sont là aussi', () => {
    // `/m/` porte les visuels que l'OPÉRATEUR TÉLÉCOM va chercher pour un message RCS déjà envoyé, `/mcp` est
    // l'adresse qu'un intégrateur a recopiée dans sa configuration. Les deux se cassent en silence.
    const rewrites = sourcesDesRewrites();
    expect(rewrites).toContain('/m/:fichier');
    expect(rewrites).toContain('/mcp');
  });
});
