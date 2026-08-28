/**
 * Le nom EXPOSÉ d'un outil, tel que le modèle l'appelle.
 *
 * 🔴 POURQUOI CETTE RÈGLE EXISTE DEUX FOIS. La colonne `agent_tools.name` porte un `check` en base
 * (`^[a-z0-9_]{1,64}$`, charset commun à OpenAI et Gemini) et la route le rejoue en 400. Sans normalisation
 * côté navigateur, le client tape « Poser un tag », reçoit un refus technique sur un champ qu'il croyait bon,
 * et n'a aucun moyen de deviner l'alphabet attendu. On lui applique donc la règle SOUS SES YEUX, comme pour
 * les codes de règles d'arrêt (`web/lib/agent-sorties.ts`).
 *
 * ⚠️ Ce n'est PAS la même règle que celle des codes de sortie : celle-là interdit le tiret bas aux extrémités
 * et s'arrête à 32 caractères, parce qu'un code de sortie devient un handle d'arête. Les mélanger ferait
 * refuser des noms d'outils parfaitement valides. `tests/web-agent-outils.test.ts` ancre celle-ci contre le
 * schéma de la route, que les deux builds ne partagent pas.
 */

export const MAX_NOM_OUTIL = 64;

export function normaliserNomOutil(brut: string): string {
  const propre = brut
    // Décomposer puis retirer les marques combinantes (`\p{M}`) : « poser_tâg » doit devenir « poser_tag »,
    // et non « poser_ta_g » comme le ferait un simple filtre sur l'alphabet.
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_{2,}/g, '_')
    .slice(0, MAX_NOM_OUTIL);
  // 🔴 Une saisie sans le moindre caractère alphanumérique (« --- », « ### », des espaces) se resserre en un
  // SEUL tiret bas, que la règle du serveur accepte : le champ enregistrerait alors « _ » comme nom d'outil
  // exposé au modèle, au lieu de rendre la main. On rend une chaîne vide, et l'appelant garde le nom
  // précédent. Même doctrine que `normaliserCodeSortie`, mais pas la même règle : ici `_debut` et `fin_` sont
  // des noms parfaitement valides, on ne peut donc pas se contenter de dépouiller les extrémités.
  return /[a-z0-9]/.test(propre) ? propre : '';
}
