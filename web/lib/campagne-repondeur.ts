import { nomDuMode, type EtatRepondeur } from './repondeur';

/**
 * QUEL RÉPONDEUR AUTOMATIQUE PREND LA MAIN SUR UN ÉTAGE DE CAMPAGNE (plan `docs/superpowers/plans/2026-10-30-repondeur-par-etage.md`,
 * livraison B ; demande de Julien du 2026-10-30 : « il faut demander quel répondeur automatique, que la personne puisse
 * choisir un des agents IA dispo ou le MBA, et si aucun n'est setuppé, griser cette option »).
 *
 * Le serveur porte la règle (`problemeDeRepondeur`, `src/campaign/etages.ts`, migration 0263) et la décision à la réponse
 * (`remettreSiPersonneNeSuit`, `src/inbox/fil.ts`) ; ce module dit ce que l'écran PROPOSE, avec la raison de chaque
 * entrée grisée, et ce que l'étage ENVOIE. Fonctions pures, testées dans `campagne-repondeur.test.ts`.
 */

/** Le choix d'un étage : le répondeur de l'espace (le défaut), l'agent de Meta, ou un agent IA par son identifiant. */
export type ChoixRepondeur = 'espace' | 'mba' | `agent:${string}`;

type T = (fr: string, en?: string) => string;

const AGENT = /^agent:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** Un choix lu d'un brouillon ou d'un `<select>` : `undefined` pour tout ce qui n'en est pas un (le répondeur de l'espace). */
export function lireChoixRepondeur(v: unknown): ChoixRepondeur | undefined {
  if (v === 'espace' || v === 'mba') return v;
  return typeof v === 'string' && AGENT.test(v) ? (v as ChoixRepondeur) : undefined;
}

/** Ce que l'écran sait de l'espace pour proposer les répondeurs. */
export interface SourcesRepondeur {
  /** `GET /tenants/:id/repondeur` ; `null` = illisible (API d'avant RC6, panne) : seul le répondeur de l'espace se propose. */
  etat: EtatRepondeur | null;
  /**
   * L'offre comprend-elle l'agent de Meta (`useOffre`, fonction `agent_meta`) ? `null` = offre inconnue. Elle sert à dire la
   * BONNE raison : le serveur rend déjà `mbaConfigurable` faux hors de l'offre (`src/repondeur/reglage.ts`), et sans elle un
   * espace Pro lirait « pas encore configuré sur ce numéro » au lieu de « votre offre ne le comprend pas ».
   */
  agentMetaDansLOffre: boolean | null;
  /** Repli quand `etat` est illisible : un répondeur automatique répond-il dans l'espace (`repondeurAutomatique`) ? */
  espaceAutomatique: boolean;
}

/** Une entrée du sélecteur. `raison` non nulle = grisée, et la phrase dit pourquoi : une option absente ferait croire qu'elle n'existe pas. */
export interface OptionRepondeur {
  valeur: ChoixRepondeur;
  libelle: string;
  raison: string | null;
}

/**
 * Les entrées du sélecteur, dans l'ordre décidé par Julien : le répondeur de l'espace (le défaut, le comportement d'avant),
 * l'agent de Meta, puis chaque agent IA actif.
 */
export function optionsDuRepondeur(s: SourcesRepondeur, t: T): OptionRepondeur[] {
  const automatique = s.etat ? s.etat.modeEffectif !== 'equipe' : s.espaceAutomatique;
  const espace: OptionRepondeur = {
    valeur: 'espace',
    libelle: s.etat
      ? t(`Le répondeur de l’espace : ${nomDuMode(s.etat.modeEffectif, t)}`, `The workspace’s responder: ${nomDuMode(s.etat.modeEffectif, t)}`)
      : t('Le répondeur de l’espace', 'The workspace’s responder'),
    raison: automatique ? null : t(
      'Sur l’Accueil, personne ne répond automatiquement : les messages vont à l’équipe.',
      'On Home, nobody answers automatically: messages go to the team.',
    ),
  };
  if (!s.etat) return [espace];
  const e = s.etat;
  const mba: OptionRepondeur = {
    valeur: 'mba',
    libelle: t('L’agent de Meta (MBA)', 'Meta’s agent (MBA)'),
    // L'offre d'abord : hors de l'offre, le serveur rend aussi `mbaConfigurable` faux, et c'est elle la vraie raison.
    raison: s.agentMetaDansLOffre === false
      ? t('Votre offre ne comprend pas l’agent de Meta.', 'Your plan does not include Meta’s agent.')
      : !e.mbaConfigurable
        ? t('L’agent de Meta n’est pas encore configuré sur ce numéro.', 'Meta’s agent is not set up on this number yet.')
        : !e.mbaAllume
          ? t('L’agent de Meta est éteint.', 'Meta’s agent is off.')
          : null,
  };
  const agents = e.agentsActifs.map((a): OptionRepondeur => ({
    valeur: `agent:${a.id}`,
    libelle: t(`L’agent IA « ${a.label} »`, `The AI agent “${a.label}”`),
    raison: e.modeleDisponible ? null : t('Les agents IA ne peuvent pas répondre sur cette instance.', 'AI agents cannot answer on this instance.'),
  }));
  return [espace, mba, ...agents];
}

/** Au moins un répondeur peut-il prendre la main ? Sinon le choix « le répondeur automatique prend la main » se grise. */
export function repondeurPossible(options: readonly OptionRepondeur[]): boolean {
  return options.some((o) => o.raison === null);
}

/**
 * Le choix posé quand on coche « le répondeur automatique prend la main » : celui de l'étage s'il est choisissable, sinon le
 * répondeur de l'espace s'il l'est, sinon la première entrée choisissable. `null` = aucun.
 * 🔴 IL EST ÉCRIT DANS L'ÉTAGE AU MOMENT DU CLIC, jamais seulement affiché : un sélecteur qui MONTRERAIT l'agent de Meta
 * sur un étage qui n'envoie rien laisserait la réponse au répondeur de l'espace, c'est-à-dire à l'équipe en mode « Équipe ».
 */
export function choixParDefaut(actuel: ChoixRepondeur | undefined, options: readonly OptionRepondeur[]): ChoixRepondeur | null {
  const choisissable = (v: ChoixRepondeur | undefined): boolean => options.some((o) => o.valeur === v && o.raison === null);
  if (actuel !== undefined && choisissable(actuel)) return actuel;
  if (choisissable('espace')) return 'espace';
  return options.find((o) => o.raison === null)?.valeur ?? null;
}

/**
 * Le choix de l'étage n'est plus proposable (l'agent désactivé depuis, l'agent de Meta éteint, l'Accueil passé en mode
 * « Équipe ») : l'écran le dit, plutôt que de laisser partir une campagne qui ne fera pas ce qu'elle affiche.
 */
export function choixIndisponible(actuel: ChoixRepondeur | undefined, options: readonly OptionRepondeur[]): boolean {
  const v = actuel ?? 'espace';
  return !options.some((o) => o.valeur === v && o.raison === null);
}

/**
 * Ce que l'étage ENVOIE au serveur (`repondeur`, `repondeurAgentId`), ou rien, c'est-à-dire le répondeur de l'espace. Rien
 * hors d'un étage WhatsApp.
 * 🔴 Rien pour un étage à scénario ni pour un étage qui renvoie à l'équipe : ce qu'on cache à l'écran doit être exactement
 * ce qu'on n'envoie pas (le motif de `devenir`, `reessayer`, `assignation`), et le serveur refuserait un répondeur sans
 * « le répondeur automatique prend la main ».
 */
export function repondeurAEnvoyer(
  c: { formule: string; devenir?: string; repondeur?: ChoixRepondeur } | undefined,
  canal: string,
): { repondeur: 'mba' } | { repondeur: 'agent'; repondeurAgentId: string } | Record<string, never> {
  // 🔴 WHATSAPP SEULEMENT (relecture de la livraison B) : une réponse RCS ou e-mail ne passe jamais par la remise, le
  // répondeur désigné n'y répondrait pas, et le serveur le refuse (`problemeDeRepondeur`).
  if (canal !== 'whatsapp') return {};
  if (c?.formule !== 'seul' || c.devenir !== 'mba' || c.repondeur === undefined) return {};
  if (c.repondeur === 'mba') return { repondeur: 'mba' };
  const id = AGENT.exec(c.repondeur)?.[1];
  return id ? { repondeur: 'agent', repondeurAgentId: id } : {};
}
