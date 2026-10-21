import type { OutilComplet, OutilBibliotheque } from '../agent/catalog';
import { messageInappelable } from '../agent/catalog';
import { entryNode } from '../workflow/engine';
import { socleField } from '../crm/fields';
import type { WorkflowGraph } from '../workflow/graph';
import { blocSeul, lireCibleMaison, nomDuBlocParCode, typeDeLaCible } from './outils-maison';
import type { OutilMbaVue, OutilMcpProposable } from '../../web/lib/partage/outils-mba';

export interface ContexteVue {
  requetes: ReadonlyMap<string, { label: string }>;
  champs: ReadonlySet<string>;
  bibliotheque: ReadonlyMap<string, OutilBibliotheque>;
  /** Les scénarios de l'espace, avec leur graphe publié : c'est lui que le relais joue. */
  workflows: ReadonlyMap<string, { name: string; graph: WorkflowGraph }>;
  /** Les serveurs MCP de l'espace, pour nommer celui d'un outil MCP. */
  serveurs: ReadonlyMap<string, { label: string }>;
}

/** Les agents IA qui se servent aussi d'un outil de la bibliothèque, par leur nom. */
function agentsDe(o: OutilBibliotheque | undefined): string[] {
  return (o?.consommateurs ?? []).filter((c) => c.agentId !== null).map((c) => c.agentLabel ?? 'un agent IA');
}

/**
 * Les outils MCP que l'agent de Meta peut recevoir, mis en forme pour l'onglet. 🔴 Ce qui est offrable est décidé
 * par le catalogue (`offrablesPour`, la règle unique du 2026-10-02) : cette fonction ne garde que les outils MCP (la
 * case « Appeler un outil MCP ») et ne filtre rien d'autre. Un outil déjà rattaché mais éteint n'y est pas : sa ligne
 * dans la liste propose de le rallumer, un second chemin pour le même geste ferait deux vérités.
 */
export function outilsMcpProposables(
  offrables: readonly OutilBibliotheque[],
  serveurs: ReadonlyMap<string, { label: string }>,
): OutilMcpProposable[] {
  return offrables
    .filter((o) => o.origin === 'mcp')
    .map((o) => ({
      id: o.id, name: o.name, title: o.title, description: o.description, risque: o.risk,
      serveur: o.sourceId ? serveurs.get(o.sourceId)?.label ?? null : null,
      aussiUtilisePar: agentsDe(o),
    }));
}

export function vueOutilMba(o: OutilComplet, ctx: ContexteVue): OutilMbaVue {
  const base = {
    id: o.id, name: o.name, title: o.title, description: o.description, nePasUtiliser: o.nePasUtiliser, actif: o.actif,
    risque: o.risk,
  };
  // Un outil MCP part chez Meta depuis le 2026-10-02 : notre relais l'appelle pour Meta (`src/http/mba-relais.ts`). Ses
  // paramètres et ses mots se règlent dans « Connecteurs MCP », partagés avec les agents IA.
  // Pourquoi l'outil n'est pas appelable : la cause du catalogue (`o.inappelable`), jamais recalculée ici.
  const manque = o.inappelable ? messageInappelable(o.inappelable, o.origin) : null;
  if (o.origin === 'mcp') {
    return {
      ...base, type: 'mcp',
      cible: { type: 'mcp', sourceId: o.sourceId, serveur: o.sourceId ? ctx.serveurs.get(o.sourceId)?.label ?? null : null },
      cibleManquante: manque, aussiUtilisePar: agentsDe(ctx.bibliotheque.get(o.id)), publiable: manque === null,
    };
  }
  if (o.origin === 'http' && o.requestId) {
    const req = ctx.requetes.get(o.requestId) ?? null;
    const aussiUtilisePar = agentsDe(ctx.bibliotheque.get(o.id));
    return {
      ...base, type: 'connecteur',
      cible: { type: 'connecteur', requeteId: o.requestId, libelle: req?.label ?? null },
      // Un connecteur éteint ne part plus chez Meta (`outilsAPublier`) : la ligne le dit et passe « À envoyer ».
      cibleManquante: req ? manque : 'l’appel de cet outil a été supprimé dans Connecteurs API',
      aussiUtilisePar, publiable: req !== null && manque === null,
    };
  }
  const cible = o.origin === 'mba' ? lireCibleMaison(o.binding) : null;
  if (cible === null) {
    return {
      ...base, type: 'inconnu', cible: { type: 'inconnu' },
      cibleManquante: 'l’agent de Meta ne peut pas appeler cet outil : supprimez-le', aussiUtilisePar: [], publiable: false,
    };
  }
  const type = typeDeLaCible(cible);
  switch (cible.handler) {
    case 'tag_fixe':
      return { ...base, type, cible: { type: 'tag', tag: cible.tag }, cibleManquante: null, aussiUtilisePar: [], publiable: true };
    case 'champ_fixe':
      return {
        ...base, type, cible: { type: 'champ', champ: cible.champ, valeurs: cible.valeurs },
        // Un champ de base (Prénom, Nom, Email) n'est jamais manquant : il existe avant sa première écriture.
        cibleManquante: ctx.champs.has(cible.champ) || socleField(cible.champ) ? null : `le champ « ${cible.champ} » n’existe plus dans le mini-CRM`,
        aussiUtilisePar: [], publiable: true,
      };
    // Un bloc ou un scénario modifié depuis la création se revérifie ici, comme à chaque appel du relais : un bloc
    // devenu question ou un scénario vidé refuse, et la ligne rouge le dit. Publiés quand même : le relais refuse.
    case 'bloc_fixe': {
      const wf = ctx.workflows.get(cible.workflowId) ?? null;
      const r = wf ? blocSeul(wf.graph, cible.code) : null;
      return {
        ...base, type,
        cible: {
          type: 'bloc', workflowId: cible.workflowId, code: cible.code, scenario: wf?.name ?? null,
          bloc: wf ? nomDuBlocParCode(wf.graph, cible.code) : null,
        },
        cibleManquante: wf === null ? 'le scénario de ce bloc n’existe plus' : r !== null && !r.ok ? r.raison : null,
        aussiUtilisePar: [], publiable: true,
      };
    }
    case 'scenario_fixe': {
      const wf = ctx.workflows.get(cible.workflowId) ?? null;
      return {
        ...base, type, cible: { type: 'scenario', workflowId: cible.workflowId, scenario: wf?.name ?? null },
        cibleManquante: wf === null ? 'ce scénario n’existe plus'
          : entryNode(wf.graph) === null ? SCENARIO_VIDE : null,
        aussiUtilisePar: [], publiable: true,
      };
    }
  }
}

/** Un scénario sans bloc publié : rien ne partirait. */
export const SCENARIO_VIDE = 'ce scénario est vide ou n’est pas publié';
