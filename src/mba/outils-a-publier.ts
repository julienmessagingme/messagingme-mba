import type { OutilDefini } from '../agent/catalog';
import type { VariableDeclaree } from '../agent/requetes';
import type { OutilAPublier } from './publication';
import { lireCibleMaison, variablesPourMeta } from './outils-maison';

/**
 * CE QUE CHAQUE OUTIL EXPOSÉ À L'AGENT DE META DEVIENT CHEZ META (spec 2026-09-21-outils-maison-mba, § 8).
 *
 * 🔴 SORTI DE `src/index.ts` POUR ÊTRE TESTÉ : c'est la liste que la publication compare à Meta et que l'aperçu
 * montre, et un câblage ne se teste pas.
 *
 * Deux familles partent : un appel de connecteur (les variables de sa requête), et un geste maison de l'agent
 * de Meta (les variables que sa cible laisse à l'agent). Tout le reste est filtré ICI plutôt que de produire un
 * geste qui échouerait et arrêterait toute la publication : un MCP (Meta n'appelle que du HTTP), une action
 * d'agent IA (handler inconnu du relais), un outil maison illisible, un connecteur dont l'appel a disparu.
 */
export async function outilsAPublier(
  actifs: readonly Pick<OutilDefini, 'id' | 'name' | 'description' | 'nePasUtiliser' | 'origin' | 'requestId' | 'binding'>[],
  requete: (id: string) => Promise<{ variables: VariableDeclaree[] } | null>,
): Promise<OutilAPublier[]> {
  const sortie: OutilAPublier[] = [];
  for (const o of actifs) {
    const commun = { id: o.id, name: o.name, description: o.description, nePasUtiliser: o.nePasUtiliser };
    if (o.origin === 'mba') {
      const cible = lireCibleMaison(o.binding);
      if (cible !== null) sortie.push({ ...commun, variables: variablesPourMeta(cible) });
      continue;
    }
    if (o.origin !== 'http' || !o.requestId) continue;
    const req = await requete(o.requestId);
    if (req) sortie.push({ ...commun, variables: req.variables });
  }
  return sortie;
}
