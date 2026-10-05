/**
 * LE RÉPONDEUR DE L'ESPACE, CÔTÉ CONSOLE (lot 5, livraison B ; spec
 * `docs/superpowers/specs/2026-10-04-repondeur-par-defaut-design.md`, § 3) : l'agent IA qui répond à tout message que
 * ni un scénario, ni un mot-clé, ni un membre de l'équipe ne tient. Le serveur tient la règle (une seule voix, un agent
 * ACTIF, `src/repondeur/reglage.ts`) ; ce module ne fait que lire ses réponses et dire ce qu'un geste va changer.
 * Fonctions pures, testées dans `repondeur.test.ts`.
 */

/** Ce que rend `PUT /tenants/:tenantId/agents/repondeur` (`ReglageRepondeur` côté serveur). */
export interface ReglageRepondeur {
  repondeurAgentId: string | null;
  /** L'agent de Meta était allumé, et ce geste vient de l'éteindre pour tous les contacts de l'espace. */
  agentDeMetaEteint: boolean;
  /** Les contacts retirés de la liste de l'agent de Meta, et ceux que Meta a refusé de retirer (ils y restent). */
  liste: { retires: number; refuses: number };
}

const estObjet = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const entier = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

/**
 * La réponse du geste, vérifiée et non castée : elle vient du réseau. `null` quand l'agent désigné n'y est pas lisible,
 * et l'écran relit alors la liste plutôt que d'afficher un état qu'il a supposé. 🔴 Un compte de refus illisible vaut
 * zéro : l'écran ne doit pas inventer des contacts muets, et le serveur journalise de toute façon chaque refus.
 */
export function lireReglageRepondeur(brut: unknown): ReglageRepondeur | null {
  if (!estObjet(brut)) return null;
  const id = brut.repondeurAgentId;
  if (id !== null && typeof id !== 'string') return null;
  const liste = estObjet(brut.liste) ? brut.liste : {};
  return {
    repondeurAgentId: id,
    agentDeMetaEteint: brut.agentDeMetaEteint === true,
    liste: { retires: entier(liste.retires), refuses: entier(liste.refuses) },
  };
}

/**
 * Un répondeur automatique répond-il dans cet espace aux messages que personne ne tient : l'agent de Meta allumé, ou un
 * agent IA désigné (jamais les deux) ? Miroir de `unRepondeurRepond` (`src/inbox/fil.ts`). C'est la question des choix
 * « le répondeur automatique prend la main » des campagnes et des publicités : sans répondeur, la réponse n'irait à
 * personne. `null` = on ne sait pas (réglages illisibles, ou sans `mbaEnabled`). `repondeurAgentId` absent (API plus
 * ancienne) vaut « aucun agent IA » : le comportement d'avant.
 */
export function repondeurAutomatique(s: { mbaEnabled?: unknown; repondeurAgentId?: unknown } | null): boolean | null {
  if (s === null || typeof s.mbaEnabled !== 'boolean') return null;
  return s.mbaEnabled || typeof s.repondeurAgentId === 'string';
}

/** Le champ `repondeurAgentId` de `GET /agents`. `undefined` = absent (API plus ancienne) : on ne sait pas. */
export function lireRepondeurAgentId(v: unknown): string | null | undefined {
  if (v === null || typeof v === 'string') return v;
  return undefined;
}

/**
 * Les agents qu'on peut désigner : les ACTIFS seulement, comme le serveur l'exige (un brouillon n'a pas été relu, un
 * agent désactivé a été coupé exprès). Le répondeur actuel reste dans la liste même s'il n'y figure plus (une liste
 * relue avant sa désactivation) : sinon le choix afficherait « Aucun » sur un réglage qui ne l'est pas.
 */
export function agentsProposables<A extends { id: string; status: string }>(agents: readonly A[], repondeurAgentId: string | null): A[] {
  return agents.filter((a) => a.status === 'active' || a.id === repondeurAgentId);
}

type T = (fr: string, en?: string) => string;

/**
 * La phrase des contacts que Meta a refusé de retirer de la liste de son agent (relecture de la livraison A, J6). Ils y
 * restent : leurs messages arrivent chez nous en `standby`, et l'agent de Meta est éteint, donc personne ne leur
 * répond automatiquement. `null` quand il n'y en a pas.
 */
export function phraseContactsNonRetires(refuses: number, t: T): string | null {
  if (refuses <= 0) return null;
  const qui = refuses === 1
    ? t('1 contact n’a pas pu être retiré', '1 contact could not be removed')
    : t(`${refuses} contacts n’ont pas pu être retirés`, `${refuses} contacts could not be removed`);
  return t(
    `${qui} de la liste de l’agent de Meta : leurs messages n’auront pas de réponse automatique. Vous les retrouverez dans l’Inbox ; pour réessayer, choisissez « Aucun », puis de nouveau cet agent.`,
    `${qui} from Meta’s agent list: their messages will get no automatic answer. You will find them in the Inbox; to try again, choose “None”, then this agent again.`,
  );
}

/** L'état de l'agent de Meta dans `GET /settings` : `null` = illisible (réglages absents, ou sans `mbaEnabled`). */
export function lireMbaAllume(s: { mbaEnabled?: unknown } | null): boolean | null {
  return s !== null && typeof s.mbaEnabled === 'boolean' ? s.mbaEnabled : null;
}

/**
 * La question à poser avant d'enregistrer le répondeur, ou `null` quand le geste ne coupe personne (relecture de la
 * livraison B, JB3 et JB5). `vers` : le nom de l'agent choisi, `null` pour « Aucun » ; `depuis` : celui du répondeur
 * actuel. `mbaAllume` est lu AU MOMENT du geste, jamais au chargement : rallumé ailleurs entre-temps, il serait éteint
 * sans question.
 * - « Aucun » : plus aucun agent IA ne répond aux messages que personne ne tient, l'effet même de la désactivation de
 *   l'agent répondeur, que sa fiche fait confirmer.
 * - Un agent IA : l'agent de Meta est éteint pour tous les contacts s'il est allumé. 🔴 Un état ILLISIBLE fait
 *   confirmer, au conditionnel : seul un agent de Meta LU éteint dispense de la question.
 */
export function confirmationRepondeur(
  geste: { vers: string | null; depuis: string | null }, mbaAllume: boolean | null, t: T,
): { titre: string; message: string; confirmer: string } | null {
  if (geste.vers === null) {
    const qui = geste.depuis !== null ? t(`« ${geste.depuis} » ne sera plus`, `“${geste.depuis}” will no longer be`) : t('Aucun agent ne sera', 'No agent will be');
    return {
      titre: t('Retirer le répondeur', 'Remove the responder'),
      message: t(
        `${qui} le répondeur de l’espace : plus aucun agent IA ne répondra aux messages que personne ne tient.`,
        `${qui} the workspace responder: no AI agent will answer the messages nobody handles anymore.`,
      ),
      confirmer: t('Retirer', 'Remove'),
    };
  }
  if (mbaAllume === false) return null;
  return {
    titre: t('Changer de répondeur', 'Change responder'),
    // Au conditionnel quand on n'a pas pu lire l'état de l'agent de Meta : on ne déclare pas allumé ce qu'on n'a pas lu.
    message: mbaAllume === true
      ? t(
        `« ${geste.vers} » deviendra le répondeur de l’espace, et l’agent de Meta sera éteint pour tous vos contacts de cet espace, conversations en cours comprises.`,
        `“${geste.vers}” will become the workspace responder, and Meta’s agent will be turned off for all your contacts in this workspace, ongoing conversations included.`,
      )
      : t(
        `« ${geste.vers} » deviendra le répondeur de l’espace. Si l’agent de Meta est allumé, il sera éteint pour tous vos contacts de cet espace, conversations en cours comprises.`,
        `“${geste.vers}” will become the workspace responder. If Meta’s agent is on, it will be turned off for all your contacts in this workspace, ongoing conversations included.`,
      ),
    confirmer: t('Confirmer', 'Confirm'),
  };
}

/**
 * Ce qu'allumer l'agent de Meta retire, dit AVANT le geste (relecture de la livraison A, J7). Le serveur remet le
 * répondeur IA à nul dans l'instruction même qui allume l'agent de Meta (`setMbaEnabled`) : une seule voix. `null`
 * quand aucun agent IA n'est répondeur, et rien n'est à dire.
 */
export function avertissementAllumageMeta(repondeur: { label: string } | null, t: T): string | null {
  if (repondeur === null) return null;
  const nom = repondeur.label.trim();
  // Un nom illisible (agent absent de la liste relue) ne bloque rien : la phrase le dit sans lui.
  const qui = nom !== ''
    ? t(`L’agent IA « ${nom} » est`, `The AI agent “${nom}” is`)
    : t('Un agent IA est', 'An AI agent is');
  return t(
    `${qui} aujourd’hui le répondeur de l’espace. Allumer l’agent de Meta le retire de ce rôle : c’est l’agent de Meta qui répondra aux messages que personne ne tient.`,
    `${qui} currently the workspace responder. Turning Meta’s agent on removes it from that role: Meta’s agent will answer the messages nobody handles.`,
  );
}
