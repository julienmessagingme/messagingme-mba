import type { WorkflowGraph } from './graph';
import { actionOf, scanOpening } from './engine';

/**
 * Ce qu'un envoi par l'API fait partir en premier, depuis l'entrée d'un scénario ou depuis un bloc.
 *
 * Une seule fonction juge le scénario et le bloc, sur ce qui part réellement et pas sur le type du bloc visé :
 * une condition qui mène à un message rapide exige la fenêtre de 24 h, sinon le message part vers des gens qui
 * n'ont pas écrit (Meta 131047).
 *
 * Elle repose sur `scanOpening`, le même examen que la console (`canalDOuverture`) ; parité gardée par
 * `tests/ouverture-api.test.ts`. Une exception : un bloc RCS suivi d'une attente, que la console refuse
 * (`waitBeforeTemplate`) et que l'API envoie en `rcs`, puisque le RCS part bien au lancement.
 *
 * Si une seule branche peut envoyer un message de session, c'est `whatsapp_session` et la fenêtre est exigée de
 * tous les destinataires : on ne sait pas d'avance quelle branche un contact prendra.
 *
 * Un graphe vide est un scénario jamais publié (un envoi joue `workflows.graph`, le publié). `published_at` n'en
 * décide pas : il vaut null sur les scénarios publiés avant l'arrivée du bouton « Publier ».
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
  // Une attente vue après un bloc RCS qui ouvre n'empêche rien : le RCS part au lancement. `scanOpening` ne
  // pose `rcsOpen` que si aucune attente n'a été vue avant lui.
  if (scan.waitBeforeTemplate && !scan.rcsOpen) {
    return { ouverture: null, raison: 'une attente précède le premier envoi : rien ne partirait au lancement' };
  }
  if (scan.ambiguousTemplate) {
    return { ouverture: null, raison: 'plusieurs templates différents peuvent ouvrir : impossible de savoir lequel part' };
  }
  if (scan.unnamedOpeningTemplate) {
    return { ouverture: null, raison: 'un template d’ouverture n’a pas encore de modèle choisi' };
  }
  // Un « Aller à » vers un autre scénario avant tout envoi (RC5) : ce qui part se joue ailleurs, et un envoi qui
  // promettrait une ouverture sans l'avoir lue pourrait partir hors fenêtre.
  if (scan.sautsHorsScenario.length > 0) {
    return { ouverture: null, raison: 'un bloc « Aller à » vers un autre scénario précède le premier envoi : visez directement le bloc d’arrivée' };
  }
  if (scan.sessionOpen) return { ouverture: 'whatsapp_session' };
  if (scan.rcsOpen) return { ouverture: 'rcs' };
  if (scan.firstTemplate && String(scan.firstTemplate.data.templateName ?? '').trim() !== '') {
    return { ouverture: 'whatsapp_template' };
  }
  return { ouverture: null, raison: 'rien ne part : ni template, ni bloc RCS, ni message avant la fin du parcours' };
}

/**
 * Le template qui ouvre ce graphe, lu comme l'exécuteur le lira (`actionOf`, langue `fr` par défaut).
 *
 * Point de passage unique pour `POST /v1/sends` (le template que `params` paramètre, et la catégorie Meta
 * jugée pour la cible `node`) et `GET /v1/scenarios` (ce qu'on annonce à l'intégrateur) : écrite deux fois,
 * l'une annoncerait un template que l'autre ne paramètre pas. N'a de sens que pour une ouverture
 * `whatsapp_template` : sur un scénario qui ouvre en RCS, le premier template trouvé est un repli.
 * `depuis` : le bloc de départ (cible `node`), avec le même examen que `ouvertureApi(graph, depuis)`.
 */
export function modeleDOuverture(graph: WorkflowGraph, depuis?: string): { templateName: string; language: string } | null {
  const premier = scanOpening(graph, depuis).firstTemplate;
  const a = premier ? actionOf(premier) : null;
  return a?.kind === 'sendTemplate' ? { templateName: a.templateName, language: a.language } : null;
}
