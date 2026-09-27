import type { TemplateSummary } from '../meta/templates';
import { carouselSendBlocker, headerMediaSendBlocker } from '../meta/template-components';
import { countTemplateVariables } from '../crm/template';
import { estLienTraceAvecJeton } from '../links/rewrite';

/**
 * Ce qu'un envoi par l'API sait d'un template, lu chez Meta.
 *
 * 🔴 La catégorie n'est pas déclarée par l'appelant : un template marketing annoncé « utility » partirait aux
 * contacts dont le consentement est inconnu. Elle se lit chez Meta, par la lecture partagée de l'Inbox
 * (`templateVarInfo`) et son cache.
 *
 * - `absent` : introuvable, pas approuvé, ou d'une autre langue (l'API vise une langue précise, sans repli
 *   sur le nom seul) ;
 * - `illisible` n'est jamais ramené à « utility » : dans le doute, l'envoi est refusé ;
 * - `categorie_non_admise` : la catégorie est lue mais pas de celles que l'API envoie, réessayer n'y changera
 *   rien ;
 * - `non_envoyable` : approuvé, mais aucun envoi ne peut partir ; catalogue et envoi jugent par la même
 *   fonction (`raisonNonEnvoyable`).
 */
export type LectureModele =
  /**
   * `variables` : le nombre de variables du corps (la plus haute position `{{n}}`), celui que Meta exige à
   * chaque envoi ; `params` doit en décrire exactement autant.
   */
  | { statut: 'approuve'; categorie: 'marketing' | 'utility'; variables: number }
  | { statut: 'absent' }
  | { statut: 'illisible' }
  | { statut: 'categorie_non_admise'; categorie: string }
  | { statut: 'non_envoyable'; raison: string };

/** Ce que la lecture partagée rend d'un template (`TplInfo`, `src/workflow/wiring.ts`), réduit à ce qui sert ici. */
export interface ModeleLu {
  statut?: string;
  langue?: string;
  category?: string;
  /** Le nombre de variables du corps, tel que la lecture partagée le calcule. */
  count: number;
  /**
   * Pourquoi aucun envoi de ce template ne peut partir (`raisonNonEnvoyable`), `null` s'il le peut. Requis :
   * une lecture qui l'oublierait ne compile pas, au lieu de laisser passer ce que le catalogue écarte.
   */
  nonEnvoyable: string | null;
}

/**
 * Les formats d'en-tête qu'un envoi sait porter. Un `Set` et pas un objet littéral : sur un objet, un format que
 * Meta inventerait demain sous le nom `toString` y serait « trouvé ».
 */
const ENTETES_ENVOYABLES: ReadonlySet<string> = new Set(['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT']);

/** Ce que `raisonNonEnvoyable` lit d'un template, tel que Meta le rend (`TemplateSummary`). */
export type FormeDuModele = Pick<TemplateSummary, 'headerFormat' | 'headerText' | 'headerMediaUrl' | 'buttons' | 'carousel'>;

/**
 * Pourquoi aucun envoi de ce template ne peut partir, ou `null`. Une fonction pour ses deux lecteurs : le
 * catalogue (`GET /v1/templates`) et l'envoi (`POST /v1/sends`), qui refuse en 422 au lieu d'un 201 suivi
 * d'un échec par destinataire.
 *
 * - un en-tête d'un format qu'un envoi ne sait pas remplir (localisation) ;
 * - ce que le moteur d'envoi refuse avant de partir, par ses fonctions (`carouselSendBlocker`,
 *   `headerMediaSendBlocker`) ; l'adresse d'un visuel tient lieu de l'identifiant que l'envoi obtiendra en
 *   le re-téléversant ;
 * - un paramètre qu'aucun chemin d'envoi ne remplit et que Meta exigerait (132000) : un en-tête texte à
 *   variable, un bouton de lien de premier niveau à variable, sauf un lien tracé à jeton.
 */
export function raisonNonEnvoyable(t: FormeDuModele): string | null {
  if (t.headerFormat !== null && !ENTETES_ENVOYABLES.has(t.headerFormat)) {
    return `son en-tête (${t.headerFormat.slice(0, 20).toLowerCase()}) ne se remplit pas à l’envoi`;
  }
  if (t.carousel) {
    const carte = carouselSendBlocker(t.carousel.cards.map((c) => ({ ...c, mediaId: c.mediaId ?? c.mediaUrl })));
    if (carte !== null) return carte;
  }
  const entete = headerMediaSendBlocker(t.headerFormat ?? undefined, t.headerMediaUrl);
  if (entete !== null) return entete;
  if (t.headerFormat === 'TEXT' && countTemplateVariables(t.headerText ?? '') > 0) {
    return 'son en-tête texte porte une variable, qu’aucun envoi ne remplit';
  }
  const bouton = (t.buttons ?? []).find((b) => b.type === 'URL' && countTemplateVariables(b.url ?? '') > 0 && !estLienTraceAvecJeton(b.url ?? ''));
  if (bouton) return `son bouton de lien « ${bouton.text.slice(0, 40)} » porte une variable, qu’aucun envoi ne remplit`;
  return null;
}

/**
 * Ce qu'un envoi sait d'un template, construit depuis ce que Meta en rend, pour la lecture partagée et le
 * catalogue. Catégorie passée en minuscules ; une catégorie vide est absente (donc illisible, jamais
 * « utility »).
 */
export function modeleLuDe(t: TemplateSummary): ModeleLu & { statut: string; langue: string } {
  return {
    count: countTemplateVariables(t.body),
    statut: t.status,
    langue: t.language,
    ...(t.category ? { category: t.category.toLowerCase() } : {}),
    nonEnvoyable: raisonNonEnvoyable(t),
  };
}

export function verdictModele(info: ModeleLu | null, langue: string): LectureModele {
  if (info === null || info.langue !== langue || info.statut !== 'APPROVED') return { statut: 'absent' };
  if (info.category === 'marketing' || info.category === 'utility') {
    if (info.nonEnvoyable !== null) return { statut: 'non_envoyable', raison: info.nonEnvoyable };
    return { statut: 'approuve', categorie: info.category, variables: info.count };
  }
  if (info.category !== undefined && info.category !== '') return { statut: 'categorie_non_admise', categorie: info.category };
  return { statut: 'illisible' };
}
