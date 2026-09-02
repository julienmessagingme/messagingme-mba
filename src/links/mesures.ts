import type { LienTrace } from './tracked-links.pg';
import { estTracable } from './rcs-liens';

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
/** Un bouton lien d'un bloc RCS : où il mène, et sous quel nom l'écran le mesure. */
export interface LienRcsDeBloc {
  nodeId: string;
  /** `lien:<i>`, i étant la position du bouton dans `data.suggestions` du bloc. */
  handle: string;
  destination: string;
}

/**
 * Les boutons LIEN des blocs RCS d'un scénario.
 *
 * 🔴 UN ESPACE DE NOMS À PART (`lien:i`), ET C'EST NÉCESSAIRE. Les sorties d'un bloc RCS s'appellent déjà
 * `btn:0`, `btn:1`… mais elles ne comptent QUE les boutons réponse (`normaliserPostbacks`), un bouton lien ne
 * revenant jamais dans la conversation. Numéroter les liens dans le même espace ferait entrer en collision
 * « a cliqué sur le lien » et « a cliqué Oui » sur un même bloc, donc deux mesures différentes sous une même
 * clé, y compris dans les tableaux DÉJÀ enregistrés.
 *
 * L'index est celui de `data.suggestions`, la liste PLATE du bloc, et l'écran lit exactement la même liste
 * pour nommer le bouton : les deux ne peuvent pas diverger sur l'ordre.
 *
 * Lecture DÉFENSIVE d'un jsonb : aucune hypothèse de forme. Un bouton dont l'adresse ne serait pas traçable
 * est ignoré, pour la même raison qu'à l'envoi : rien ne l'aura tracé, sa mesure resterait à zéro pour
 * toujours et ferait croire à une absence de clics là où il n'y a pas de mesure.
 */
export function liensRcsDesNoeuds(graph: unknown): LienRcsDeBloc[] {
  const nodes = (graph as { nodes?: unknown } | null)?.nodes;
  if (!Array.isArray(nodes)) return [];
  const out: LienRcsDeBloc[] = [];
  for (const raw of nodes) {
    const n = raw as { id?: unknown; type?: unknown; data?: { suggestions?: unknown } };
    if (n?.type !== 'rcs_message' || typeof n.id !== 'string') continue;
    const boutons = Array.isArray(n.data?.suggestions) ? n.data.suggestions : [];
    boutons.forEach((b, i) => {
      const o = (b ?? {}) as { kind?: unknown; url?: unknown };
      if (o.kind !== 'openUrl' || typeof o.url !== 'string') return;
      const url = o.url.trim();
      if (!estTracable(url)) return;
      out.push({ nodeId: n.id as string, handle: `lien:${i}`, destination: url });
    });
  }
  return out;
}

/**
 * Un compteur par (bloc RCS, bouton lien), MÊME À ZÉRO et même sans code alloué.
 *
 * ⚠️ Sans code alloué n'est PAS une anomalie ici, contrairement au chemin WhatsApp : le code d'un lien RCS
 * naît au PREMIER ENVOI, pas à la soumission d'un template. Un scénario écrit mais jamais déclenché n'a donc
 * aucun code, et zéro est alors la vérité exacte : personne n'a cliqué, puisque rien n'est parti. Refuser la
 * ligne rendrait la mesure incochable tant que le scénario n'a pas tourné.
 */
export function compteursDeClicsRcs(
  liens: readonly LienRcsDeBloc[],
  codeParDestination: ReadonlyMap<string, string>,
  clicsParCode: Readonly<Record<string, number>>,
): CompteurClic[] {
  return liens.map((l) => {
    const code = codeParDestination.get(l.destination);
    return {
      nodeId: l.nodeId,
      kind: 'url_click' as const,
      handle: l.handle,
      count: code ? clicsParCode[code] ?? 0 : 0,
      contacts: null,
    };
  });
}

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
