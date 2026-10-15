/**
 * LA MÉDIATHÈQUE CÔTÉ CONSOLE (spec `docs/superpowers/specs/2026-10-14-medias-message-rapide-design.md`, lot B) : le poids
 * des fichiers tel qu'on le lit, et ce qui empêche d'en supprimer un.
 */

type Traduire = (fr: string, en?: string) => string;

/** Ce qui cite encore un fichier (`UtilisationMedia`, `src/rcs/media-store.pg.ts`). Le lieu reste une chaîne : un serveur
 *  plus récent peut en ajouter un, qui se nomme alors sans article plutôt que de faire échouer le refus. */
export interface UtilisationMedia {
  lieu: string;
  nom: string;
}

const MO = 1024 * 1024;

/** Un poids en Ko sous le mégaoctet, en Mo au-delà (une décimale quand elle dit quelque chose). */
export function poids(octets: number): string {
  if (octets < MO) return `${Math.round(octets / 1024)} Ko`;
  const mo = Math.round((octets / MO) * 10) / 10;
  return `${String(mo).replace('.', ',')} Mo`;
}

const LIEUX: Record<string, (t: Traduire) => string> = {
  scenario: (t) => t('le scénario', 'the scenario'),
  message_rcs: (t) => t('le message RCS', 'the RCS message'),
  campagne: (t) => t('la campagne', 'the campaign'),
  brouillon_campagne: (t) => t('le brouillon de campagne', 'the campaign draft'),
};

/** « Utilisé par le scénario « X » et la campagne « Y ». » : le refus d'une suppression, dit à l'écran. */
export function phraseUtilisations(liste: readonly UtilisationMedia[], t: Traduire): string {
  const noms = liste.map((u) => {
    const article = LIEUX[u.lieu];
    return article ? `${article(t)} « ${u.nom} »` : `« ${u.nom} »`;
  });
  const enumeration = noms.length > 1 ? `${noms.slice(0, -1).join(', ')} ${t('et', 'and')} ${noms[noms.length - 1]}` : noms[0] ?? '';
  const suite = liste.length > 1
    ? t('Retirez-le d’abord de ces contenus.', 'Remove it from these first.')
    : t('Retirez-le d’abord de ce contenu.', 'Remove it from it first.');
  return `${t('Utilisé par', 'Used by')} ${enumeration}. ${suite}`;
}

/** La liste portée par un refus 409 (`code: 'media_utilise'`), ou null si le corps n'en est pas un. */
export function utilisationsDuRefus(corps: unknown): UtilisationMedia[] | null {
  if (typeof corps !== 'object' || corps === null) return null;
  const c = corps as { code?: unknown; utilisations?: unknown };
  if (c.code !== 'media_utilise' || !Array.isArray(c.utilisations)) return null;
  const liste: UtilisationMedia[] = [];
  for (const u of c.utilisations) {
    if (typeof u !== 'object' || u === null) return null;
    const { lieu, nom } = u as { lieu?: unknown; nom?: unknown };
    if (typeof lieu !== 'string' || typeof nom !== 'string') return null;
    liste.push({ lieu, nom });
  }
  return liste;
}
