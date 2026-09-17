import { describe, it, expect } from 'vitest';
import { mintNodeCodes } from '../src/workflow/node-codes';
import { actionOf } from '../src/workflow/engine';
import type { WorkflowGraph } from '../src/workflow/graph';

/**
 * DEUX CHAMPS DIFFÉRENTS NE PEUVENT PAS PORTER LE MÊME NOM, ET CELUI-CI A DÉTRUIT DU TRAVAIL CLIENT.
 *
 * 🔴 CE QUI S'EST PASSÉ EN PRODUCTION, LE 2026-09-17. `data.code` porte le CODE PUBLIC d'un bloc
 * (`nod_<client>_<ULID>`), que `mintNodeCodes` re-minte à CHAQUE enregistrement du scénario dès que la
 * valeur ne ressemble pas à un code valide. Le bloc « Fonction JS » rangeait son JavaScript dans ce MÊME
 * `data.code` : il était donc remplacé par un `nod_...` à la première sauvegarde, en silence. À
 * l'exécution, QuickJS répondait « 'nod_xxx' is not defined », la fonction échouait, et l'exécuteur
 * rangeait une chaîne VIDE dans le champ cible.
 *
 * ⚠️ LE SYMPTÔME ÉTAIT TROMPEUR, et c'est pour ça qu'il a duré : le bouton d'essai du bloc teste le code
 * qu'on a SOUS LES YEUX, jamais celui qui est enregistré. Julien : « ça a marché en test dans le node JS
 * mais quand je run le scénario, la valeur n'est pas capturée », puis « le contenu de la fonction quand je
 * reviens sur le node n'est plus ce que j'avais écrit ». Les deux observations décrivaient le même défaut,
 * et la seconde était la preuve.
 *
 * 🔴 AUCUN TEST NE POUVAIT LE VOIR, parce qu'aucun ne faisait TRAVERSER un bloc `js` par la sauvegarde.
 * `mintNodeCodes` était testé sur des blocs sans `data.code` métier, et le moteur sur des graphes écrits à
 * la main. C'est le motif « deux constantes de fichiers différents qui doivent rester ordonnées » : la
 * collision n'est visible dans aucun des deux fichiers.
 */

const TENANT = 'cli';

function graphe(data: Record<string, unknown>): WorkflowGraph {
  return { nodes: [{ id: 'n1', type: 'js', position: { x: 0, y: 0 }, data }], edges: [] } as unknown as WorkflowGraph;
}

const FONCTION = 'return new Date(valeur).getFullYear();';

describe('un bloc « Fonction JS » survit à l’enregistrement', () => {
  it('🔴 la sauvegarde NE DÉTRUIT PLUS le JavaScript du client', () => {
    const avant = graphe({ js: FONCTION, champSource: 'now', champCible: 'annee_js' });
    const apres = mintNodeCodes(avant, TENANT);
    const d = apres.nodes[0]!.data as Record<string, unknown>;
    expect(d.js, 'le source du client est intact').toBe(FONCTION);
    // Le bloc reçoit bien son code public, comme tous les autres : la séparation ne lui retire rien.
    expect(String(d.code)).toMatch(/^nod_cli_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('🔴 et deux sauvegardes de suite ne l’abîment pas davantage', () => {
    // Le défaut se manifestait à la PREMIÈRE sauvegarde ; une seule passe ne le prouverait pas fermé.
    const un = mintNodeCodes(graphe({ js: FONCTION, champSource: 'now', champCible: 'annee_js' }), TENANT);
    const deux = mintNodeCodes(un, TENANT);
    expect((deux.nodes[0]!.data as Record<string, unknown>).js).toBe(FONCTION);
  });

  it('🔴 le moteur lit le source, et le bloc AGIT', () => {
    const g = mintNodeCodes(graphe({ js: FONCTION, champSource: 'now', champCible: 'annee_js' }), TENANT);
    const actions = actionOf(g.nodes[0]!, { champs: {} } as never);
    expect(actions, 'le bloc ne doit pas être un no-op').not.toBeNull();
    expect(actions).toMatchObject({ kind: 'fonctionJs', code: FONCTION, champCible: 'annee_js' });
  });

  it('⚠️ un graphe ABÎMÉ ne fait pas semblant : le bloc devient un no-op, il n’exécute pas l’identifiant', () => {
    // C'est l'état des scénarios déjà enregistrés avant le correctif. On ne peut rien retrouver, mais on ne
    // doit surtout pas ENVOYER ce `nod_...` à QuickJS : il rangeait une chaîne vide dans le champ cible, ce
    // qui se lisait comme « la fonction a rendu du vide » plutôt que comme « il n'y a plus de fonction ».
    const abime = { id: 'n1', type: 'js', position: { x: 0, y: 0 },
      data: { code: 'nod_cli_01M2QSXV8SJZ9KQ5XAQKDZ6D04', champSource: 'now', champCible: 'annee_js' } };
    expect(actionOf(abime as never, { champs: {} } as never)).toBeNull();
  });

  it('⚠️ mais un graphe d’AVANT la séparation garde son source : il est encore dans `code`', () => {
    // Un scénario écrit avant que les codes publics n'existent porte son JavaScript dans `data.code`, et il
    // n'a jamais été minté. Le repli le récupère, et il est sûr : un code minté est reconnaissable.
    const ancien = { id: 'n1', type: 'js', position: { x: 0, y: 0 },
      data: { code: FONCTION, champSource: 'now', champCible: 'annee_js' } };
    expect(actionOf(ancien as never, { champs: {} } as never)).toMatchObject({ code: FONCTION });
  });
});
