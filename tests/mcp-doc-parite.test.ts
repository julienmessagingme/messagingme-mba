import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { OUTILS, MAX_MESSAGES_MCP } from '../src/mcp/outils';
import { MAX_FICHES_PAR_AJOUT } from '../src/agent/connaissance';

/**
 * L'écran « Serveur MCP » et le catalogue réel disent-ils la même chose ?
 *
 * Cette garde existe parce que la page est une DOCUMENTATION écrite à la main, pas un rendu d'un appel : la
 * lire exigerait une clé, que cette page sert justement à créer. Une documentation à la main dérive, et une
 * documentation d'intégration qui dérive coûte un aller-retour de support à chaque intégrateur : soit elle
 * promet un outil retiré, soit elle tait un outil ajouté.
 *
 * Même patron que `tests/queue-names.test.ts`, qui dérive la liste des files du source du worker : on LIT
 * le fichier du front comme du texte plutôt que de l'importer, parce qu'il vit hors du `tsconfig` de la racine.
 */
const source = readFileSync(new URL('../web/lib/mcp-outils.ts', import.meta.url), 'utf8');

/** Les entrées documentées : `{ nom: 'x', scope: 'mcp:read', ...`. */
const documentes = [...source.matchAll(/\{\s*nom:\s*'([a-z_]+)'\s*,\s*scope:\s*'(mcp:read|mcp:write)'/g)]
  .map((m) => ({ nom: m[1]!, scope: m[2]! }));

describe('parité entre le catalogue MCP et l’écran qui le documente', () => {
  it('🔴 chaque outil réel est documenté, et rien n’est documenté qui n’existe pas', () => {
    expect(documentes.length, 'aucune entrée lue : la forme du fichier a changé, ce test est aveugle').toBeGreaterThan(0);
    const reels = OUTILS.map((o) => o.nom).sort();
    expect(documentes.map((d) => d.nom).sort()).toEqual(reels);
  });

  it('🔴 le DROIT annoncé est celui que le serveur exige réellement', () => {
    // Annoncer `mcp:read` sur un outil qui exige `mcp:write` ferait créer des clés trop faibles, et
    // l'intégrateur conclurait que le serveur est cassé. L'inverse ferait créer des clés trop fortes.
    for (const d of documentes) {
      const reel = OUTILS.find((o) => o.nom === d.nom);
      expect(reel, `outil documenté « ${d.nom} » absent du catalogue`).toBeDefined();
      expect(reel!.scope, `droit annoncé faux pour « ${d.nom} »`).toBe(d.scope);
    }
  });

  it('🔴 la mention « connexion OAuth requise » est portée par exactement les outils qui exigent une personne', () => {
    // Une clé d'API ne voit pas ces outils : la page qui les promettrait à une clé enverrait l'intégrateur chercher
    // un outil invisible ; celle qui tairait la mention lui ferait conclure que le serveur est cassé.
    const lignes = source.split('\n');
    const avecOauth = documentes.filter((d) => lignes.find((l) => l.includes(`nom: '${d.nom}'`))?.includes('oauth: true')).map((d) => d.nom);
    expect(avecOauth.sort()).toEqual(OUTILS.filter((o) => o.exigePersonne === true).map((o) => o.nom).sort());
    expect(avecOauth.length, 'aucune mention lue : la forme du fichier a changé, ce test est aveugle').toBeGreaterThan(0);
  });

  it('le nombre de messages que la page annonce pour get_messages est celui que l’outil rend', () => {
    // La page l'écrit en toutes lettres (« Les 50 derniers messages ») : une copie, donc gardée ici.
    const ligne = source.split('\n').find((l) => l.includes("nom: 'get_messages'"));
    expect(ligne, 'entrée get_messages introuvable : la forme du fichier a changé').toBeDefined();
    expect(ligne).toContain(`Les ${MAX_MESSAGES_MCP} derniers messages`);
    expect(ligne).toContain(`The last ${MAX_MESSAGES_MCP} messages`);
  });

  it('le nombre de fiches que la page annonce pour add_knowledge est celui que la console accepte', () => {
    // Même copie écrite en toutes lettres (« 50 au plus par appel »), lue cette fois dans la saisie de la console.
    const ligne = source.split('\n').find((l) => l.includes("nom: 'add_knowledge'"));
    expect(ligne, 'entrée add_knowledge introuvable : la forme du fichier a changé').toBeDefined();
    expect(ligne).toContain(`${MAX_FICHES_PAR_AJOUT} au plus par appel`);
    expect(ligne).toContain(`up to ${MAX_FICHES_PAR_AJOUT} per call`);
  });

  /**
   * 🔴 RELECTURE DE LA LIVRAISON B DU LOT 5 (JB6). Depuis `set_default_responder`, un agent IA PEUT répondre seul, comme
   * répondeur de l'espace. La page publique (section « Ce qu'il ne fait pas ») et `features.md` affirmaient l'inverse,
   * et la description de l'outil, listé dans le tableau de la même page, les contredisait.
   */
  it('🔴 ni la page ni `features.md` ne disent plus qu’un agent IA ne répond jamais seul : set_default_responder y est nommé', () => {
    const page = readFileSync(new URL('../web/app/developers/mcp/page.tsx', import.meta.url), 'utf8');
    expect(page).not.toMatch(/ne répond pas seul|does not answer on its own|que dans un scénario publié/);
    expect(page).toContain('set_default_responder');
    const features = readFileSync(new URL('../features.md', import.meta.url), 'utf8');
    expect(features).not.toMatch(/ne répond encore à personne tout seul|il ne parle que dans le bloc Agent IA/);
  });
});
