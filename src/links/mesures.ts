import type { LienTrace } from './tracked-links.pg';
import { estTracable } from './rcs-liens';

/**
 * Les clics sur les liens tracés, rendus comme compteurs de bloc pour « Analytics > Mes tableaux ».
 *
 * Ils ne peuvent pas venir de `workflow_node_events`, qui exige un `wa_id` NOT NULL : un clic sur un lien de
 * template arrive sans identité. On les calcule ici et on les fusionne à la lecture.
 * Le compteur dit les clics reçus par le lien du template, pas ceux des envois de ce bloc : deux blocs (ou une
 * campagne) sur le même template affichent le même total, et l'écran doit le dire.
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
  /** Toujours null : un clic sur un lien statique n'identifie personne. Voir `CompteurBrut.contacts`. */
  contacts: null;
}

/** Le handle d'un bouton, dans la convention du graphe (`btn:i`, ou `card:c:btn:b` pour un carousel). */
export function handleDuBouton(cardIndex: number | null, buttonIndex: number): string {
  return cardIndex === null ? `btn:${buttonIndex}` : `card:${cardIndex}:btn:${buttonIndex}`;
}

/**
 * Les blocs d'un graphe qui envoient un template, avec le template visé (lecture défensive du jsonb).
 * Un bloc sans nom ou sans langue est ignoré : apparier sur le seul nom compterait les clics de toutes les
 * langues du template.
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

/** Un bouton lien d'un bloc RCS : où il mène, et sous quel nom l'écran le mesure. */
export interface LienRcsDeBloc {
  nodeId: string;
  /** `lien:<i>`, i étant la position du bouton dans `data.suggestions` du bloc. */
  handle: string;
  destination: string;
}

/**
 * Les boutons lien des blocs RCS d'un scénario.
 *
 * Espace de noms à part (`lien:i`) : les sorties `btn:i` d'un bloc RCS ne comptent que les boutons réponse
 * (`normaliserPostbacks`). Les numéroter ensemble mettrait « a cliqué le lien » et « a cliqué Oui » sous une même
 * clé, y compris dans les tableaux déjà enregistrés.
 * L'index est celui de `data.suggestions`, la liste plate que l'écran lit aussi pour nommer le bouton.
 * Un bouton dont l'adresse n'est pas traçable est ignoré, comme à l'envoi : sa mesure resterait à zéro et ferait
 * croire à une absence de clics.
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
 * Un compteur par (bloc RCS, bouton lien), même à zéro et même sans code alloué : le code d'un lien RCS naît au
 * premier envoi, donc un scénario jamais déclenché n'en a pas, et zéro est alors exact.
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

/**
 * Un compteur par (bloc, bouton tracé), même à zéro : c'est ce qui rend la mesure cochable avant le premier
 * clic, pour préparer son tableau avant de lancer la campagne.
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
