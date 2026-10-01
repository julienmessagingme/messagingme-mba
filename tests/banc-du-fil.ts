import { creerControleDuFil, type ControleDuFil, type DepsControleDuFil, type EcritureDuFil } from '../src/inbox/fil';
import { creerListeDeLAgent, type EntreeDeLaListe, type ListeDeLAgent, type ListeStore } from '../src/mba/liste';
import type { EvenementAgent } from '../src/mba/evenement';
import type { ControlOwner } from '../src/inbox/store.pg';
import { MetaApiError } from '../src/meta/errors';

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
  };
  return { depot, lignes, ecritures, demandes, etat: (waId: string): EtatDuFil | undefined => lignes.get(waId) };
}

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
  /** Le délai de reprise réglé par l'espace, en secondes (0 = jamais). Défaut : aucun, le délai par défaut s'applique. */
  delaiRepriseSecondes?: number | null;
  /** Le numéro de l'espace ; `null` = aucun numéro connecté. Défaut : un numéro. */
  numero?: string | null;
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
  const fil = creerControleDuFil({
    depot: { ...memoire.depot, ...o.depot },
    reglages: { get: async () => ({ mbaEnabled: o.mbaEnabled ?? true, controlHandbackSeconds: o.delaiRepriseSecondes ?? null }) },
    delaiRepriseParDefautMs: DELAI_REPRISE_DEFAUT_MS,
    parcours: { findWaitingByWaId: async () => (o.enAttente ? { id: 'run-1' } : null) },
    numeros: { getTenantPhoneNumberId: async () => (o.numero === undefined ? 'pn1' : o.numero) },
    liste,
    consentement: {
      estDesabonne: async (_t, waId) => (o.desabonnes ?? []).includes(waId),
      estBloque: async (_t, waId) => (o.bloques ?? []).includes(waId),
    },
    meta: faux.meta,
  });
  return {
    fil, liste, etat: memoire.etat, lignes: memoire.lignes, table: table.lignes, ecritures: memoire.ecritures, demandes: memoire.demandes,
    appels: faux.appels, evenements: faux.evenements, attentes, client: faux.client,
  };
}
