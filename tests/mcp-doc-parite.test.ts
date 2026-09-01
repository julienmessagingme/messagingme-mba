import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { OUTILS } from '../src/mcp/outils';

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
});
