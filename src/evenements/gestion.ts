import { z } from 'zod';
import { estUuid } from '../http/scope';
import { refus, type Issue } from '../lib/issue';
import { urlRecuperable } from '../lib/page-distante';
import type { VerdictResolution } from '../lib/adresse-privee';
import { LimiteOffreError, corpsRefusLimite } from '../offres/refus';
import { enTetesSignes, genererSecret, secretsQuiSignent } from './signature';
import {
  TYPES_ABONNABLES, TYPES_DECOCHES_PAR_DEFAUT, TYPE_ESSAI, donneesEssai, enveloppe, idEssai, type TypeAbonnable,
} from './types';
import type { IssueAppel, JobEnvoi } from './envoi';
import type { AdresseVue, EnvoiVue, PgAdressesEvenementsStore, PgEnvoisEvenementsStore } from './store.pg';

/**
 * LA GESTION DES WEBHOOKS SORTANTS (lot 12, livraison A). 🔴 UNE SEULE VÉRITÉ, DEUX PORTES : la route de la console
 * (`src/http/evenements.ts`) et les outils MCP (`create_webhook_endpoint`, `send_test_event`) appellent CES fonctions.
 * Une adresse créée par Claude Code passe exactement les mêmes contrôles qu'une adresse créée à la main.
 *
 * Les contrôles qui vivent ici :
 *  - la saisie, bornée par Zod (`safeParse`, `.strict()`) ;
 *  - l'adresse : HTTPS, un hôte qui n'est pas interne (texte), et un nom qui résout vers des adresses publiques
 *    (refus lisible tout de suite ; l'envoi revérifie à chaque tentative) ;
 *  - la limite d'adresses ACTIVES de l'offre, à la création et à la réactivation (402 `plan_limit_reached`) ;
 *  - le secret : généré ici, chiffré avant d'être écrit, rendu UNE seule fois, jamais journalisé.
 */
export interface DepsGestionEvenements {
  adresses: Pick<PgAdressesEvenementsStore, 'lister' | 'lire' | 'existe' | 'compterActives' | 'creer' | 'modifier' | 'tourner' | 'supprimer' | 'pourEnvoi'>;
  envois: Pick<PgEnvoisEvenementsStore, 'noterEssai' | 'journal' | 'rejouer' | 'rejouerEchecs'>;
  limiteAdresses(tenantId: string): Promise<number | null>;
  /** L'instance sait-elle chiffrer ? `ENCRYPTION_KEY` peut être vide : on refuse alors en 503 lisible, pas en 500. */
  chiffrementPret: boolean;
  chiffrer(clair: string): string;
  dechiffrer(chiffre: string): string;
  /** `resolutionPublique` en production. */
  verifierAdresse(url: string): Promise<VerdictResolution>;
  /** `appelProduction(fetchPublic)` en production : les mêmes gardes que le worker. */
  appeler(o: { url: string; corps: string; enTetes: Record<string, string> }): Promise<IssueAppel>;
  enfiler(job: JobEnvoi): Promise<void>;
  /** Le cache de l'émetteur (espaces et types écoutés) : une adresse créée reçoit tout de suite ce que l'API émet. */
  invaliderCache(): void;
  maintenant?: () => Date;
}

/** Combien de temps l'ancien secret signe encore après une rotation. */
export const CHEVAUCHEMENT_ROTATION_MS = 24 * 60 * 60_000;
/** Un rejeu en masse : au plus autant d'envois à la fois. */
export const REJEU_ECHECS_MAX = 500;
/** Une page du journal. */
export const JOURNAL_PAGE_MAX = 100;

/** Les types d'une adresse créée sans les préciser (l'outil MCP) : tous, sauf les accusés de livraison. */
export const TYPES_PAR_DEFAUT: readonly TypeAbonnable[] = TYPES_ABONNABLES.filter((t) => !TYPES_DECOCHES_PAR_DEFAUT.has(t));

const types = z.array(z.enum(TYPES_ABONNABLES)).min(1).max(TYPES_ABONNABLES.length)
  .refine((l) => new Set(l).size === l.length, { message: 'un type apparaît deux fois' });
const description = z.string().trim().max(200);

const saisieCreation = z.object({
  url: z.string().trim().min(1).max(2048),
  description: description.optional(),
  types: types.optional(),
}).strict();

const saisieModification = z.object({
  description: description.optional(),
  types: types.optional(),
  active: z.boolean().optional(),
}).strict();

const saisieRejeu = z.object({ depuis: z.string().datetime({ offset: true }) }).strict();

function premiereFaute(e: z.ZodError): string {
  const i = e.issues[0];
  return `${i && i.path.length > 0 ? i.path.join('.') : 'corps'} : ${i?.message ?? 'invalide'}`;
}

function refusLimite(tenantId: string, max: number) {
  const c = corpsRefusLimite(new LimiteOffreError(tenantId, 'adressesWebhook', max));
  return refus(402, c.error, { code: c.code, limite: c.limite, max: c.max, upgradeUrl: c.upgradeUrl });
}

/** L'adresse saisie : HTTPS, un hôte qui n'est pas interne, et un nom qui résout vers des adresses publiques. */
async function adresseAcceptable(deps: DepsGestionEvenements, url: string): Promise<string | null> {
  if (!url.startsWith('https://')) return 'L’adresse doit commencer par https:// : les événements portent des données de vos contacts.';
  if (!urlRecuperable(url)) return 'Cette adresse n’est pas joignable depuis Internet (hôte interne ou illisible).';
  const v = await deps.verifierAdresse(url);
  if (!v.ok) return `Cette adresse est refusée : ${v.raison ?? 'résolution impossible'}.`;
  return null;
}

export async function creerAdresse(deps: DepsGestionEvenements, tenantId: string, saisie: unknown): Promise<Issue<{ adresse: AdresseVue; secret: string }>> {
  const lu = saisieCreation.safeParse(saisie ?? {});
  if (!lu.success) return refus(400, premiereFaute(lu.error));
  if (!deps.chiffrementPret) return refus(503, 'Le chiffrement des secrets n’est pas configuré sur cette instance : impossible de créer une adresse.');
  const probleme = await adresseAcceptable(deps, lu.data.url);
  if (probleme !== null) return refus(400, probleme);
  const limite = await deps.limiteAdresses(tenantId);
  if (limite !== null && (await deps.adresses.compterActives(tenantId)) >= limite) return refusLimite(tenantId, limite);
  const secret = genererSecret();
  const adresse = await deps.adresses.creer(tenantId, {
    url: lu.data.url, description: lu.data.description ?? '', types: lu.data.types ?? TYPES_PAR_DEFAUT, secretChiffre: deps.chiffrer(secret),
  });
  deps.invaliderCache();
  return { ok: true, valeur: { adresse, secret } };
}

export async function modifierAdresse(deps: DepsGestionEvenements, tenantId: string, id: string, saisie: unknown): Promise<Issue<AdresseVue>> {
  if (!estUuid(id)) return refus(404, 'Adresse introuvable.');
  const lu = saisieModification.safeParse(saisie ?? {});
  if (!lu.success) return refus(400, premiereFaute(lu.error));
  const avant = await deps.adresses.lire(tenantId, id);
  if (avant === null) return refus(404, 'Adresse introuvable.');
  if (lu.data.active === true && !avant.active) {
    const limite = await deps.limiteAdresses(tenantId);
    if (limite !== null && (await deps.adresses.compterActives(tenantId, id)) >= limite) return refusLimite(tenantId, limite);
  }
  const apres = await deps.adresses.modifier(tenantId, id, lu.data);
  if (apres === null) return refus(404, 'Adresse introuvable.');
  deps.invaliderCache();
  return { ok: true, valeur: apres };
}

export async function tournerSecret(deps: DepsGestionEvenements, tenantId: string, id: string): Promise<Issue<{ secret: string; ancienJusqua: string }>> {
  if (!estUuid(id)) return refus(404, 'Adresse introuvable.');
  if (!deps.chiffrementPret) return refus(503, 'Le chiffrement des secrets n’est pas configuré sur cette instance.');
  const secret = genererSecret();
  const jusqua = new Date((deps.maintenant?.() ?? new Date()).getTime() + CHEVAUCHEMENT_ROTATION_MS);
  if (!(await deps.adresses.tourner(tenantId, id, deps.chiffrer(secret), jusqua))) return refus(404, 'Adresse introuvable.');
  return { ok: true, valeur: { secret, ancienJusqua: jusqua.toISOString() } };
}

export async function supprimerAdresse(deps: DepsGestionEvenements, tenantId: string, id: string): Promise<Issue<true>> {
  if (!estUuid(id) || !(await deps.adresses.supprimer(tenantId, id))) return refus(404, 'Adresse introuvable.');
  deps.invaliderCache();
  return { ok: true, valeur: true };
}

/**
 * L'événement d'essai : une tentative tout de suite, faite par l'appelant (la console attend, l'outil MCP aussi), avec
 * les mêmes gardes et la même signature que le worker. Écrit au journal de l'adresse. Il part aussi vers une adresse
 * en pause : c'est un geste manuel, pour vérifier une application avant de rallumer.
 */
export async function envoyerEssai(
  deps: DepsGestionEvenements, tenantId: string, id: string,
): Promise<Issue<{ evenementId: string; livre: boolean; code: number | null; reponse: string }>> {
  if (!estUuid(id)) return refus(404, 'Adresse introuvable.');
  const a = await deps.adresses.pourEnvoi(tenantId, id);
  if (a === null) return refus(404, 'Adresse introuvable.');
  if (!deps.chiffrementPret) return refus(503, 'Le chiffrement des secrets n’est pas configuré sur cette instance.');
  const maintenant = deps.maintenant?.() ?? new Date();
  const evenementId = idEssai();
  const corps = JSON.stringify(enveloppe({ id: evenementId, type: TYPE_ESSAI, le: maintenant.toISOString(), tenantId, data: donneesEssai() }));
  const secrets = secretsQuiSignent({
    actuel: deps.dechiffrer(a.secretChiffre),
    precedent: a.secretPrecedentChiffre === null ? null : deps.dechiffrer(a.secretPrecedentChiffre),
    precedentJusqua: a.secretPrecedentJusqua,
  }, maintenant);
  const issue = await deps.appeler({ url: a.url, corps, enTetes: { ...enTetesSignes({ secrets, id: evenementId, maintenant, corps }) } });
  await deps.envois.noterEssai(tenantId, id, { evenementId, corps, livre: issue.livre, code: issue.code, extrait: issue.extrait });
  return { ok: true, valeur: { evenementId, livre: issue.livre, code: issue.code, reponse: issue.extrait } };
}

export async function lireJournal(
  deps: DepsGestionEvenements, tenantId: string, id: string, o: { avant?: unknown; limite?: unknown },
): Promise<Issue<EnvoiVue[]>> {
  if (!estUuid(id) || !(await deps.adresses.existe(tenantId, id))) return refus(404, 'Adresse introuvable.');
  const avant = typeof o.avant === 'string' && !Number.isNaN(Date.parse(o.avant)) ? new Date(o.avant) : null;
  const n = Number(o.limite);
  const limite = Number.isInteger(n) && n >= 1 && n <= JOURNAL_PAGE_MAX ? n : 50;
  return { ok: true, valeur: await deps.envois.journal(tenantId, id, { avant, limite }) };
}

export async function rejouerEnvoi(deps: DepsGestionEvenements, tenantId: string, envoiId: string): Promise<Issue<true>> {
  if (!estUuid(envoiId)) return refus(404, 'Envoi introuvable.');
  const r = await deps.envois.rejouer(tenantId, envoiId);
  if (r === null) return refus(409, 'Cet envoi est introuvable, encore en cours (son prochain essai est programmé), ou c’est un essai : rien à rejouer.');
  await deps.enfiler({ tenantId, envoiId, tentative: r.tentative });
  return { ok: true, valeur: true };
}

export async function rejouerEchecs(deps: DepsGestionEvenements, tenantId: string, id: string, saisie: unknown): Promise<Issue<{ rejoues: number }>> {
  if (!estUuid(id) || !(await deps.adresses.existe(tenantId, id))) return refus(404, 'Adresse introuvable.');
  const lu = saisieRejeu.safeParse(saisie ?? {});
  if (!lu.success) return refus(400, premiereFaute(lu.error));
  const repris = await deps.envois.rejouerEchecs(tenantId, id, new Date(lu.data.depuis), REJEU_ECHECS_MAX);
  for (const r of repris) await deps.enfiler({ tenantId, envoiId: r.id, tentative: r.tentative });
  return { ok: true, valeur: { rejoues: repris.length } };
}
