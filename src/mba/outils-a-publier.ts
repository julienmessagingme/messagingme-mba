import type { OutilComplet } from '../agent/catalog';
import type { VariableDeclaree } from '../agent/requetes';
import { paramsOutil } from '../agent/llm/tool-schema';
import type { OutilAPublier } from './publication';
import { lireCibleMaison, variablesPourMeta } from './outils-maison';

/**
 * Les variables qu'un outil MCP déclare à Meta : ses paramètres REMPLIS PAR LE MODÈLE, et eux seuls. Les autres (fiche du
 * contact, champ personnalisé, constante, réglés dans « Connecteurs MCP ») sont posés par notre relais
 * (`completerArguments`) : Meta ne les voit jamais, et c'est la garde d'identité (2026-10-02).
 */
export function variablesMcp(params: unknown): VariableDeclaree[] {
  return paramsOutil(params)
    .filter((p) => p.source === 'modele')
    .map((p) => ({
      nom: p.name, type: p.type, origine: { type: 'modele' as const },
      ...(p.description ? { description: p.description } : {}),
      ...(p.required ? { requis: true } : {}),
      ...(p.enum && p.enum.length > 0 ? { enum: p.enum } : {}),
    }));
}

/**
 * Ce que chaque outil exposé à l'agent de Meta devient chez Meta : la liste que la publication compare à Meta et
 * que l'aperçu montre. Trois familles partent : un appel de connecteur (les variables de sa requête), un geste maison
 * (les variables que sa cible laisse à l'agent) et, depuis le 2026-10-02, un outil MCP (ses paramètres remplis par le
 * modèle, `variablesMcp`), que notre relais appelle pour Meta. Le reste est filtré ici plutôt que de faire échouer
 * toute la publication : une action d'agent IA, un outil maison illisible, un connecteur sans appel, et tout outil
 * qui n'est pas APPELABLE (`inappelable`, la règle unique du catalogue : MCP non activable ou disparu, serveur MCP ou
 * connecteur HTTP éteint ou en brouillon).
 */
export async function outilsAPublier(
  actifs: readonly Pick<OutilComplet, 'id' | 'name' | 'description' | 'nePasUtiliser' | 'origin' | 'requestId' | 'binding' | 'params' | 'inappelable'>[],
  requete: (id: string) => Promise<{ variables: VariableDeclaree[] } | null>,
): Promise<OutilAPublier[]> {
  const sortie: OutilAPublier[] = [];
  for (const o of actifs) {
    if (o.inappelable !== null) continue;
    const commun = { id: o.id, name: o.name, description: o.description, nePasUtiliser: o.nePasUtiliser };
    if (o.origin === 'mba') {
      const cible = lireCibleMaison(o.binding);
      if (cible !== null) sortie.push({ ...commun, variables: variablesPourMeta(cible) });
      continue;
    }
    if (o.origin === 'mcp') {
      // Un outil MCP peut arriver SANS description (l'import écrit `''` quand le serveur n'en donne pas), quand Meta
      // l'exige et qu'un refus arrête toute la publication : son nom la remplace. L'administrateur l'écrit vraiment
      // dans Connecteurs MCP.
      const description = o.description.trim() !== '' ? o.description : `Outil ${o.name}.`;
      sortie.push({ ...commun, description, variables: variablesMcp(o.params) });
      continue;
    }
    if (o.origin !== 'http' || !o.requestId) continue;
    const req = await requete(o.requestId);
    if (req) sortie.push({ ...commun, variables: req.variables });
  }
  return sortie;
}
