import { creerControleDuFil, type ControleDuFil, type DepsControleDuFil, type EcritureDuFil } from '../src/inbox/fil';
import { creerListeDeLAgent, type EntreeDeLaListe, type ListeDeLAgent, type ListeStore } from '../src/mba/liste';
import type { EvenementAgent } from '../src/mba/evenement';
import type { ControlOwner } from '../src/inbox/store.pg';
import { MetaApiError } from '../src/meta/errors';
import type { IssueRepondeur } from '../src/repondeur/demarrer';
import type { IssueLancementScenario, IssueReclamation } from '../src/repondeur/scenario';
import type { ModeRepondeur } from '../src/repondeur/mode';
import { DROITS, type Offre } from '../src/offres/offres';

/**
 * LE BANC DU CONTRÔLE DU FIL : le VRAI module (`src/inbox/fil.ts`) et la VRAIE liste de l'agent de Meta
 * (`src/mba/liste.ts`), montés sur un dépôt et une table en mémoire et un faux client Meta. Les tests des
 * consommateurs (balayage, réception, routes) le montent au lieu de fabriquer chacun un faux `setControlOwner` :
 * l'ordre « Meta d'abord », les gardes et la tenue de la liste sont ceux des modules, pas ceux d'un faux qui bouge
 * avec le code.
 *
 * ⚠️ Dans `tests/`, jamais dans `src/` : un Meta qui accepte tout y serait importable par le câblage de production.
 */

/** Une conversation telle que la colonne et ses marques la décrivent. */
export interface EtatDuFil {
  owner: ControlOwner;
  /** `escaladee_le` : `null` = aucune escalade. */
  escaladeeLe: Date | null;
  /** `is_test`. */
  test: boolean;
  /** `release_mba_apres_message`. */
  marque: string | null;
  /** Notre dernier envoi encore en vol : `demanderReleaseMba` le pose en marque et le rend. */
  enVol: string | null;
  /**
   * `control_changed_at` : la dernière bascule, que la remise « personne ne suit » compare au délai de reprise.
   * Défaut : maintenant (l'équipe vient de prendre le fil) ; `null` = non daté, donc délai échu.
   */
  changedAt: Date | null;
}

/** Tous les tests de ce banc parlent d'un seul espace. */
export const ESPACE = 't1';

/** Le délai de reprise de l'équipe quand l'espace n'en a pas réglé, celui du serveur par défaut (deux heures). */
export const DELAI_REPRISE_DEFAUT_MS = 2 * 3600_000;

/**
 * Le dépôt en mémoire, fidèle au `update` gardé de `PgInboxStore.setControlOwner` : update seul (jamais de
 * création), aucune écriture si le détenteur est déjà celui visé, `only` et `saufEscalade` dans le `where`,
 * `effacerEscalade` et `escalade` n'agissant que si l'écriture a lieu.
 */
export function depotEnMemoire(initial: Record<string, Partial<EtatDuFil>> = {}) {
  const lignes = new Map<string, EtatDuFil>();
  for (const [waId, e] of Object.entries(initial)) {
    lignes.set(waId, { owner: 'app_workflow', escaladeeLe: null, test: false, marque: null, enVol: null, changedAt: new Date(), ...e });
  }
  const ecritures: Array<{ waId: string; owner: ControlOwner; opts: EcritureDuFil | undefined }> = [];
  /** Les demandes ouvertes sans bascule (`ouvrirUneDemande`), par `waId`, avec leur cause. */
  const demandes: Array<{ waId: string; cause: string }> = [];
  /** Les lignes `mba_indisponible` de la frise (`noterMbaIndisponible`, RC6), par `waId`, avec leur cause. */
  const indisponibles: Array<{ waId: string; cause: string }> = [];
  const depot: DepsControleDuFil['depot'] = {
    getControlOwner: async (_t, waId) => lignes.get(waId)?.owner ?? 'app_workflow',
    setControlOwner: async (_t, waId, owner, opts) => {
      const l = lignes.get(waId);
      if (!l || l.owner === owner) return false;
      if (opts?.only && !opts.only.includes(l.owner)) return false;
      if (opts?.saufEscalade && l.escaladeeLe !== null
        && !(opts.messageEnvoyeLe !== undefined && opts.messageEnvoyeLe > l.escaladeeLe)) return false;
      ecritures.push({ waId, owner, opts });
      l.owner = owner;
      l.changedAt = new Date();
      if (opts?.effacerEscalade) l.escaladeeLe = null;
      else if (opts?.escalade && owner === 'app_human') l.escaladeeLe = new Date();
      return true;
    },
    demanderReleaseMba: async (_t, waId) => {
      const l = lignes.get(waId);
      if (!l) return null;
      l.marque = l.enVol;
      return l.marque;
    },
    consommerReleaseMba: async (messageId) => {
      for (const [waId, l] of lignes) {
        if (l.marque === messageId) { l.marque = null; return { tenantId: ESPACE, waId }; }
      }
      return null;
    },
    estConversationDeTest: async (_t, waId) => lignes.get(waId)?.test === true,
    marquerEscalade: async (_t, waId) => {
      const l = lignes.get(waId);
      if (l) { l.owner = 'app_human'; l.escaladeeLe = new Date(); l.changedAt = new Date(); return; }
      lignes.set(waId, { owner: 'app_human', escaladeeLe: new Date(), test: false, marque: null, enVol: null, changedAt: new Date() });
    },
    etatDuFil: async (_t, waId) => {
      const l = lignes.get(waId);
      if (!l) return { owner: 'app_workflow', depuisMs: null, escaladee: false };
      return { owner: l.owner, depuisMs: l.changedAt === null ? null : Date.now() - l.changedAt.getTime(), escaladee: l.escaladeeLe !== null };
    },
    // Fidèle au `where control_owner = 'app_human'` de `PgInboxStore.ouvrirUneDemande`.
    // Et, comme lui, elle pose l'escalade (une escalade déjà ouverte garde sa date).
    ouvrirUneDemande: async (_t, waId, cause) => {
      const l = lignes.get(waId);
      if (l?.owner !== 'app_human') return;
      demandes.push({ waId, cause });
      l.escaladeeLe = l.escaladeeLe ?? new Date();
    },
    // Fidèle au `where control_owner = 'app_human'` de `PgInboxStore.relancerLeDelai`.
    relancerLeDelai: async (_t, waId) => {
      const l = lignes.get(waId);
      if (l?.owner === 'app_human') l.changedAt = new Date();
    },
    // Fidèle à `PgInboxStore.filsDeLAgentDeMeta` : `mba` seulement, par `wa_id` croissant, strictement après `apres`.
    filsDeLAgentDeMeta: async (_t, apres, limite) => [...lignes]
      .filter(([waId, l]) => l.owner === 'mba' && (apres === null || waId > apres))
      .map(([waId]) => waId).sort().slice(0, limite),
    // Fidèle à `PgInboxStore.noterMbaIndisponible` : rien sans conversation.
    noterMbaIndisponible: async (_t, waId, cause) => { if (lignes.has(waId)) indisponibles.push({ waId, cause }); },
  };
  return { depot, lignes, ecritures, demandes, indisponibles, etat: (waId: string): EtatDuFil | undefined => lignes.get(waId) };
}

/**
 * Un espace sans répondeur IA (`repondeurAgentId: null`) : la remise ne doit jamais démarrer l'agent IA. Le faux le
 * DIT en levant, au lieu de rendre une issue qu'aucun test ne regarderait.
 */
export const aucunRepondeur: DepsControleDuFil['repondeur'] = {
  demarrer: async () => { throw new Error('aucunRepondeur : le démarreur du répondeur ne devrait pas être appelé'); },
  reclamerScenario: async () => { throw new Error('aucunRepondeur : le scénario répondeur ne devrait pas être réclamé'); },
  lancerScenario: async () => { throw new Error('aucunRepondeur : le scénario répondeur ne devrait pas être lancé'); },
};

/** L'identifiant que le faux Meta donne à l'entrée d'un contact : on retrouve le contact en le lisant. */
export const entreeDe = (waId: string): string => `entree-${waId}`;

/**
 * La table `mba_liste` en mémoire, un seul espace. `initial` : les contacts déjà sur la liste. `poser` peut être
 * rendu défaillant pour éprouver la compensation de `ajouter`.
 */
export function listeEnMemoire(initial: readonly string[] = [], o: { poserEchoue?: boolean } = {}) {
  const lignes = new Map<string, EntreeDeLaListe>();
  for (const waId of initial) lignes.set(waId, { phoneNumberId: 'pn1', entreeId: entreeDe(waId) });
  const store: ListeStore = {
    presents: async (_t, waIds) => new Set(waIds.filter((w) => lignes.has(w))),
    trouver: async (_t, waId) => lignes.get(waId) ?? null,
    poser: async (_t, waId, phoneNumberId, entreeId) => {
      if (o.poserEchoue) throw new Error('base indisponible');
      lignes.set(waId, { phoneNumberId, entreeId });
    },
    supprimer: async (_t, waId) => { lignes.delete(waId); },
    // Fidèle à `PgListeStore.lister` : par `wa_id` croissant, strictement après la dernière clé lue.
    lister: async (_t, apres, limite) => [...lignes.keys()].sort().filter((w) => apres === null || w > apres).slice(0, limite),
    // Sans conversations en mémoire, l'activité est l'ordre d'entrée : le premier posé est le moins actif. L'ordre par
    // dernier message de la vraie requête est éprouvé contre Postgres (`tests/integration/mba-liste.integration.test.ts`).
    moinsActive: async (_t, phoneNumberId) => {
      const duNumero = [...lignes].filter(([, e]) => e.phoneNumberId === phoneNumberId).map(([w]) => w);
      return duNumero.length === 0 ? null : { waId: duNumero[0]!, taille: duNumero.length };
    },
  };
  return { store, lignes };
}

/**
 * Ce que Meta répond à un geste : il accepte, il refuse pour de bon (403), il refuse pour une raison passagère (429,
 * rejouable), il ne connaît pas l'entrée (404), il répond « doublon » à un ajout (le 400 sans code mesuré le
 * 2026-09-29), ou il lève l'erreur donnée.
 */
export type ReponseMeta = 'accepte' | 'refuse' | 'passager' | 'absente' | 'doublon' | Error;

/** Les gestes du faux Meta, tels que `appels` les note (`ajout:<waId>`, `retrait:<waId>`, ...). */
export type ActeMeta = 'ajout' | 'retrait' | 'release' | 'evenement' | 'lecture';

/**
 * Le faux client Meta. Chaque liste est jouée dans l'ordre, la dernière réponse se répète : `['passager',
 * 'accepte']` = refuse une fois puis accepte. `appels` garde `ajout:<waId>`, `retrait:<waId>`, `release:<waId>`,
 * `evenement:<waId>` et `lecture:liste`, dans l'ordre. `surLaListe` : les contacts que Meta a déjà sur la liste.
 */
export function metaFactice(
  script: { ajout?: ReponseMeta[]; retrait?: ReponseMeta[]; release?: ReponseMeta[]; evenement?: ReponseMeta[] } = {},
  appels: string[] = [],
  observer?: (acte: ActeMeta, waId: string) => void,
  surLaListe: readonly string[] = [],
) {
  const rangs = { ajout: 0, retrait: 0, release: 0, evenement: 0 };
  const listeChezMeta = new Set<string>(surLaListe);
  const evenements: Array<{ waId: string; event: EvenementAgent }> = [];
  const jouer = (acte: Exclude<ActeMeta, 'lecture'>, waId: string): void => {
    appels.push(`${acte}:${waId}`);
    observer?.(acte, waId);
    const liste = script[acte] ?? ['accepte'];
    const r = liste[Math.min(rangs[acte], liste.length - 1)] ?? 'accepte';
    rangs[acte] += 1;
    if (r === 'refuse') throw new MetaApiError(403, { message: 'refusé par Meta' });
    if (r === 'passager') throw new MetaApiError(429, null, 10);
    if (r === 'absente') throw new MetaApiError(404, { message: 'Not Found', type: 'MbaError' });
    if (r === 'doublon') throw new MetaApiError(400, { message: 'The request or consumer identifier is invalid', type: 'MbaError' });
    if (r instanceof Error) throw r;
  };
  const client = {
    releaseThread: async (_pn: string, waId: string) => { jouer('release', waId); },
    agentEvent: async (_pn: string, to: string, event: EvenementAgent) => {
      const waId = to.replace(/^\+/, '');
      jouer('evenement', waId);
      evenements.push({ waId, event });
      return { id: `ev-${evenements.length}` };
    },
    listAllowlist: async () => {
      appels.push('lecture:liste');
      return [...listeChezMeta].map((w) => ({ id: entreeDe(w), consumer_phone_number: `+${w}` }));
    },
    addToAllowlist: async (_pn: string, numero: string) => {
      const waId = numero.replace(/^\+/, '');
      jouer('ajout', waId);
      // Le vrai Meta rend un 400 sans code sur un numéro déjà présent.
      if (listeChezMeta.has(waId)) throw new MetaApiError(400, { message: 'The request or consumer identifier is invalid', type: 'MbaError' });
      listeChezMeta.add(waId);
      return { id: entreeDe(waId), consumer_phone_number: numero };
    },
    removeFromAllowlist: async (_pn: string, entreeId: string) => {
      const waId = entreeId.replace(/^entree-/, '');
      jouer('retrait', waId);
      listeChezMeta.delete(waId);
    },
  };
  const meta: DepsControleDuFil['meta'] = { mbaClientForTenant: async () => client };
  return { meta, client, appels, evenements, listeChezMeta };
}

export interface OptionsBanc {
  /** Les conversations existantes, par `waId`. */
  conversations?: Record<string, Partial<EtatDuFil>>;
  /** Les contacts déjà sur la liste de l'agent (notre table ET chez Meta). Défaut : aucun. */
  surLaListe?: string[];
  /** L'agent de Meta est-il allumé ? Défaut : oui. */
  mbaEnabled?: boolean;
  /**
   * Qui répond au client (RC6). Défaut : la règle de la reprise de 0217, `agent` si un agent est désigné, sinon `mba`
   * si l'agent de Meta est allumé, sinon `equipe`. Le MBA allumé en veille se monte en posant le mode ET `mbaEnabled`.
   */
  mode?: ModeRepondeur;
  /** L'agent IA répondeur de l'espace (lot 5) ; `null` = aucun. Défaut : aucun. */
  repondeurAgentId?: string | null;
  /** Le scénario répondeur (RC6) ; `null` = aucun. Défaut : aucun. */
  repondeurWorkflowId?: string | null;
  /** L'offre de l'espace (lot 6, B2a : le gel de l'agent de Meta et du scénario répondeur). Défaut : Entreprise. */
  offre?: Offre;
  /** Le délai du scénario répondeur, en secondes. Défaut : 24 h. */
  delaiScenarioS?: number;
  /** Ce que rend la réclamation du scénario répondeur. Défaut : `reclame`. Ses appels sont notés dans `reclamations`. */
  reclamation?: IssueReclamation | Error;
  /** Ce que rend le lancement du scénario répondeur. Défaut : `parti`. Ses appels sont notés dans `lancementsScenario`. */
  lancementScenario?: IssueLancementScenario | Error;
  /** Ce que rend le démarreur du répondeur. Défaut : `parti`. Ses appels sont notés dans `demarrages`. */
  demarrage?: IssueRepondeur | Error;
  /** Remplace le démarreur factice (un vrai démarreur, branché par liaison tardive dans le test). */
  repondeur?: DepsControleDuFil['repondeur'];
  /** Remplace la lecture « un parcours attend-il ce contact ? » (de vrais parcours en mémoire). Prime sur `enAttente`. */
  parcours?: DepsControleDuFil['parcours'];
  /** Le délai de reprise réglé par l'espace, en secondes (0 = jamais). Défaut : aucun, le délai par défaut s'applique. */
  delaiRepriseSecondes?: number | null;
  /** Le numéro de l'espace ; `null` = aucun numéro connecté. Défaut : un numéro. */
  numero?: string | null;
  /** Le numéro de l'espace est-il bloqué (délié, ou suspendu faute de paiement, lot 4) ? Défaut : non. */
  numeroBloque?: boolean;
  /** Un parcours attend-il la réponse du contact ? Défaut : non. */
  enAttente?: boolean;
  /** Les contacts qui ont dit STOP. Défaut : aucun. */
  desabonnes?: string[];
  /** Les contacts bloqués. Défaut : aucun. */
  bloques?: string[];
  ajout?: ReponseMeta[];
  retrait?: ReponseMeta[];
  release?: ReponseMeta[];
  evenement?: ReponseMeta[];
  /** La ligne de la table refuse de s'écrire (compensation de l'ajout). */
  poserEchoue?: boolean;
  /** Remplace des méthodes du dépôt en mémoire (tests qui gardent leur propre faux). */
  depot?: Partial<DepsControleDuFil['depot']>;
  /** Le journal où le faux Meta écrit ses appels, pour l'entrelacer avec celui d'un faux dépôt. */
  appels?: string[];
  /** Appelé à chaque geste reçu par le faux Meta, avant sa réponse. */
  auMeta?: (acte: ActeMeta, waId: string) => void;
}

/** Le module réel et la liste réelle, sur le dépôt et la table en mémoire et le faux Meta. */
export function bancDuFil(o: OptionsBanc = {}): {
  fil: ControleDuFil;
  liste: ListeDeLAgent;
  etat: (waId: string) => EtatDuFil | undefined;
  lignes: Map<string, EtatDuFil>;
  /** Notre table `mba_liste`, par `waId`. */
  table: Map<string, EntreeDeLaListe>;
  ecritures: Array<{ waId: string; owner: ControlOwner; opts: EcritureDuFil | undefined }>;
  /** Les demandes ouvertes sans bascule (`ouvrirUneDemande`). */
  demandes: Array<{ waId: string; cause: string }>;
  appels: string[];
  evenements: Array<{ waId: string; event: EvenementAgent }>;
  attentes: number[];
  /** Le faux client Meta lui-même, pour câbler un autre module sur le même journal (`agentEvent`, ...). */
  client: ReturnType<typeof metaFactice>['client'];
  /** Les démarrages demandés au répondeur IA, dans l'ordre. */
  demarrages: Array<{ waId: string; agentId: string; messageDeclencheur: string | null }>;
  /** Les réclamations du scénario répondeur, puis ses lancements, dans l'ordre (RC6). */
  reclamations: Array<{ waId: string; workflowId: string; delaiS: number }>;
  lancementsScenario: Array<{ waId: string; workflowId: string; messageDeclencheur: string | null }>;
  /** Les lignes `mba_indisponible` de la frise (RC6). */
  indisponibles: Array<{ waId: string; cause: string }>;
} {
  const memoire = depotEnMemoire(o.conversations);
  const table = listeEnMemoire(o.surLaListe, { poserEchoue: o.poserEchoue === true });
  const script = {
    ...(o.ajout ? { ajout: o.ajout } : {}),
    ...(o.retrait ? { retrait: o.retrait } : {}),
    ...(o.release ? { release: o.release } : {}),
    ...(o.evenement ? { evenement: o.evenement } : {}),
  };
  const faux = metaFactice(script, o.appels, o.auMeta, o.surLaListe);
  const attentes: number[] = [];
  const liste = creerListeDeLAgent({
    store: table.store,
    clientMba: async () => faux.client,
    attendre: async (ms) => { attentes.push(ms); },
  });
  const demarrages: Array<{ waId: string; agentId: string; messageDeclencheur: string | null }> = [];
  const reclamations: Array<{ waId: string; workflowId: string; delaiS: number }> = [];
  const lancementsScenario: Array<{ waId: string; workflowId: string; messageDeclencheur: string | null }> = [];
  const mbaEnabled = o.mbaEnabled ?? true;
  const repondeurAgentId = o.repondeurAgentId ?? null;
  const mode: ModeRepondeur = o.mode ?? (repondeurAgentId !== null ? 'agent' : (mbaEnabled ? 'mba' : 'equipe'));
  const fil = creerControleDuFil({
    depot: { ...memoire.depot, ...o.depot },
    reglages: {
      get: async () => ({
        mbaEnabled, repondeurMode: mode, repondeurAgentId, repondeurWorkflowId: o.repondeurWorkflowId ?? null,
        repondeurDelaiScenarioS: o.delaiScenarioS ?? 86400, controlHandbackSeconds: o.delaiRepriseSecondes ?? null,
      }),
    },
    offres: { offreDe: async () => ({ offre: o.offre ?? 'entreprise', droits: DROITS[o.offre ?? 'entreprise'], retourEnBaseLe: null }) },
    delaiRepriseParDefautMs: DELAI_REPRISE_DEFAUT_MS,
    parcours: o.parcours ?? { findWaitingByWaId: async () => (o.enAttente ? { id: 'run-1' } : null) },
    numeros: {
      getTenantPhoneNumberId: async () => (o.numero === undefined ? 'pn1' : o.numero),
      numeroBloque: async () => o.numeroBloque === true,
    },
    liste,
    consentement: {
      estDesabonne: async (_t, waId) => (o.desabonnes ?? []).includes(waId),
      estBloque: async (_t, waId) => (o.bloques ?? []).includes(waId),
    },
    meta: faux.meta,
    repondeur: {
      demarrer: async (t, waId, d) => {
        demarrages.push({ waId, agentId: d.agentId, messageDeclencheur: d.messageDeclencheur });
        if (o.repondeur) return o.repondeur.demarrer(t, waId, d);
        if (o.demarrage instanceof Error) throw o.demarrage;
        return o.demarrage ?? 'parti';
      },
      reclamerScenario: async (t, waId, d) => {
        reclamations.push({ waId, workflowId: d.workflowId, delaiS: d.delaiS });
        if (o.repondeur) return o.repondeur.reclamerScenario(t, waId, d);
        if (o.reclamation instanceof Error) throw o.reclamation;
        return o.reclamation ?? 'reclame';
      },
      lancerScenario: async (t, waId, d) => {
        lancementsScenario.push({ waId, workflowId: d.workflowId, messageDeclencheur: d.messageDeclencheur });
        if (o.repondeur) return o.repondeur.lancerScenario(t, waId, d);
        if (o.lancementScenario instanceof Error) throw o.lancementScenario;
        return o.lancementScenario ?? 'parti';
      },
    },
  });
  return {
    fil, liste, etat: memoire.etat, lignes: memoire.lignes, table: table.lignes, ecritures: memoire.ecritures, demandes: memoire.demandes,
    appels: faux.appels, evenements: faux.evenements, attentes, client: faux.client, demarrages,
    reclamations, lancementsScenario, indisponibles: memoire.indisponibles,
  };
}
