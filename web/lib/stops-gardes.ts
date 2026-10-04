/**
 * Le message de l'action en masse « Passer en opt-in » quand des fiches ont gardé leur STOP : l'action en masse ne
 * lève pas un STOP (`src/crm/transition-consentement.ts`), seule la fiche du contact ou la personne elle-même le peut.
 *
 * ⚠️ La réponse est lue sans confiance : une API plus ancienne que la console ne renvoie pas `stopsGardes` (Vercel
 * publie l'écran avant le déploiement de l'API). Absent, nul ou illisible : aucun message, l'écran se comporte comme
 * avant.
 */
export function avisStopsGardes(reponse: { stopsGardes?: unknown }, t: (fr: string, en?: string) => string): string | null {
  const n = reponse.stopsGardes;
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) return null;
  const raison = t(
    'un STOP ne se lève que depuis la fiche du contact, ou par la personne elle-même.',
    'a STOP can only be lifted from the contact’s record, or by the person themselves.',
  );
  return n === 1
    ? t(`1 fiche a gardé son STOP : ${raison}`, `1 contact kept their STOP: ${raison}`)
    : t(`${n} fiches ont gardé leur STOP : ${raison}`, `${n} contacts kept their STOP: ${raison}`);
}
