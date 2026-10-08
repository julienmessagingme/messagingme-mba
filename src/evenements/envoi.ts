import { z } from 'zod';
import { lireCorpsBorne } from '../lib/corps-borne';
import { estRedirectionRefusee, estRefusAdresseInterne, fetchPublic } from '../lib/connexion-publique';
import { resolutionPublique, type VerdictResolution } from '../lib/adresse-privee';
import { texteDe } from '../lib/erreur';
import { enTetesSignes, secretsQuiSignent } from './signature';
import { prioriteDuType } from './types';

/**
 * L'ENVOI D'UN WEBHOOK SORTANT (lot 12, livraison A) : un job = une tentative d'un envoi (un événement vers une
 * adresse). Décisions de Julien du 2026-10-08 : toute réponse hors 2xx et toute panne réseau se réessaient pendant
 * 24 h ; l'adresse n'est jamais suspendue ; un `410 Gone` arrête cet envoi, sans toucher à l'adresse.
 *
 * Les tentatives se comptent dans la ligne d'envoi, pas dans le job : le job porte le numéro de la tentative qu'il
 * doit faire, et une ligne qui n'en est plus là (doublon, rejeu, envoi livré) le rend périmé. Aucune transaction n'est
 * ouverte pendant l'appel.
 */
export const FILE_EVENEMENTS_ENVOI = 'evenements-envoi';

/** L'attente avant chaque nouvel essai : 30 s, 2 min, 10 min, 30 min, puis toutes les heures. */
export const DELAIS_REESSAI_MS: readonly number[] = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000, 60 * 60_000];
/** La fenêtre des réessais, depuis la première tentative (ou depuis le dernier rejeu). */
export const FENETRE_REESSAIS_MS = 24 * 60 * 60_000;
/** Une tentative, lecture de la réponse comprise. */
export const DELAI_APPEL_MS = 10_000;
/** Ce qu'on garde de la réponse dans le journal, et ce qu'on en lit au plus. */
export const EXTRAIT_MAX = 1000;
/** Assez pour lire le début d'une page d'erreur HTML : au-delà, `lireCorpsBorne` ne rend rien du tout. */
const REPONSE_LUE_MAX_OCTETS = 64 * 1024;

/** Le prochain essai après `tentativesFaites` échecs, ou `null` s'il tomberait hors de la fenêtre de 24 h. */
export function prochainEssai(tentativesFaites: number, essaisDepuis: Date, maintenant: Date): Date | null {
  const delai = DELAIS_REESSAI_MS[Math.min(Math.max(tentativesFaites, 1), DELAIS_REESSAI_MS.length) - 1]!;
  const t = maintenant.getTime() + delai;
  return t > essaisDepuis.getTime() + FENETRE_REESSAIS_MS ? null : new Date(t);
}

/** L'issue d'une tentative. `definitif` : ne pas réessayer cet envoi (410). `code` : `null` sans réponse HTTP. */
export interface IssueAppel {
  livre: boolean;
  definitif: boolean;
  code: number | null;
  extrait: string;
}

export interface DepsAppel {
  /** `fetchPublic` en production : la connexion s'ouvre sur l'adresse vérifiée (DNS rebinding fermé). */
  fetch: typeof fetch;
  /** `resolutionPublique` en production : un refus lisible avant l'appel, une adresse interne n'est jamais appelée. */
  verifier(url: string): Promise<VerdictResolution>;
  delaiMs?: number;
}

/** L'extrait gardé au journal : borné, et sans octet NUL, que Postgres refuse dans un `text` (22021). */
const borne = (t: string): string => {
  const propre = t.replace(/\u0000/g, '');
  return propre.length <= EXTRAIT_MAX ? propre : propre.slice(0, EXTRAIT_MAX);
};

/**
 * Un `POST` vers l'adresse d'un client, avec les gardes de toute adresse saisie par un client : HTTPS, résolution
 * publique vérifiée avant, puis à l'ouverture de la connexion, aucune redirection suivie, réponse lue bornée, et un
 * plafond de temps qui couvre aussi la lecture.
 */
export async function appelerAdresse(deps: DepsAppel, o: { url: string; corps: string; enTetes: Record<string, string> }): Promise<IssueAppel> {
  if (!o.url.startsWith('https://')) return { livre: false, definitif: true, code: null, extrait: 'adresse refusée : HTTPS obligatoire' };
  const verdict = await deps.verifier(o.url);
  if (!verdict.ok) return { livre: false, definitif: false, code: null, extrait: verdict.raison ?? 'adresse refusée' };
  const controle = new AbortController();
  const minuteur = setTimeout(() => controle.abort(), deps.delaiMs ?? DELAI_APPEL_MS);
  try {
    const res = await deps.fetch(o.url, { method: 'POST', headers: o.enTetes, body: o.corps, redirect: 'error', signal: controle.signal });
    const lu = await lireCorpsBorne(res, REPONSE_LUE_MAX_OCTETS);
    const extrait = lu.trop_gros ? 'réponse de plus de 64 Ko, non gardée' : borne(lu.texte);
    if (res.status >= 200 && res.status < 300) return { livre: true, definitif: false, code: res.status, extrait };
    return { livre: false, definitif: res.status === 410, code: res.status, extrait };
  } catch (err) {
    const raison = controle.signal.aborted
      ? `pas de réponse en ${Math.round((deps.delaiMs ?? DELAI_APPEL_MS) / 1000)} s`
      : estRefusAdresseInterne(err) ? 'ce nom pointe vers une adresse interne'
        : estRedirectionRefusee(err) ? 'l’adresse répond par une redirection, qui n’est pas suivie'
          : texteDe(err);
    return { livre: false, definitif: false, code: null, extrait: borne(raison) };
  } finally {
    clearTimeout(minuteur);
  }
}

/**
 * 🔴 L'appel de production : `fetchPublic` (la connexion s'ouvre sur l'adresse vérifiée) et `resolutionPublique` (un
 * refus lisible avant), câblés ICI et non par l'appelant : le worker et la route d'essai ne peuvent pas l'oublier.
 * Inventorié par `tests/lib-adresse-privee.test.ts`.
 */
export function appelProduction(o: { url: string; corps: string; enTetes: Record<string, string> }): Promise<IssueAppel> {
  return appelerAdresse({ fetch: fetchPublic, verifier: (url) => resolutionPublique(url) }, o);
}

export const schemaJobEnvoi = z.object({
  tenantId: z.string().uuid(),
  envoiId: z.string().uuid(),
  tentative: z.number().int().min(0),
}).strict();
export type JobEnvoi = z.infer<typeof schemaJobEnvoi>;

/** Un envoi relu pour sa tentative, secrets déchiffrés par le câblage. `rang` : place de l'adresse parmi les actives, plus ancienne d'abord. */
export interface EnvoiAFaire {
  id: string;
  tenantId: string;
  statut: 'en_cours' | 'livre' | 'echec';
  tentatives: number;
  essaisDepuis: Date;
  evenementId: string;
  type: string;
  corps: string;
  adresse: {
    id: string;
    url: string;
    active: boolean;
    rang: number;
    secret: string;
    secretPrecedent: string | null;
    secretPrecedentJusqua: Date | null;
  };
}

export interface MajEnvoi {
  statut: 'en_cours' | 'livre' | 'echec';
  code: number | null;
  extrait: string;
  prochainEssai: Date | null;
}

export interface DepsTravailEnvoi {
  /** 🔴 Filtré sur l'espace du job : c'est le seul contrôle. `null` = l'envoi n'existe plus (purgé, adresse supprimée). */
  lire(tenantId: string, envoiId: string): Promise<EnvoiAFaire | null>;
  /** Écrit l'issue de la tentative `tentativeAttendue` (et passe à la suivante), seulement si la ligne en est toujours là. */
  noter(tenantId: string, envoiId: string, tentativeAttendue: number, maj: MajEnvoi): Promise<void>;
  /** `priorite` : celle du type (`prioriteDuType`), pour qu'un réessai garde sa place ; `null` = par défaut. */
  enfiler(job: JobEnvoi, startAfter: Date, priorite: number | null): Promise<void>;
  /** Une suppression d'espace en cours : le verrou de l'espace n'arrête pas le worker, il le vérifie lui-même. */
  espaceVerrouille(tenantId: string): Promise<boolean>;
  /** Le nombre d'adresses actives de l'offre, `null` = sans limite. */
  limiteAdresses(tenantId: string): Promise<number | null>;
  appeler(o: { url: string; corps: string; enTetes: Record<string, string> }): Promise<IssueAppel>;
  maintenant?: () => Date;
  log?: (message: string) => void;
}

export function creerTravailEnvoi(deps: DepsTravailEnvoi): (data: unknown) => Promise<void> {
  const maintenant = deps.maintenant ?? (() => new Date());
  return async (data) => {
    const lu = schemaJobEnvoi.safeParse(data);
    if (!lu.success) {
      const i = lu.error.issues[0];
      throw new Error(`evenements-envoi : payload invalide (${i ? `${i.path.join('.')} ${i.message}` : 'forme'})`);
    }
    const job = lu.data;
    if (await deps.espaceVerrouille(job.tenantId)) return;
    const e = await deps.lire(job.tenantId, job.envoiId);
    // Périmé : purgé, déjà livré ou abandonné, ou une autre tentative a déjà eu lieu (doublon d'enfilement, rejeu).
    if (e === null || e.statut !== 'en_cours' || e.tentatives !== job.tentative) return;

    // L'adresse ne reçoit plus : l'envoi s'arrête, et le journal dit pourquoi. Un rejeu le relancera.
    const limite = await deps.limiteAdresses(job.tenantId);
    const arret = !e.adresse.active ? 'adresse en pause'
      : limite !== null && e.adresse.rang > limite ? `adresse au-delà de votre offre (${limite} active${limite > 1 ? 's' : ''})`
        : null;
    if (arret !== null) {
      await deps.noter(job.tenantId, e.id, job.tentative, { statut: 'echec', code: null, extrait: arret, prochainEssai: null });
      return;
    }

    const instant = maintenant();
    const secrets = secretsQuiSignent({ actuel: e.adresse.secret, precedent: e.adresse.secretPrecedent, precedentJusqua: e.adresse.secretPrecedentJusqua }, instant);
    const enTetes: Record<string, string> = { ...enTetesSignes({ secrets, id: e.evenementId, maintenant: instant, corps: e.corps }) };
    const issue = await deps.appeler({ url: e.adresse.url, corps: e.corps, enTetes });

    if (issue.livre) {
      await deps.noter(job.tenantId, e.id, job.tentative, { statut: 'livre', code: issue.code, extrait: issue.extrait, prochainEssai: null });
      return;
    }
    const suivant = issue.definitif ? null : prochainEssai(job.tentative + 1, e.essaisDepuis, maintenant());
    if (suivant === null) {
      await deps.noter(job.tenantId, e.id, job.tentative, { statut: 'echec', code: issue.code, extrait: issue.extrait, prochainEssai: null });
      return;
    }
    // 🔴 L'essai suivant s'enfile AVANT d'être écrit : un arrêt entre les deux laisse un job de plus (qui se retrouvera
    // périmé ou refera une tentative), jamais un envoi « en cours » que plus rien ne relance.
    await deps.enfiler({ tenantId: job.tenantId, envoiId: e.id, tentative: job.tentative + 1 }, suivant, prioriteDuType(e.type));
    await deps.noter(job.tenantId, e.id, job.tentative, { statut: 'en_cours', code: issue.code, extrait: issue.extrait, prochainEssai: suivant });
  };
}
