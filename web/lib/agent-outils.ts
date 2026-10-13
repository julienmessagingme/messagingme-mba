/**
 * Le nom EXPOSÉ d'un outil, tel que le modèle l'appelle.
 *
 * 🔴 POURQUOI CETTE RÈGLE EXISTE DEUX FOIS. La colonne `agent_tools.name` porte un `check` en base
 * (`^[a-z0-9_]{1,64}$`, charset commun à OpenAI et Gemini) et la route le rejoue en 400. Sans normalisation
 * côté navigateur, le client tape « Poser un tag », reçoit un refus technique sur un champ qu'il croyait bon,
 * et n'a aucun moyen de deviner l'alphabet attendu. On lui applique donc la règle SOUS SES YEUX, comme pour
 * les codes de règles d'arrêt (`web/lib/partage/sorties-agent.ts`).
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
 * Meta : un tag, un champ, un bloc, un scénario fixés par l'administrateur ; plus l'action, propre à l'agent IA, plan
 * du 2026-10-13). Tenu égal à `HANDLERS_A_CIBLE` du serveur par `tests/web-agent-outils.test.ts`.
 */
export const HANDLER_DU_TYPE = {
  tag: 'poser_tag', champ: 'ecrire_variable', bloc: 'envoyer_bloc', scenario: 'lancer_scenario', action: 'declencher_action',
} as const;
export type TypeACible = keyof typeof HANDLER_DU_TYPE;

/** Le type de carte d'un handler à cible, ou `null`. */
export function typeDuHandler(handler: string): TypeACible | null {
  const trouve = (Object.keys(HANDLER_DU_TYPE) as TypeACible[]).find((t) => HANDLER_DU_TYPE[t] === handler);
  return trouve ?? null;
}

/**
 * LES ACTIONS (plan `docs/superpowers/plans/2026-10-13-actions-agent.md`) : recopies de `TYPES_CHAMP_ACTION`,
 * `BORNES_ACTION` et `CODE_CHAMP_ACTION_RE` du serveur (`src/agent/outils-maison.ts`), tenues égales par
 * `tests/web-agent-outils.test.ts` : les deux builds ne partagent pas ce module.
 */
export const TYPES_CHAMP_ACTION = ['texte', 'nombre', 'date', 'email', 'liste'] as const;
export type TypeChampAction = (typeof TYPES_CHAMP_ACTION)[number];
export const BORNES_ACTION = { nom: 60, consigne: 600, champs: 10, code: 40, libelle: 80, valeurs: 20, valeur: 60 } as const;
export const CODE_CHAMP_ACTION_RE = /^[a-z][a-z0-9_]{0,39}$/;

/** Un champ d'action tel que l'écran le saisit. `valeurs` ne sert qu'à une liste. */
export interface ChampActionSaisi { code: string; libelle: string; type: TypeChampAction; valeurs: string[] }

/** Une cible telle que l'écran la saisit (le format des composants de l'agent de Meta), pour un handler à cible. */
export type CibleSaisieAgent =
  | { type: 'tag'; tag: string }
  | { type: 'champ'; champ: string; valeurs: string[] }
  | { type: 'bloc'; workflowId: string; code: string }
  | { type: 'scenario'; workflowId: string }
  | { type: 'action'; nom: string; consigne: string; champs: ChampActionSaisi[] };
export type CibleActionSaisie = Extract<CibleSaisieAgent, { type: 'action' }>;

/**
 * Le code d'un champ, tiré de son libellé : la clé du champ dans `fields` du webhook, et le paramètre que le modèle
 * remplit. Même alphabet que le serveur (`CODE_CHAMP_ACTION_RE`) : une lettre d'abord. Chaîne vide si rien n'en reste.
 * `enFrappe` : le code se TAPE dans son propre champ, et le tiret bas final se garde, sinon « ref_ » redevient « ref »
 * avant qu'on ait tapé « client » (le serveur accepte un tiret bas final).
 */
export function normaliserCodeChamp(brut: string, enFrappe = false): string {
  const coupe = brut
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[^a-z]+/, '')
    .slice(0, BORNES_ACTION.code);
  const propre = enFrappe ? coupe : coupe.replace(/_+$/, '');
  return CODE_CHAMP_ACTION_RE.test(propre) ? propre : '';
}

/** Un code libre dans la liste : `motif`, puis `motif_2`, `motif_3`… */
export function codeLibre(base: string, pris: readonly string[]): string {
  const racine = base === '' ? 'champ' : base;
  if (!pris.includes(racine)) return racine;
  for (let i = 2; ; i += 1) {
    const suffixe = `_${i}`;
    const candidat = `${racine.slice(0, BORNES_ACTION.code - suffixe.length)}${suffixe}`;
    if (!pris.includes(candidat)) return candidat;
  }
}

type Bilingue = readonly [string, string];

/**
 * Ce qui manque à une action pour partir, dit avant que le serveur ne la refuse en 400 ; `null` = elle est prête. Les
 * bornes sont celles du serveur. Tous les champs restent facultatifs pour l'agent : seul ce qui les DÉCRIT est exigé.
 */
export function manqueDeLAction(c: CibleActionSaisie): Bilingue | null {
  if (c.nom.trim() === '') return ['Donnez un nom à l’action.', 'Name the action.'];
  if (c.nom.trim().length > BORNES_ACTION.nom || c.consigne.trim().length > BORNES_ACTION.consigne) {
    return [`Trop long : un nom fait ${BORNES_ACTION.nom} caractères au plus, une consigne ${BORNES_ACTION.consigne}.`,
      `Too long: a name is at most ${BORNES_ACTION.nom} characters, an instruction ${BORNES_ACTION.consigne}.`];
  }
  if (c.champs.length > BORNES_ACTION.champs) {
    return [`Au plus ${BORNES_ACTION.champs} champs.`, `At most ${BORNES_ACTION.champs} fields.`];
  }
  for (const ch of c.champs) {
    if (ch.libelle.trim() === '') return ['Chaque champ a un libellé.', 'Each field has a label.'];
    if (ch.libelle.trim().length > BORNES_ACTION.libelle) {
      return [`Un libellé fait ${BORNES_ACTION.libelle} caractères au plus.`, `A label is at most ${BORNES_ACTION.libelle} characters.`];
    }
    if (!CODE_CHAMP_ACTION_RE.test(ch.code)) {
      return [`Le code « ${ch.code} » : une lettre minuscule d’abord, puis lettres, chiffres ou tirets bas.`,
        `The code “${ch.code}”: a lowercase letter first, then letters, digits or underscores.`];
    }
    const valeurs = ch.valeurs.map((v) => v.trim()).filter((v) => v !== '');
    if (ch.type === 'liste' && valeurs.length === 0) return ['Une liste porte ses valeurs.', 'A list carries its values.'];
    if (valeurs.length > BORNES_ACTION.valeurs || valeurs.some((v) => v.length > BORNES_ACTION.valeur)) {
      return [`Une liste : ${BORNES_ACTION.valeurs} valeurs de ${BORNES_ACTION.valeur} caractères au plus.`,
        `A list: at most ${BORNES_ACTION.valeurs} values of ${BORNES_ACTION.valeur} characters.`];
    }
  }
  const codes = c.champs.map((ch) => ch.code);
  if (new Set(codes).size !== codes.length) return ['Deux champs portent le même code.', 'Two fields share the same code.'];
  return null;
}

/** Les mots de la carte « Déclencher une action », propre à l'agent IA (l'agent de Meta n'a pas cet outil). */
export const TEXTES_ACTION = {
  titre: ['Déclencher une action', 'Trigger an action'] as Bilingue,
  aide: [
    'Envoie une demande du client (résiliation, rappel, réclamation…) à votre application, par webhook, avec ce que l’agent a recueilli',
    'Sends a customer request (cancellation, callback, complaint…) to your application, by webhook, with what the agent collected',
  ] as Bilingue,
  quand: [
    'Appelle cet outil dès que le contact exprime la demande décrite dans la consigne de l’action, avec ce qu’il a déjà donné.',
    'Call this tool as soon as the contact expresses the request described in the action’s instruction, with what they already gave.',
  ] as Bilingue,
  pasQuand: [
    'N’appelle pas cet outil tant que le contact n’a pas clairement exprimé cette demande.',
    'Do not call this tool until the contact has clearly expressed this request.',
  ] as Bilingue,
} as const;

const texte = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Un champ d'action relu défensivement : un type inconnu devient « texte », une liste sans tableau n'a pas de valeurs. */
function champLu(c: unknown): ChampActionSaisi[] {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return [];
  const o = c as Record<string, unknown>;
  const type = (TYPES_CHAMP_ACTION as readonly string[]).includes(texte(o.type)) ? (o.type as TypeChampAction) : 'texte';
  const valeurs = Array.isArray(o.valeurs) ? o.valeurs.filter((v): v is string => typeof v === 'string') : [];
  return [{ code: texte(o.code), libelle: texte(o.libelle), type, valeurs }];
}

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
    case 'action': return {
      type: 'action', nom: texte(binding.nom), consigne: texte(binding.consigne),
      champs: Array.isArray(binding.champs) ? binding.champs.flatMap(champLu) : [],
    };
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
    // Une valeur de liste vide (une virgule de trop) ne part pas ; les valeurs ne partent que pour une liste.
    case 'action': return {
      nom: c.nom.trim(), consigne: c.consigne.trim(),
      champs: c.champs.map((ch) => ({
        code: ch.code, libelle: ch.libelle.trim(), type: ch.type,
        ...(ch.type === 'liste' ? { valeurs: ch.valeurs.map((v) => v.trim()).filter((v) => v !== '') } : {}),
      })),
    };
  }
}

/** La cible est-elle assez remplie pour partir ? (le serveur refuse le reste en 400, l'écran le dit avant). */
export function cibleComplete(c: CibleSaisieAgent): boolean {
  switch (c.type) {
    case 'tag': return c.tag.trim() !== '';
    case 'champ': return c.champ !== '';
    case 'bloc': return c.workflowId !== '' && c.code !== '';
    case 'scenario': return c.workflowId !== '';
    case 'action': return manqueDeLAction(c) === null;
  }
}
