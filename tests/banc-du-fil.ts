import { creerControleDuFil, type ControleDuFil, type DepsControleDuFil, type EcritureDuFil } from '../src/inbox/fil';
import type { ControlOwner } from '../src/inbox/store.pg';
import { MetaApiError } from '../src/meta/errors';

/**
 * LE BANC DU CONTRÔLE DU FIL : le VRAI module (`src/inbox/fil.ts`) monté sur un dépôt en mémoire et un faux
 * client Meta. Les tests des consommateurs (balayage, réception, routes) le montent au lieu de fabriquer chacun
 * un faux `setControlOwner` : l'ordre « Meta d'abord » et les gardes sont ceux du module, pas ceux d'un faux qui
 * bouge avec le code.
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
}

/** Tous les tests de ce banc parlent d'un seul espace. */
export const ESPACE = 't1';

/**
 * Le dépôt en mémoire, fidèle au `update` gardé de `PgInboxStore.setControlOwner` : update seul (jamais de
 * création), aucune écriture si le détenteur est déjà celui visé, `only` et `saufEscalade` dans le `where`,
 * `effacerEscalade` et `escalade` n'agissant que si l'écriture a lieu.
 */
export function depotEnMemoire(initial: Record<string, Partial<EtatDuFil>> = {}) {
  const lignes = new Map<string, EtatDuFil>();
  for (const [waId, e] of Object.entries(initial)) {
    lignes.set(waId, { owner: 'app_workflow', escaladeeLe: null, test: false, marque: null, enVol: null, ...e });
  }
  const ecritures: Array<{ waId: string; owner: ControlOwner; opts: EcritureDuFil | undefined }> = [];
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
      if (l) { l.owner = 'app_human'; l.escaladeeLe = new Date(); return; }
      lignes.set(waId, { owner: 'app_human', escaladeeLe: new Date(), test: false, marque: null, enVol: null });
    },
  };
  return { depot, lignes, ecritures, etat: (waId: string): EtatDuFil | undefined => lignes.get(waId) };
}

/**
 * Ce que Meta répond à un geste : il accepte, il refuse pour de bon (`take` réservé au partenaire d'escalade), ou
 * il refuse pour une raison passagère (429, rejouable), ou il lève l'erreur donnée.
 */
export type ReponseMeta = 'accepte' | 'refuse' | 'passager' | Error;

/**
 * Le faux client Meta. Chaque liste est jouée dans l'ordre, la dernière réponse se répète : `['passager',
 * 'accepte']` = refuse une fois puis accepte. `appels` garde `take:<waId>` et `release:<waId>`, dans l'ordre.
 */
export function metaFactice(
  script: { take?: ReponseMeta[]; release?: ReponseMeta[] } = {},
  appels: string[] = [],
  observer?: (acte: 'take' | 'release', waId: string) => void,
) {
  const rangs = { take: 0, release: 0 };
  const jouer = (acte: 'take' | 'release', waId: string): void => {
    appels.push(`${acte}:${waId}`);
    observer?.(acte, waId);
    const liste = script[acte] ?? ['accepte'];
    const r = liste[Math.min(rangs[acte], liste.length - 1)] ?? 'accepte';
    rangs[acte] += 1;
    if (r === 'refuse') throw new MetaApiError(400, { message: 'not the configured escalation partner' });
    if (r === 'passager') throw new MetaApiError(429, null, 10);
    if (r instanceof Error) throw r;
  };
  const meta: DepsControleDuFil['meta'] = {
    mbaClientForTenant: async () => ({
      takeThread: async (_pn: string, waId: string) => { jouer('take', waId); },
      releaseThread: async (_pn: string, waId: string) => { jouer('release', waId); },
    }),
  };
  return { meta, appels };
}

export interface OptionsBanc {
  /** Les conversations existantes, par `waId`. */
  conversations?: Record<string, Partial<EtatDuFil>>;
  /** L'agent de Meta est-il allumé ? Défaut : oui. */
  mbaEnabled?: boolean;
  /** Le numéro de l'espace ; `null` = aucun numéro connecté. Défaut : un numéro. */
  numero?: string | null;
  /** Un parcours attend-il la réponse du contact ? Défaut : non. */
  enAttente?: boolean;
  take?: ReponseMeta[];
  release?: ReponseMeta[];
  /** Remplace des méthodes du dépôt en mémoire (tests qui gardent leur propre faux). */
  depot?: Partial<DepsControleDuFil['depot']>;
  /** Le journal où le faux Meta écrit ses appels, pour l'entrelacer avec celui d'un faux dépôt. */
  appels?: string[];
  /** Appelé à chaque geste reçu par le faux Meta, avant sa réponse. */
  auMeta?: (acte: 'take' | 'release', waId: string) => void;
}

/** Le module réel sur le dépôt en mémoire et le faux Meta. */
export function bancDuFil(o: OptionsBanc = {}): {
  fil: ControleDuFil;
  etat: (waId: string) => EtatDuFil | undefined;
  lignes: Map<string, EtatDuFil>;
  ecritures: Array<{ waId: string; owner: ControlOwner; opts: EcritureDuFil | undefined }>;
  appels: string[];
  attentes: number[];
} {
  const memoire = depotEnMemoire(o.conversations);
  const { meta, appels } = metaFactice({ ...(o.take ? { take: o.take } : {}), ...(o.release ? { release: o.release } : {}) }, o.appels, o.auMeta);
  const attentes: number[] = [];
  const fil = creerControleDuFil({
    depot: { ...memoire.depot, ...o.depot },
    reglages: { get: async () => ({ mbaEnabled: o.mbaEnabled ?? true }) },
    parcours: { findWaitingByWaId: async () => (o.enAttente ? { id: 'run-1' } : null) },
    numeros: { getTenantPhoneNumberId: async () => (o.numero === undefined ? 'pn1' : o.numero) },
    meta,
    attendre: async (ms) => { attentes.push(ms); },
  });
  return { fil, etat: memoire.etat, lignes: memoire.lignes, ecritures: memoire.ecritures, appels, attentes };
}
