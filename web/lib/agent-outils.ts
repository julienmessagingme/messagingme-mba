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

/**
 * 🔴 LES OUTILS PROPRES À L'AGENT IA, SECTION « TOUJOURS LÀ » (RC4, décision de Julien du 2026-10-06) : terminer,
 * passer à l'équipe, chercher dans la connaissance, lire la fiche, marquer urgent. Un interrupteur chacun, au-dessus de
 * la grille « Quel outil ajouter ? ». Aucun n'a de cible : ils se posent tels quels. L'ordre est celui de l'écran.
 * `tests/web-agent-outils.test.ts` les tient égaux aux handlers SANS cible du catalogue serveur.
 */
export const TOUJOURS_LA = ['terminer', 'escalader', 'chercher_connaissance', 'lire_contact', 'marquer_urgent'] as const;
export type HandlerToujoursLa = (typeof TOUJOURS_LA)[number];

export function estToujoursLa(handler: string): handler is HandlerToujoursLa {
  return (TOUJOURS_LA as readonly string[]).includes(handler);
}

/**
 * Les cartes de la grille qui posent un outil maison À CIBLE, et le handler qu'elles posent (RC4, alignés sur l'agent de
 * Meta : un tag, un champ, un bloc, un scénario fixés par l'administrateur). Tenu égal à `HANDLERS_A_CIBLE` du serveur
 * par `tests/web-agent-outils.test.ts`.
 */
export const HANDLER_DU_TYPE = {
  tag: 'poser_tag', champ: 'ecrire_variable', bloc: 'envoyer_bloc', scenario: 'lancer_scenario',
} as const;
export type TypeACible = keyof typeof HANDLER_DU_TYPE;

/** Le type de carte d'un handler à cible, ou `null`. */
export function typeDuHandler(handler: string): TypeACible | null {
  const trouve = (Object.keys(HANDLER_DU_TYPE) as TypeACible[]).find((t) => HANDLER_DU_TYPE[t] === handler);
  return trouve ?? null;
}

/** Une cible telle que l'écran la saisit (le format des composants de l'agent de Meta), pour un handler à cible. */
export type CibleSaisieAgent =
  | { type: 'tag'; tag: string }
  | { type: 'champ'; champ: string; valeurs: string[] }
  | { type: 'bloc'; workflowId: string; code: string }
  | { type: 'scenario'; workflowId: string };

const texte = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * La cible d'un outil posé, lue DÉFENSIVEMENT dans son `binding` (un jsonb opaque) : un champ absent devient vide, et
 * l'écran le montre comme une cible à refaire plutôt que de planter. `null` = handler sans cible.
 */
export function cibleDeLOutil(binding: Record<string, unknown>): CibleSaisieAgent | null {
  switch (typeDuHandler(texte(binding.handler))) {
    case 'tag': return { type: 'tag', tag: texte(binding.tag) };
    case 'champ': return {
      type: 'champ', champ: texte(binding.champ),
      valeurs: Array.isArray(binding.valeurs) ? binding.valeurs.filter((v): v is string => typeof v === 'string') : [],
    };
    case 'bloc': return { type: 'bloc', workflowId: texte(binding.workflowId), code: texte(binding.code) };
    case 'scenario': return { type: 'scenario', workflowId: texte(binding.workflowId) };
    case null: return null;
  }
}

/** Le corps `cible` des routes de l'agent IA : sans `type` ni `handler`, que le serveur tire de l'outil. */
export function corpsDeLaCible(c: CibleSaisieAgent): Record<string, unknown> {
  switch (c.type) {
    case 'tag': return { tag: c.tag.trim() };
    case 'champ': return { champ: c.champ, valeurs: c.valeurs };
    case 'bloc': return { workflowId: c.workflowId, code: c.code };
    case 'scenario': return { workflowId: c.workflowId };
  }
}

/** La cible est-elle assez remplie pour partir ? (le serveur refuse le reste en 400, l'écran le dit avant). */
export function cibleComplete(c: CibleSaisieAgent): boolean {
  switch (c.type) {
    case 'tag': return c.tag.trim() !== '';
    case 'champ': return c.champ !== '';
    case 'bloc': return c.workflowId !== '' && c.code !== '';
    case 'scenario': return c.workflowId !== '';
  }
}
