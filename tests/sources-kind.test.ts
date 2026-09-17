import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';

/**
 * QUI LIT LA TABLE DES SOURCES, ET CHACUN SAIT-IL DE QUELLE NATURE ELLE EST.
 *
 * 🔴 CE TEST EXISTE PARCE QUE LE COMPTE ÉCRIT À LA MAIN A DÉRIVÉ DEUX FOIS DANS LA MÊME JOURNÉE. Le
 * 2026-09-17, une garde a été posée sur `agent_tool_sources.kind` en annonçant « TROIS consommateurs » ;
 * une relecture à froid a trouvé le QUATRIÈME (`parId`, les routes des connecteurs API) ; la relecture
 * suivante a trouvé le CINQUIÈME (`sourcePourTest`, le bouton Test d'une requête), qui rendait le SECRET
 * DÉCHIFFRÉ d'un serveur MCP à qui passait son identifiant dans le corps d'une requête. Chaque fois, le
 * commentaire affirmait un inventaire exhaustif qui ne l'était pas.
 *
 * ⚠️ UN INVENTAIRE ÉCRIT DANS UN COMMENTAIRE DÉRIVE DÈS QU'ON AJOUTE UN APPELANT. Celui-ci est tenu par le
 * CODE : le test énumère les lecteurs réels et les compare à la liste déclarée ci-dessous. Ajouter un
 * lecteur fait échouer ce test, ce qui oblige son auteur à dire de quelle nature de source il a besoin,
 * au lieu de l'oublier. Même idiome que `tests/lib-adresse-privee.test.ts`, qui tient l'inventaire des
 * chemins de vérification d'adresse pour la même raison.
 *
 * 🔴 CE QUE LE CROISEMENT OUVRE, CONCRÈTEMENT. `pourAppel` rend le secret DÉCHIFFRÉ et l'adresse de base.
 * Un lecteur qui ne vérifie pas le `kind` peut donc, avec l'identifiant d'un serveur MCP (que
 * `GET /tenants/:t/mcp` rend à tout administrateur) : poster une enveloppe JSON-RPC sur l'API métier d'un
 * client, ou envoyer une requête HTTP de sa composition sur le point MCP, dans les deux cas AVEC le secret
 * du client dans l'en-tête. La clé étrangère composite de 0152 ferme le croisement en base, mais seulement
 * pour les lignes qui portent `source_kind` : celles d'avant le déploiement lui échappent (`MATCH SIMPLE`).
 */

/**
 * Les lecteurs DÉCLARÉS de la table des sources, et la nature qu'ils exigent.
 *
 * `gardes` dit ce que le fichier doit contenir pour prouver qu'il sait à quoi il parle. Un fichier qui
 * porte PLUSIEURS lecteurs en déclare plusieurs : un motif unique passerait alors dans les deux sens.
 * `pourquoi` dit ce que ce lecteur FAIT de la ligne, pour que le prochain sache quoi vérifier.
 */
const LECTEURS: Array<{ fichier: string; gardes: string[]; pourquoi: string }> = [
  {
    fichier: 'src/agent/resolvers/http.ts',
    gardes: ["source.kind !== 'http'"],
    pourquoi: 'il envoie une requête HTTP ordinaire avec le secret du client',
  },
  {
    fichier: 'src/agent/resolvers/mcp.ts',
    gardes: ["source.kind !== 'mcp'"],
    pourquoi: 'il ouvre une session MCP et poste du JSON-RPC',
  },
  {
    fichier: 'src/http/agent-mcp.ts',
    gardes: ["source.kind !== 'mcp'"],
    pourquoi: 'éprouver, aperçu et import ouvrent une connexion sortante',
  },
  {
    fichier: 'src/index.ts',
    /**
     * 🔴 TROIS LECTEURS DANS UN SEUL FICHIER, DONC TROIS MOTIFS DISTINCTS. Un `toContain` unique sur ce
     * fichier passait dans les DEUX SENS : débrancher la garde de `sourcePourTest` laissait les deux autres
     * satisfaire l'assertion, et le test restait vert. C'est la MUTATION qui l'a montré, pas la relecture.
     */
    gardes: [
      "if (!src || src.kind !== 'http') return { ok: false, erreur: 'source introuvable' };",
      "brut && brut.kind === 'http' ? brut : null",
      "return src && src.kind === 'http'",
    ],
    pourquoi: 'le câblage porte eprouver, sourcePourTest et la pose du secret chez Meta',
  },
];

/** Les fichiers qui ne font que TRANSMETTRE la méthode, sans jamais lire la ligne qu'elle rend. */
const PASSE_PLATS = ['src/agent/sources.ts', 'src/agent/sources.pg.ts'];

function fichiersDeSrc(): string[] {
  return globSync('src/**/*.ts').map((f) => f.split('\\').join('/'));
}

describe('la nature d’une source est vérifiée par CHACUN de ses lecteurs', () => {
  it('🔴 l’inventaire des lecteurs de `pourAppel` est COMPLET, et le test le tient', () => {
    const attendus = new Set(LECTEURS.map((l) => l.fichier));
    const trouves = fichiersDeSrc().filter((f) => {
      if (PASSE_PLATS.includes(f)) return false;
      const src = readFileSync(f, 'utf8');
      /**
       * ⚠️ LE MOTIF NE PEUT PAS EXIGER `await`, ET C EST UNE MUTATION QUI L A MONTRÉ. La première version
       * cherchait `await x.pourAppel(` : trois formes lui échappaient, toutes légitimes en TypeScript, et
       * chacune aurait ajouté un lecteur du secret déchiffré sans faire tomber ce test.
       *   - `return deps.pourAppel(...)` (promesse retournée, jamais attendue ici)
       *   - `const { pourAppel } = deps; await pourAppel(...)` (déstructuration)
       *   - `await deps?.pourAppel?.(...)` (chaînage optionnel)
       * On cherche donc l IDENTIFIANT, sans rien supposer de ce qui l entoure. Un faux positif ici coûte
       * une ligne de déclaration ; un faux négatif coûte un secret.
       */
      return /\bpourAppel\b/.test(src);
    });

    /**
     * ⚠️ LE MESSAGE D'ÉCHEC PORTE LA CONSIGNE, pas seulement l'écart : quelqu'un qui ajoute un lecteur doit
     * comprendre en une lecture ce qu'on attend de lui, sinon il ajoutera son fichier à la liste sans poser
     * la garde, et le test deviendra une formalité.
     */
    const nouveaux = trouves.filter((f) => !attendus.has(f));
    expect(
      nouveaux,
      'Un nouveau lecteur de `pourAppel` est apparu. `pourAppel` rend le SECRET DÉCHIFFRÉ : déclarez-le '
      + 'dans LECTEURS avec la nature de source qu’il exige, et posez la garde correspondante.',
    ).toEqual([]);

    const disparus = [...attendus].filter((f) => !trouves.includes(f));
    expect(disparus, 'Un lecteur déclaré a disparu : retirez-le de LECTEURS.').toEqual([]);
  });

  it('🔴 chaque lecteur déclaré PORTE sa garde', () => {
    for (const l of LECTEURS) {
      const src = readFileSync(l.fichier, 'utf8');
      for (const g of l.gardes) {
        expect(src, `${l.fichier} lit une source (${l.pourquoi}) sans vérifier sa nature : ${g}`).toContain(g);
      }
    }
  });

  it('🔴 et le lecteur qui passe par `parId` la porte aussi : c’est celui qu’on avait oublié', () => {
    /**
     * `parId` ne rend PAS le secret, mais ses trois routes agissent quand même sur la ligne : l’épreuve
     * envoie une requête sortante, le PATCH réécrit l’adresse et l’authentification, le DELETE supprime.
     * C’est le lecteur que l’inventaire écrit à la main avait oublié en annonçant « trois consommateurs ».
     */
    const src = readFileSync('src/http/agent-sources.ts', 'utf8');
    expect(src).toContain("s.kind === 'http'");
    // Et AUCUNE route ne lit `deps.parId` en direct : elles passent toutes par le point unique
    // `connecteurHttp`, seul endroit où cette lecture est autorisée.
    const direct = src.split('\n')
      .filter((l) => l.includes('deps.parId(') && !l.includes('const s = await deps.parId('));
    expect(direct, 'une route lit `parId` sans passer par `connecteurHttp`').toEqual([]);
  });

  it('⚠️ et les passe-plats n’en portent AUCUNE, délibérément', () => {
    // Filtrer dans le store rendrait la méthode inutilisable par l'autre famille, et cacherait le
    // croisement au lieu de le refuser : chaque lecteur doit dire ce qu'il attend.
    for (const f of PASSE_PLATS) {
      const src = readFileSync(f, 'utf8');
      expect(src, `${f} ne doit pas filtrer le kind : c’est à ses lecteurs de le faire`)
        .not.toMatch(/where[^;]*kind\s*=\s*'(http|mcp)'/);
    }
  });
});
