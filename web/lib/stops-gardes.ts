/**
 * Qui lève un STOP, en une phrase pour l'opérateur : la table `LEVE_UN_STOP` de `src/crm/transition-consentement.ts`
 * (la fiche, la personne, l'import CSV case cochée, le bloc « Action » d'un scénario ; jamais l'action en masse). Une
 * seule phrase pour les deux endroits de l'action en masse qui la disent, l'avertissement avant et le compte après :
 * écrites chacune de leur côté, elles avaient divergé, et oubliaient toutes deux l'import et le scénario.
 */
export function quiLeveUnStop(t: (fr: string, en?: string) => string): string {
  return t(
    'un STOP se lève depuis la fiche du contact, par la personne elle-même, par un import CSV case cochée ou par un scénario.',
    'a STOP is lifted from the contact’s record, by the person themselves, by a CSV import with the box ticked, or by a scenario.',
  );
}

/**
 * Le message de l'action en masse « Passer en opt-in » quand des fiches ont gardé leur STOP : l'action en masse ne
 * lève pas un STOP (`src/crm/transition-consentement.ts`), et le message dit qui le peut (`quiLeveUnStop`).
 *
 * ⚠️ La réponse est lue sans confiance : une API plus ancienne que la console ne renvoie pas `stopsGardes` (Vercel
 * publie l'écran avant le déploiement de l'API). Absent, nul ou illisible : aucun message, l'écran se comporte comme
 * avant.
 */
export function avisStopsGardes(reponse: { stopsGardes?: unknown }, t: (fr: string, en?: string) => string): string | null {
  const n = reponse.stopsGardes;
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) return null;
  const raison = quiLeveUnStop(t);
  return n === 1
    ? t(`1 fiche a gardé son STOP : ${raison}`, `1 contact kept their STOP: ${raison}`)
    : t(`${n} fiches ont gardé leur STOP : ${raison}`, `${n} contacts kept their STOP: ${raison}`);
}
