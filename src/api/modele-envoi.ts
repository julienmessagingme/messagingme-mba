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
 */
export type LectureModele =
  | { statut: 'approuve'; categorie: 'marketing' | 'utility' }
  | { statut: 'absent' }
  | { statut: 'illisible' }
  | { statut: 'categorie_non_admise'; categorie: string };

/** Ce que la lecture partagée rend d'un template (`TplInfo`, `src/workflow/wiring.ts`), réduit à ce qui sert ici. */
export interface ModeleLu {
  statut?: string;
  langue?: string;
  category?: string;
}

export function verdictModele(info: ModeleLu | null, langue: string): LectureModele {
  if (info === null || info.langue !== langue || info.statut !== 'APPROVED') return { statut: 'absent' };
  if (info.category === 'marketing' || info.category === 'utility') return { statut: 'approuve', categorie: info.category };
  if (info.category !== undefined && info.category !== '') return { statut: 'categorie_non_admise', categorie: info.category };
  return { statut: 'illisible' };
}
