import type { OutilDefini } from '../agent/catalog';
import type { VariableDeclaree } from '../agent/requetes';
import type { OutilAPublier } from './publication';
import { lireCibleMaison, variablesPourMeta } from './outils-maison';

/**
 * Ce que chaque outil exposé à l'agent de Meta devient chez Meta : la liste que la publication compare à Meta et
 * que l'aperçu montre. Deux familles partent : un appel de connecteur (les variables de sa requête) et un geste
 * maison (les variables que sa cible laisse à l'agent). Le reste est filtré ici plutôt que de faire échouer toute
 * la publication : un MCP, une action d'agent IA, un outil maison illisible, un connecteur sans appel.
 * Le MCP est écarté faute de code, pas par refus de Meta (qui appelle notre relais en HTTP) : il manque la
 * traduction de son schéma en variables et une branche du relais vers le résolveur MCP.
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
