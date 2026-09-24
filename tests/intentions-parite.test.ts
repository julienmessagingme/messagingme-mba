import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { INTENTS } from '../src/analysis/schema';
import { buildPrompt } from '../src/analysis/engine';
import { INTENTIONS, libelleIntention } from '../web/lib/intentions';

/**
 * LES INTENTIONS : UNE LISTE QUI FAIT FOI, ET TOUT CE QUI LA NOMME.
 *
 * 🔴 CE QUE CE FICHIER TIENT, ET QU'AUCUN COMPILATEUR NE VOIT. `INTENTS` (`src/analysis/schema.ts`) est
 * nommée ailleurs sous des formes qu'aucun type ne relie : le CHECK en base, le texte du prompt, le SQL des
 * statistiques, la copie de la console (qui n'importe jamais `src/`). Chacune est plausible seule, c'est
 * leur ÉGALITÉ qui porte l'invariant. Une valeur que le schéma accepte et que le CHECK refuse fait échouer
 * l'INSERT de l'analyse, et le job la rejoue, appel au modèle compris, jusqu'à la DLQ.
 *
 * ⚠️ TOUT EST DÉRIVÉ DE `INTENTS`, rien n'est recopié ici : une liste écrite dans ce test ne ferait que
 * déplacer la dérive d'un fichier à l'autre.
 *
 * ⚠️ IL VIT À LA RACINE, et pas dans `web/` : seul `ci.yml` tourne sur un changement de `src/`
 * (`tests/ci-decoupage.test.ts`), et c'est justement quand `INTENTS` change qu'il a quelque chose à dire.
 */

const RACINE = resolve(__dirname, '..');
/** Fins de ligne normalisées : les fichiers sont en CRLF sur le poste de travail. */
const lire = (chemin: string): string => readFileSync(resolve(RACINE, chemin), 'utf8').split('\r\n').join('\n');
/** Le SQL sans ses commentaires de ligne : une migration peut PARLER d'un CHECK sans le poser. */
const sansCommentaires = (sql: string): string => sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

/**
 * Les valeurs du DERNIER CHECK d'intention écrit dans `db/migrations`, fichiers pris dans l'ordre de leur
 * nom, qui est l'ordre d'application du runner : c'est celui que la base porte une fois tout appliqué.
 */
function dernierCheckIntention(): { fichier: string; valeurs: string[] } | null {
  const fichiers = readdirSync(resolve(RACINE, 'db', 'migrations')).filter((n) => n.endsWith('.sql')).sort();
  let dernier: { fichier: string; valeurs: string[] } | null = null;
  for (const fichier of fichiers) {
    const sql = sansCommentaires(lire(`db/migrations/${fichier}`));
    for (const m of sql.matchAll(/check\s*\(\s*intent\s+in\s*\(([^)]*)\)\s*\)/gi)) {
      dernier = { fichier, valeurs: [...m[1]!.matchAll(/'([a-z_]+)'/g)].map((v) => v[1]!) };
    }
  }
  return dernier;
}

describe('les intentions : la base accepte exactement ce que le schéma accepte', () => {
  it('🔴 le DERNIER CHECK écrit porte les valeurs de INTENTS, ni plus ni moins', () => {
    const check = dernierCheckIntention();
    // Sans cette ligne, un CHECK reformaté rendrait `null` et le test passerait en ne comparant rien.
    expect(check, 'aucun CHECK d’intention lu dans db/migrations : ce test ne garde plus rien').not.toBeNull();
    expect([...check!.valeurs].sort(), `CHECK lu dans ${check!.fichier}`).toEqual([...INTENTS].sort());
  });
});

describe('les intentions : le modèle se voit proposer exactement INTENTS', () => {
  const lignes = buildPrompt('Client: bonjour').system.split('\n');

  it('🔴 la ligne « - intent : » énumère INTENTS, dans leur ordre', () => {
    const ligne = lignes.find((l) => l.startsWith('- intent :'));
    expect(ligne, 'la ligne « - intent : » a disparu du prompt : ce test ne garde plus rien').toBeDefined();
    expect([...ligne!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1])).toEqual([...INTENTS]);
  });

  it('🔴 chaque intention est DÉCRITE sur sa propre ligne', () => {
    // Une liste de noms seule laisse le modèle deviner la frontière entre `achat` et `demande_devis`, ou
    // entre `suivi_commande` et `reclamation`, et il la placerait différemment d'une conversation à l'autre.
    for (const i of INTENTS) {
      const prefixe = `  - ${i} : `;
      const ligne = lignes.find((l) => l.startsWith(prefixe));
      expect(ligne, `l’intention ${i} n’est pas décrite au modèle`).toBeDefined();
      expect(ligne!.length - prefixe.length, `la description de ${i} est vide`).toBeGreaterThan(20);
    }
  });
});

describe('les intentions : la synthèse du serveur compte chacune', () => {
  const source = lire('src/stats/conversation-stats.pg.ts');

  it('🔴 getSummary compte chaque intention, et aucune de plus', () => {
    // L'agrégat journalier a son propre cas (`tests/agregats-jour.test.ts`). Ici, la requête de la synthèse,
    // dont les colonnes sont écrites une par une : une valeur oubliée rendrait sa barre vide à l'écran.
    for (const i of INTENTS) {
      expect(source, `getSummary ne compte pas ${i}`).toContain(`count(*) filter (where intent = '${i}')::int as`);
    }
    expect(source.split("count(*) filter (where intent = '").length - 1, 'une intention comptée que le schéma ne connaît pas')
      .toBe(INTENTS.length);
  });
});

describe('les intentions : la console connaît les mêmes, et sait les nommer', () => {
  it('🔴 la copie de la console est INTENTS, dans le même ordre', () => {
    // L'ordre compte : c'est l'ordre FIXE des barres. Un ordre différent ne casserait rien, il ferait
    // seulement diverger deux listes qu'on croirait identiques.
    expect([...INTENTIONS]).toEqual([...INTENTS]);
  });

  it('🔴 chaque intention a un libellé français ET anglais, jamais sa clé brute', () => {
    const fr = (f: string): string => f;
    const en = (f: string, e?: string): string => e ?? f;
    for (const i of INTENTS) {
      expect(libelleIntention(i, fr), `pas de libellé français pour ${i}`).not.toBe(i);
      expect(libelleIntention(i, en), `pas de libellé anglais pour ${i}`).not.toBe(i);
    }
  });

  it('⚠️ aucun libellé pour une intention que le schéma ne connaît pas', () => {
    // Un `case` orphelin est le reste d'une valeur retirée : il ne casse rien, mais il ment sur la liste.
    const cases = [...lire('web/lib/intentions.ts').matchAll(/case '([a-z_]+)':/g)].map((m) => m[1]);
    expect([...cases].sort()).toEqual([...INTENTS].sort());
  });
});

describe('les intentions : les écrans n’en portent plus de copie', () => {
  // 🔴 LA PARITÉ DU MODULE NE VOIT QUE LE MODULE. Les deux écrans portaient chacun leur liste et leurs
  // libellés, et c'est ainsi qu'une intention ajoutée au schéma n'arrivait sur aucun des deux. Une copie
  // réintroduite dans un écran repasserait sans que le bloc précédent la voie : celui-ci la refuse.
  const ECRANS = ['web/components/CarteIntentions.tsx', 'web/components/ConversationAnalysisCard.tsx'];

  for (const ecran of ECRANS) {
    it(`🔴 ${ecran} lit la liste et les libellés dans web/lib/intentions.ts`, () => {
      const source = lire(ecran);
      expect(source, `${ecran} n’importe pas @/lib/intentions`).toContain("from '@/lib/intentions'");
      for (const i of INTENTS) {
        expect(source, `${ecran} porte son propre libellé pour ${i}`).not.toContain(`case '${i}'`);
      }
      expect(source, `${ecran} porte sa propre liste d’intentions`).not.toContain("'prise_rdv'");
      expect(source, `${ecran} porte sa propre liste d’intentions`).not.toMatch(/const INTENTS\b/);
    });
  }
});
