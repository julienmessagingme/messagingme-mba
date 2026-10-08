/**
 * QUI RÉPOND AU CLIENT, CÔTÉ CONSOLE (RC6, plan `docs/superpowers/plans/2026-10-06-rc6-qui-repond.md`, livraison B ; le
 * lot 5 en posait la moitié agent IA). Un seul réglage de l'espace, sur l'Accueil : l'agent de Meta, un agent IA, un
 * scénario, l'équipe, ou l'application du client (lot 12, livraison B). Le serveur tient les règles (`src/repondeur/reglage.ts`) ; ce module lit ses réponses, sans
 * les caster, et dit ce qu'un geste va changer. Fonctions pures, testées dans `repondeur.test.ts`.
 *
 * 🔴 ALLUMÉ N'EST PLUS RÉPONDEUR. L'agent de Meta allumé est DISPONIBLE ; hors du mode « MBA », il est en veille et ne
 * prend un contact que par le bloc « Envoyer au MBA » d'un scénario.
 */

/**
 * ⚠️ MIROIR de `MODES_REPONDEUR` (`src/repondeur/mode.ts`), recopié pour ne pas tirer du code serveur dans le bundle
 * client ; `tests/web-repondeur-modes-parity.test.ts` casse dès qu'ils divergent.
 */
export const MODES_REPONDEUR = ['mba', 'agent', 'scenario', 'equipe', 'application'] as const;
export type ModeRepondeur = (typeof MODES_REPONDEUR)[number];

/** Les bornes du délai du mode « Scénario », en heures (1 h à 30 jours, 24 h par défaut), miroir du même fichier. */
export const DELAI_HEURES_MIN = 1;
export const DELAI_HEURES_MAX = 720;
export const DELAI_HEURES_DEFAUT = 24;

const estObjet = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const estMode = (v: unknown): v is ModeRepondeur => typeof v === 'string' && (MODES_REPONDEUR as readonly string[]).includes(v);
const texteOuNull = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** Ce que rend `GET /tenants/:tenantId/repondeur` (`EtatRepondeur` côté serveur). */
export interface EtatRepondeur {
  /** Le mode ÉCRIT. */
  mode: ModeRepondeur;
  /** Le mode qui s'APPLIQUE : différent du mode écrit quand sa cible a disparu (`cibleDisparue`). */
  modeEffectif: ModeRepondeur;
  agentId: string | null;
  workflowId: string | null;
  /** L'adresse de webhooks sortants désignée du mode « Mon application ». */
  adresseId: string | null;
  delaiS: number;
  mbaAllume: boolean;
  mbaConfigurable: boolean;
  modeleDisponible: boolean;
  agentsActifs: Array<{ id: string; label: string }>;
  scenariosPublies: Array<{ id: string; name: string }>;
  /** Les adresses de webhooks sortants qui peuvent recevoir : seules elles se désignent. */
  adressesActives: Array<{ id: string; url: string }>;
}

const liste = <T>(v: unknown, lire: (x: Record<string, unknown>) => T | null): T[] =>
  Array.isArray(v) ? v.flatMap((x) => { const r = estObjet(x) ? lire(x) : null; return r === null ? [] : [r]; }) : [];

/**
 * L'état lu, vérifié et non casté : il vient du réseau. `null` quand il n'est pas lisible (une API d'avant RC6 rend un
 * 404, et le mock d'un test rend `{}`) : la carte ne s'affiche pas plutôt que d'annoncer un réglage qu'elle n'a pas lu.
 */
export function lireEtatRepondeur(brut: unknown): EtatRepondeur | null {
  if (!estObjet(brut) || !estMode(brut.mode) || !estMode(brut.modeEffectif)) return null;
  return {
    mode: brut.mode,
    modeEffectif: brut.modeEffectif,
    agentId: texteOuNull(brut.agentId),
    workflowId: texteOuNull(brut.workflowId),
    adresseId: texteOuNull(brut.adresseId),
    delaiS: typeof brut.delaiS === 'number' && Number.isFinite(brut.delaiS) && brut.delaiS > 0 ? brut.delaiS : DELAI_HEURES_DEFAUT * 3600,
    mbaAllume: brut.mbaAllume === true,
    mbaConfigurable: brut.mbaConfigurable === true,
    modeleDisponible: brut.modeleDisponible === true,
    agentsActifs: liste(brut.agentsActifs, (x) => (typeof x.id === 'string' && typeof x.label === 'string' ? { id: x.id, label: x.label } : null)),
    scenariosPublies: liste(brut.scenariosPublies, (x) => (typeof x.id === 'string' && typeof x.name === 'string' ? { id: x.id, name: x.name } : null)),
    // Une API d'avant le lot 12 B ne rend pas la liste : aucune adresse, la position « Mon application » est grisée.
    adressesActives: liste(brut.adressesActives, (x) => (typeof x.id === 'string' && typeof x.url === 'string' ? { id: x.id, url: x.url } : null)),
  };
}

/**
 * Le mode qui s'applique, lu dans `GET /settings` (qui étale les réglages de l'espace). Miroir de `modeEffectif`
 * (`src/repondeur/mode.ts`). `null` = illisible (sans `mbaEnabled`). 🔴 Une API d'avant RC6 ne rend pas `repondeurMode` :
 * on retombe sur la règle de la reprise de 0217 (un agent IA désigné, sinon l'agent de Meta allumé, sinon l'équipe),
 * c'est-à-dire exactement ce que cette API faisait.
 */
export function modeEffectifDesReglages(s: { mbaEnabled?: unknown; repondeurMode?: unknown; repondeurAgentId?: unknown; repondeurWorkflowId?: unknown; repondeurAdresseId?: unknown } | null): ModeRepondeur | null {
  if (s === null || typeof s.mbaEnabled !== 'boolean') return null;
  const agent = typeof s.repondeurAgentId === 'string';
  const mode: ModeRepondeur = estMode(s.repondeurMode) ? s.repondeurMode : agent ? 'agent' : s.mbaEnabled ? 'mba' : 'equipe';
  switch (mode) {
    case 'mba': return s.mbaEnabled ? 'mba' : 'equipe';
    case 'agent': return agent ? 'agent' : 'equipe';
    case 'scenario': return typeof s.repondeurWorkflowId === 'string' ? 'scenario' : 'equipe';
    case 'equipe': return 'equipe';
    case 'application': return typeof s.repondeurAdresseId === 'string' ? 'application' : 'equipe';
  }
}

/**
 * Un répondeur AUTOMATIQUE répond-il dans cet espace aux messages que personne ne tient : l'agent de Meta, un agent IA
 * un scénario ou l'application du client (tout sauf « Équipe ») ? C'est la question des choix « le répondeur automatique prend la main » des
 * campagnes et des publicités : en mode « Équipe », la réponse irait à l'équipe, ce que dit déjà l'autre choix. `null`
 * = on ne sait pas (réglages illisibles).
 */
export function repondeurAutomatique(s: { mbaEnabled?: unknown; repondeurMode?: unknown; repondeurAgentId?: unknown; repondeurWorkflowId?: unknown; repondeurAdresseId?: unknown } | null): boolean | null {
  const mode = modeEffectifDesReglages(s);
  return mode === null ? null : mode !== 'equipe';
}

/** Le champ `repondeurAgentId` de `GET /agents`. `undefined` = absent (API plus ancienne) : on ne sait pas. */
export function lireRepondeurAgentId(v: unknown): string | null | undefined {
  if (v === null || typeof v === 'string') return v;
  return undefined;
}

type T = (fr: string, en?: string) => string;

/** Le nom d'un mode, tel que la carte et les phrases le disent. */
export function nomDuMode(mode: ModeRepondeur, t: T): string {
  switch (mode) {
    case 'mba': return t('L’agent de Meta (MBA)', 'Meta’s agent (MBA)');
    case 'agent': return t('Un agent IA', 'An AI agent');
    case 'scenario': return t('Un scénario', 'A scenario');
    case 'equipe': return t('L’équipe', 'The team');
    case 'application': return t('Votre application', 'Your application');
  }
}

/**
 * Ce que la carte dit quand le mode écrit n'est plus celui qui s'applique : sa cible a disparu, et les messages vont à
 * l'équipe. `null` quand tout va bien.
 */
export function cibleDisparue(
  etat: Pick<EtatRepondeur, 'mode' | 'modeEffectif'> & Partial<Pick<EtatRepondeur, 'adresseId' | 'adressesActives'>>, t: T,
): string | null {
  // L'adresse désignée existe mais ne reçoit plus (en pause, ou au-delà de l'offre : la liste ne porte que celles qui
  // reçoivent) : le serveur passe chaque message à l'équipe.
  if (etat.modeEffectif === 'application' && etat.adressesActives !== undefined
    && !etat.adressesActives.some((a) => a.id === etat.adresseId)) {
    return t('L’adresse de webhook choisie ne reçoit plus (en pause, ou au-delà de votre offre) : vos messages vont à l’équipe.', 'The chosen webhook address no longer receives (paused, or beyond your plan): your messages go to the team.');
  }
  if (etat.mode === etat.modeEffectif) return null;
  switch (etat.mode) {
    case 'agent': return t('L’agent IA choisi a été désactivé ou supprimé : vos messages vont à l’équipe.', 'The chosen AI agent was disabled or deleted: your messages go to the team.');
    case 'scenario': return t('Le scénario choisi a été supprimé : vos messages vont à l’équipe.', 'The chosen scenario was deleted: your messages go to the team.');
    case 'mba': return t('L’agent de Meta est éteint : vos messages vont à l’équipe.', 'Meta’s agent is off: your messages go to the team.');
    case 'application': return t('L’adresse de webhook choisie a été supprimée : vos messages vont à l’équipe.', 'The chosen webhook address was deleted: your messages go to the team.');
    case 'equipe': return null;
  }
}

/**
 * Pourquoi une position est grisée, ou `null` si elle se choisit. Le lien dit où la configurer.
 * - MBA : l'agent de Meta ne peut pas être allumé (aucun numéro, ou Meta ne l'a pas ouvert sur ce numéro).
 * - Agent IA : aucun agent actif, ou aucun modèle sur l'instance.
 * - Scénario : aucun scénario publié.
 * - Mon application : aucune adresse de webhooks sortants active.
 */
export function positionGrisee(mode: ModeRepondeur, etat: EtatRepondeur, t: T): { raison: string; lien: string; libelleLien: string } | null {
  switch (mode) {
    case 'mba':
      return etat.mbaConfigurable ? null : {
        raison: t('L’agent de Meta n’est pas encore configuré sur ce numéro.', 'Meta’s agent is not set up on this number yet.'),
        lien: '/mba/parametres', libelleLien: t('Configurer l’agent de Meta', 'Set up Meta’s agent'),
      };
    case 'agent':
      if (!etat.modeleDisponible) {
        return { raison: t('Les agents IA ne peuvent pas répondre sur cette instance.', 'AI agents cannot answer on this instance.'), lien: '/agents', libelleLien: t('Vos agents', 'Your agents') };
      }
      return etat.agentsActifs.length > 0 ? null : {
        raison: t('Aucun agent IA n’est actif.', 'No AI agent is active.'), lien: '/agents', libelleLien: t('Activer un agent', 'Activate an agent'),
      };
    case 'scenario':
      return etat.scenariosPublies.length > 0 ? null : {
        raison: t('Aucun scénario n’est publié.', 'No scenario is published.'), lien: '/workflows', libelleLien: t('Publier un scénario', 'Publish a scenario'),
      };
    case 'application':
      return etat.adressesActives.length > 0 ? null : {
        raison: t('Aucune adresse de webhooks sortants n’est active.', 'No outgoing webhook address is active.'),
        lien: '/developers/evenements', libelleLien: t('Ajouter une adresse', 'Add an address'),
      };
    case 'equipe':
      return null;
  }
}

/** La question posée avant de QUITTER le mode « MBA » : l'agent de Meta cessera de répondre aux contacts qu'il tient. */
export function confirmationQuitterMba(t: T): { titre: string; message: string; confirmer: string } {
  return {
    titre: t('Changer qui répond au client', 'Change who answers the customer'),
    message: t(
      'L’agent de Meta cessera de répondre aux conversations qu’il tient : ses contacts sont retirés de sa liste. Allumé, il reste disponible pour le bloc « Envoyer au MBA » de vos scénarios.',
      'Meta’s agent will stop answering the conversations it holds: its contacts are removed from its list. While on, it stays available for the “Send to MBA” block of your scenarios.',
    ),
    confirmer: t('Confirmer', 'Confirm'),
  };
}

/** La question posée avant d'ÉTEINDRE l'agent de Meta quand c'est lui qui répond : les messages iront à l'équipe. */
export function confirmationEteindreMba(t: T): { titre: string; message: string; confirmer: string } {
  return {
    titre: t('Éteindre l’agent de Meta', 'Turn Meta’s agent off'),
    message: t(
      'C’est lui qui répond aujourd’hui au client. Éteint, il ne répondra plus, conversations en cours comprises, et vos messages sans suite iront à l’équipe, dans « À traiter ».',
      'It is the one answering the customer today. Once off, it will stop answering, ongoing conversations included, and your unanswered messages will go to the team, in “To handle”.',
    ),
    confirmer: t('Éteindre', 'Turn off'),
  };
}

/**
 * Ce qu'allumer l'agent de Meta change, dit AVANT le geste dans les écrans de l'agent de Meta (l'Aperçu, l'assistant).
 * En mode agent IA, scénario ou application, il reste en VEILLE : le répondeur ne change pas. `null` dans les autres cas : en mode
 * « Équipe », l'allumer en fait le répondeur (ce que ces écrans disent déjà) ; en mode « MBA », il l'est déjà.
 */
export function avertissementAllumageMeta(etat: Pick<EtatRepondeur, 'modeEffectif' | 'agentId' | 'workflowId' | 'agentsActifs' | 'scenariosPublies'> | null, t: T): string | null {
  if (etat === null) return null;
  let qui: string;
  if (etat.modeEffectif === 'agent') {
    const nom = etat.agentsActifs.find((a) => a.id === etat.agentId)?.label.trim() ?? '';
    qui = nom !== '' ? t(`L’agent IA « ${nom} »`, `The AI agent “${nom}”`) : t('Un agent IA', 'An AI agent');
  } else if (etat.modeEffectif === 'scenario') {
    const nom = etat.scenariosPublies.find((s) => s.id === etat.workflowId)?.name.trim() ?? '';
    qui = nom !== '' ? t(`Le scénario « ${nom} »`, `The scenario “${nom}”`) : t('Un scénario', 'A scenario');
  } else if (etat.modeEffectif === 'application') {
    qui = t('Votre application', 'Your application');
  } else {
    return null;
  }
  return t(
    `${qui} répond aujourd’hui au client (Accueil, « Qui répond au client »). Allumé, l’agent de Meta restera en veille : il ne prendra que les contacts qu’un bloc « Envoyer au MBA » lui confie.`,
    `${qui} answers the customer today (Home, “Who answers the customer”). Once on, Meta’s agent will stay on standby: it will only take the contacts a “Send to MBA” block hands over.`,
  );
}

/** Le délai lu en heures, ramené dans ses bornes : la saisie de la carte. */
export function delaiHeuresDe(delaiS: number): number {
  const h = Math.round(delaiS / 3600);
  return Math.min(Math.max(h, DELAI_HEURES_MIN), DELAI_HEURES_MAX);
}
