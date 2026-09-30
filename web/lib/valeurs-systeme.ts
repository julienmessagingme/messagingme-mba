/**
 * Les libellés des valeurs système d'une variable de connecteur (`CLES_SYSTEME` de `src/agent/variables.ts`), en
 * français et en anglais. Le serveur envoie les clés dans le catalogue, la console les nomme ici : une clé
 * inconnue s'affiche telle quelle plutôt que sous le libellé d'une autre, et `tests/web-valeurs-systeme.test.ts`
 * exige un libellé pour chaque clé du serveur.
 */
export const LIBELLES_VALEURS_SYSTEME: Record<string, [string, string]> = {
  derniere_saisie: ['dernier message du contact', 'contact’s last message'],
  maintenant: ['date et heure courantes', 'current date and time'],
  analyse_intention: ['intention de la dernière analyse', 'intent from the last analysis'],
  analyse_sentiment: ['sentiment de la dernière analyse', 'sentiment from the last analysis'],
  analyse_satisfaction: ['satisfaction de la dernière analyse (0 à 10)', 'satisfaction from the last analysis (0 to 10)'],
  analyse_urgence: ['urgence de la dernière analyse (0 à 10)', 'urgency from the last analysis (0 to 10)'],
  analyse_resolue: ['dernière conversation résolue (oui/non)', 'last conversation resolved (yes/no)'],
  risque_depart: ['risque de départ du contact', 'contact’s churn risk'],
};

export function libelleValeurSysteme(cle: string): [string, string] {
  return LIBELLES_VALEURS_SYSTEME[cle] ?? [cle, cle];
}
