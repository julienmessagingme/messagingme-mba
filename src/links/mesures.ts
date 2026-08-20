import type { LienTrace } from './tracked-links.pg';

/**
 * Les clics sur les liens tracés, rendus sous la forme d'un compteur de bloc pour « Analytics > Mes tableaux ».
 *
 * Ces compteurs ne viennent PAS de `workflow_node_events` et ne peuvent pas en venir : cette table exige un
 * `wa_id` NOT NULL, or un clic sur un lien de template arrive sans identité (le lien est le même pour tous
 * les destinataires). Ils sont donc calculés ici et FUSIONNÉS à la lecture, ce qui laisse l'écran inchangé.
 *
 * ⚠️ Ce que ce compteur dit vraiment : les clics reçus par LE LIEN DU TEMPLATE, pas les clics des envois de
 * ce bloc. Si le même template sert dans deux blocs ou aussi dans une campagne, les deux blocs affichent le
 * même total. C'est la conséquence directe d'un lien par template, et l'écran doit le dire.
 */

/** Un bloc de scénario qui envoie un template, et lequel. */
export interface NoeudTemplate {
  nodeId: string;
  templateName: string;
  templateLanguage: string;
}

/** Le compteur tel que l'écran le consomme (miroir de `NodeEventCount`, sans dépendre de son enum de nature). */
export interface CompteurClic {
  nodeId: string;
  kind: 'url_click';
  handle: string;
  count: number;
  /** TOUJOURS null : un clic sur un lien statique n'identifie personne. Voir `CompteurBrut.contacts`. */
  contacts: null;
}

/** Le handle d'un bouton, dans la convention du graphe (`btn:i`, ou `card:c:btn:b` pour un carousel). */
export function handleDuBouton(cardIndex: number | null, buttonIndex: number): string {
  return cardIndex === null ? `btn:${buttonIndex}` : `card:${cardIndex}:btn:${buttonIndex}`;
}

/**
 * Les blocs d'un graphe qui envoient un template, avec le template visé.
 *
 * Le graphe est un jsonb : on ne fait AUCUNE hypothèse de forme, on lit défensivement. Un bloc sans nom ou
 * sans langue de template est ignoré plutôt que rattrapé : apparier sur le seul nom compterait les clics de
 * TOUTES les langues du même template, et gonflerait le chiffre sans que personne ne s'en aperçoive.
 */
export function noeudsTemplate(graph: unknown): NoeudTemplate[] {
  const nodes = (graph as { nodes?: unknown } | null)?.nodes;
  if (!Array.isArray(nodes)) return [];
  const out: NoeudTemplate[] = [];
  for (const raw of nodes) {
    const n = raw as { id?: unknown; type?: unknown; data?: { templateName?: unknown; language?: unknown } };
    if (n?.type !== 'template' || typeof n.id !== 'string') continue;
    const nom = typeof n.data?.templateName === 'string' ? n.data.templateName.trim() : '';
    const langue = typeof n.data?.language === 'string' ? n.data.language.trim() : '';
    if (nom === '' || langue === '') continue;
    out.push({ nodeId: n.id, templateName: nom, templateLanguage: langue });
  }
  return out;
}

/**
 * Un compteur par (bloc, bouton tracé), MÊME À ZÉRO.
 *
 * Le zéro n'est pas du bruit : c'est lui qui rend la mesure cochable avant le premier clic. Sans ligne, la
 * case n'apparaîtrait qu'une fois quelqu'un ayant cliqué, et l'opérateur ne pourrait pas préparer son tableau
 * avant de lancer sa campagne.
 */
export function compteursDeClics(
  noeuds: readonly NoeudTemplate[],
  liens: readonly LienTrace[],
  clicsParCode: Readonly<Record<string, number>>,
): CompteurClic[] {
  const out: CompteurClic[] = [];
  for (const n of noeuds) {
    for (const l of liens) {
      if (l.templateName !== n.templateName || l.templateLanguage !== n.templateLanguage) continue;
      out.push({
        nodeId: n.nodeId,
        kind: 'url_click',
        handle: handleDuBouton(l.cardIndex, l.buttonIndex),
        count: clicsParCode[l.code] ?? 0,
        contacts: null,
      });
    }
  }
  return out;
}
