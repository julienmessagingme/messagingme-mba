/**
 * Les libellés des valeurs système d'une variable de connecteur (`CLES_SYSTEME` de `src/agent/variables.ts`), en
 * français et en anglais. Le serveur envoie les clés dans le catalogue, la console les nomme ici : une clé
 * inconnue s'affiche telle quelle plutôt que sous le libellé d'une autre, et `tests/web-valeurs-systeme.test.ts`
 * exige un libellé pour chaque clé du serveur.
 */
export const LIBELLES_VALEURS_SYSTEME: Record<string, [string, string]> = {
  derniere_saisie: ['dernier message du contact', 'contact’s last message'],
  maintenant: ['date et heure courantes', 'current date and time'],
};

export function libelleValeurSysteme(cle: string): [string, string] {
  return LIBELLES_VALEURS_SYSTEME[cle] ?? [cle, cle];
}
