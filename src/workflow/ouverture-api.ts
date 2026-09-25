import type { WorkflowGraph } from './graph';
import { actionOf, scanOpening } from './engine';

/**
 * CE QU'UN ENVOI PAR L'API FAIT PARTIR EN PREMIER, depuis l'entrée d'un scénario ou depuis un bloc.
 *
 * 🔴 UNE SEULE FONCTION JUGE LE SCÉNARIO ET LE BLOC. Elle remplace `exigeFenetre24h`, qui jugeait une cible
 * `node` sur le TYPE du bloc visé : une condition, une étiquette ou un champ qui mène à un message rapide ne
 * demandait aucune fenêtre, et le message partait vers des gens qui n'avaient pas écrit (Meta 131047).
 *
 * Elle repose sur `scanOpening`, le même examen que la console (`canalDOuverture`, la création de campagne) :
 * `whatsapp_template` et `rcs` y correspondent, `whatsapp_session` et `null` y valent « pas de campagne ». La
 * parité est gardée par `tests/ouverture-api.test.ts`.
 *
 * ⚠️ UNE EXCEPTION, ASSUMÉE : un bloc RCS suivi d'une ATTENTE (« RCS, on attend deux jours, on relance »). La
 * console (`canalDOuverture`) le refuse, parce que `waitBeforeTemplate` y est posé ; l'API l'envoie en `rcs`,
 * parce que le RCS part bien au lancement et que la spec ne refuse qu'« une attente avant tout envoi ».
 *
 * ⚠️ PRUDENCE : si UNE branche peut envoyer un message de session, c'est `whatsapp_session`, et la fenêtre sera
 * exigée de TOUS les destinataires : on ne sait pas d'avance quelle branche un contact prendra.
 *
 * ⚠️ UN GRAPHE VIDE EST UN SCÉNARIO JAMAIS PUBLIÉ. Un envoi joue `workflows.graph`, le publié ; un brouillon
 * seul n'a rien à jouer. `published_at` n'en décide pas : il vaut null sur les scénarios publiés avant
 * l'arrivée du bouton « Publier » (migration 0095).
 */
export type OuvertureApi = 'whatsapp_template' | 'whatsapp_session' | 'rcs';

export type VerdictOuverture = { ouverture: OuvertureApi } | { ouverture: null; raison: string };

export function ouvertureApi(graph: WorkflowGraph, depuis?: string): VerdictOuverture {
  if (graph.nodes.length === 0) {
    return { ouverture: null, raison: 'le scénario n’a aucun bloc publié : publiez-le avant de l’envoyer' };
  }
  if (depuis !== undefined && !graph.nodes.some((n) => n.id === depuis)) {
    return { ouverture: null, raison: 'le bloc de départ n’existe pas dans le scénario publié' };
  }
  const scan = scanOpening(graph, depuis);
  // Une attente vue APRÈS un bloc RCS qui ouvre n'empêche rien : le RCS part au lancement. `scanOpening` ne
  // pose `rcsOpen` que si AUCUNE attente n'a été vue avant lui.
  if (scan.waitBeforeTemplate && !scan.rcsOpen) {
    return { ouverture: null, raison: 'une attente précède le premier envoi : rien ne partirait au lancement' };
  }
  if (scan.ambiguousTemplate) {
    return { ouverture: null, raison: 'plusieurs templates différents peuvent ouvrir : impossible de savoir lequel part' };
  }
  if (scan.unnamedOpeningTemplate) {
    return { ouverture: null, raison: 'un template d’ouverture n’a pas encore de modèle choisi' };
  }
  if (scan.sessionOpen) return { ouverture: 'whatsapp_session' };
  if (scan.rcsOpen) return { ouverture: 'rcs' };
  if (scan.firstTemplate && String(scan.firstTemplate.data.templateName ?? '').trim() !== '') {
    return { ouverture: 'whatsapp_template' };
  }
  return { ouverture: null, raison: 'rien ne part : ni template, ni bloc RCS, ni message avant la fin du parcours' };
}

/**
 * LE TEMPLATE QUI OUVRE CE GRAPHE, lu comme l'exécuteur le lira (`actionOf`, langue `fr` par défaut).
 *
 * 🔴 DEUX CONSOMMATEURS, UNE FONCTION : `POST /v1/sends` y lit le template que `params` paramètre (cible
 * `scenario`), et `GET /v1/scenarios` l'annonce à l'intégrateur. Écrite deux fois, l'une annoncerait un jour un
 * template que l'autre ne paramètre pas. Elle n'a de sens que pour une ouverture `whatsapp_template` : sur un
 * scénario qui ouvre en RCS, le premier template trouvé est un REPLI, pas ce qui part au lancement.
 */
export function modeleDOuverture(graph: WorkflowGraph): { templateName: string; language: string } | null {
  const premier = scanOpening(graph).firstTemplate;
  const a = premier ? actionOf(premier) : null;
  return a?.kind === 'sendTemplate' ? { templateName: a.templateName, language: a.language } : null;
}
