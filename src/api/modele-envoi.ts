import type { TemplateSummary } from '../meta/templates';
import { carouselSendBlocker, headerMediaSendBlocker } from '../meta/template-components';
import { countTemplateVariables } from '../crm/template';
import { estLienTraceAvecJeton } from '../links/rewrite';

/**
 * CE QU'UN ENVOI PAR L'API SAIT D'UN TEMPLATE, lu chez Meta (spec 2026-09-24, § 3).
 *
 * 🔴 LA CATÉGORIE N'EST PLUS DÉCLARÉE PAR L'APPELANT. Déclarée, un template marketing annoncé « utility »
 * partait aux contacts dont le consentement est inconnu. L'Inbox la lit déjà chez Meta
 * (`categorieDuModele`) ; l'API fait de même, avec la même lecture partagée (`templateVarInfo`) et son cache.
 *
 * ⚠️ `absent` couvre trois cas qu'un intégrateur corrige de la même façon : introuvable, pas encore approuvé
 * (ou refusé), ou d'une autre langue. La lecture partagée retombe sur le NOM SEUL quand la langue ne
 * correspond pas, ce qui convient au worker et pas à l'API : un envoi vise une langue précise.
 *
 * ⚠️ `illisible` n'est JAMAIS ramené à « utility » : dans le doute, l'envoi est refusé, comme dans l'Inbox.
 *
 * ⚠️ `categorie_non_admise` N'EST PAS `illisible` : la catégorie a été LUE (`authentication`, par exemple), et
 * elle n'est pas de celles que l'API envoie. Réessayer ne changera jamais rien, et le message doit le dire au
 * lieu d'inviter l'intégrateur à recommencer.
 *
 * 🔴 `non_envoyable` : approuvé, d'une catégorie admise, et pourtant AUCUN envoi ne peut partir (un paramètre
 * que personne ne remplit, un visuel absent). Le catalogue l'écartait déjà ; l'envoi l'acceptait en 201, puis
 * chaque destinataire échouait. Les deux jugent désormais par la MÊME fonction (`raisonNonEnvoyable`).
 */
export type LectureModele =
  /**
   * `variables` : le nombre de variables du CORPS (la plus haute position `{{n}}`, `countTemplateVariables`),
   * celui que Meta exige à chaque envoi. `params` doit en décrire exactement autant (`src/http/v1-sends.ts`).
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
   * Pourquoi AUCUN envoi de ce template ne peut partir (`raisonNonEnvoyable`), `null` s'il le peut. REQUIS : une
   * lecture qui l'oublierait ne compile pas, au lieu de laisser passer en silence ce que le catalogue écarte.
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
 * POURQUOI AUCUN ENVOI DE CE TEMPLATE NE PEUT PARTIR, ou `null`. UNE fonction pour ses deux lecteurs : le
 * catalogue (`GET /v1/templates`), qui ne montre pas ce qui ne partirait pas, et l'envoi (`POST /v1/sends`, par
 * `modeleLuDe` dans la lecture partagée), qui le refuse en 422 au lieu d'un 201 suivi d'un échec par destinataire.
 * Écrite deux fois, elles divergeraient, et la divergence serait muette.
 *
 * - un en-tête d'un format qu'un envoi ne sait pas remplir (localisation) ;
 * - ce que le moteur d'envoi refuse avant de partir, par SES fonctions : carte ou lien de carte à variable, carte
 *   ou en-tête média sans visuel (`carouselSendBlocker`, `headerMediaSendBlocker`). ⚠️ À l'envoi, chaque visuel
 *   est RE-TÉLÉVERSÉ depuis son adresse pour obtenir son identifiant ; on ne téléverse rien ici, donc l'adresse
 *   tient lieu d'identifiant : sans elle, l'envoi n'en aura jamais. Seul reste imprévisible un
 *   re-téléversement qui échoue le jour de l'envoi ;
 * - un paramètre qu'AUCUN chemin d'envoi ne remplit, et que Meta exigerait (132000) : un en-tête TEXTE à variable
 *   (`buildTemplateComponents` ne produit que l'en-tête média), un bouton de lien de premier niveau dont
 *   l'adresse porte une variable, sauf un lien tracé à jeton (le seul suffixe que l'envoi fournit,
 *   `suffixesBoutons`). Les boutons de CARTE sont jugés par `carouselSendBlocker`.
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
 * CE QU'UN ENVOI SAIT D'UN TEMPLATE, construit depuis ce que Meta en rend. UNE construction pour ses deux
 * lecteurs : la lecture partagée (`templateVarInfo`, `src/workflow/wiring.ts`), que `POST /v1/sends` juge, et le
 * catalogue. Meta rend la catégorie en majuscules, on la passe en minuscules ; une catégorie vide est ABSENTE
 * (donc illisible, jamais « utility »).
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
