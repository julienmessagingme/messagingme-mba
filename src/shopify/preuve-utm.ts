import { z } from 'zod';
import { lireCorpsBorne } from '../lib/corps-borne';
import { fetchPublic } from '../lib/connexion-publique';
import { journaliser } from '../lib/journal';
import { modeleDesUtm } from '../links/utm';
import type { Filiere } from '../application/comptes';
import { API_VERSION_SHOPIFY, demanderJeton } from './connexion';
import { choisirSource } from './attribution';
import type { PgShopifyStore } from './store.pg';
import type { PgVentesStore } from './ventes.pg';

/**
 * LA PREUVE PAR UTM, RELUE APRÈS COUP (spec du 2026-10-28, « La preuve par UTM » ; plan, tâche 6b).
 *
 * Mesuré sur la commande #1003 de la boutique de dev : le corps d'`orders/paid` ne porte que la page d'arrivée de la
 * PREMIÈRE visite, et le parcours client n'y est pas encore calculé. Shopify le calcule en un quart d'heure environ, et sa
 * DERNIÈRE visite porte nos UTM. La réception programme donc cette relecture 30 minutes plus tard ; si la visite vient de
 * nos liens, la vente devient prouvée et revient à la dernière touche du modèle que nomment les UTM (règle 2).
 */

export const FILE_PREUVE_UTM = 'shopify-preuve-utm';
/** Le délai avant la première relecture : Shopify a calculé le parcours de #1003 en 14 minutes. */
export const DELAI_PREUVE_MS = 30 * 60_000;
/** Un parcours pas prêt, ou une lecture en panne, se relit toutes les 30 minutes, quatre essais en tout. */
export const REESSAI_PREUVE_MS = 30 * 60_000;
export const ESSAIS_PREUVE = 4;

const CORPS_MAX = 200_000;
const DELAI_MS = 15_000;

/** Ce que la réception confie à la relecture : de quoi figer la vente sans relire la commande. */
const schemaJob = z.object({
  tenantId: z.string().min(1),
  commandeId: z.string().min(1).max(40),
  contactId: z.string().min(1),
  montant: z.string().regex(/^\d+(\.\d+)?$/),
  devise: z.string().regex(/^[A-Z]{3}$/),
  payeeLe: z.string().refine((s) => !Number.isNaN(Date.parse(s))),
  test: z.boolean(),
  essai: z.number().int().min(0),
});
export type JobPreuve = z.infer<typeof schemaJob>;
/** Enfiler une relecture à son heure (`queue.enqueue` avec `startAfter`, lié par le câblage). */
export type ProgrammerPreuve = (job: JobPreuve, quand: Date) => Promise<void>;

const REQUETE = `query($id: ID!) { order(id: $id) { customerJourneySummary { ready
  lastVisit { utmParameters { source medium campaign } } } } }`;

const utm = z.object({ source: z.string().nullish(), medium: z.string().nullish(), campaign: z.string().nullish() }).nullish();
const schemaReponse = z.object({
  data: z.object({
    order: z.object({
      customerJourneySummary: z.object({ ready: z.boolean(), lastVisit: z.object({ utmParameters: utm }).nullish() }).nullish(),
    }).nullish(),
  }).nullish(),
  errors: z.array(z.unknown()).nullish(),
});

export type LectureParcours = { ok: true; pret: false } | { ok: true; pret: true; modele: string | null } | { ok: false };

/**
 * Le parcours client d'une commande (API `2026-10`, `gid://shopify/Order/<id du webhook>`, coût 4). `modele` : la
 * campagne de la dernière visite si ses UTM sont les nôtres. Toute panne rend `{ ok: false }`, jamais une exception.
 */
export async function lireParcours(
  acces: { domaine: string; jeton: string },
  commandeId: string,
  /** `fetchPublic` en production ; injectable pour éprouver la lecture sans réseau. */
  appeler: typeof fetch = fetchPublic,
): Promise<LectureParcours> {
  try {
    const res = await appeler(`https://${acces.domaine}/admin/api/${API_VERSION_SHOPIFY}/graphql.json`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-shopify-access-token': acces.jeton },
      body: JSON.stringify({ query: REQUETE, variables: { id: `gid://shopify/Order/${commandeId}` } }),
      redirect: 'manual',
      signal: AbortSignal.timeout(DELAI_MS),
    });
    if (res.status !== 200) return { ok: false };
    const corps = await lireCorpsBorne(res, CORPS_MAX);
    if (corps.trop_gros || corps.casse) return { ok: false };
    const lu = schemaReponse.safeParse(JSON.parse(corps.texte));
    if (!lu.success || (lu.data.errors && lu.data.errors.length > 0)) return { ok: false };
    const resume = lu.data.data?.order?.customerJourneySummary;
    if (resume && !resume.ready) return { ok: true, pret: false };
    return { ok: true, pret: true, modele: modeleDesUtm(resume?.lastVisit?.utmParameters) };
  } catch {
    return { ok: false };
  }
}

export interface DepsPreuveUtm {
  store: Pick<PgShopifyStore, 'acces'>;
  ventes: Pick<PgVentesStore, 'derniereToucheDuModele' | 'appliquerPreuveUtm'>;
  filiere(tenantId: string): Promise<Filiere | null>;
  programmer: ProgrammerPreuve;
  /** Injectables pour éprouver la relecture ; les vrais par défaut. */
  jeton?: typeof demanderJeton;
  lire?: typeof lireParcours;
  maintenant?: () => number;
}

export type IssuePreuve = 'prouvee' | 'ignoree' | 'sans_preuve' | 'reessai' | 'abandon';

/** Une relecture : prouve la vente, ou la relit plus tard, ou s'arrête. Ne lève jamais : un job ne se rejoue pas en boucle. */
export async function traiterPreuveUtm(deps: DepsPreuveUtm, donnees: unknown): Promise<IssuePreuve> {
  const lu = schemaJob.safeParse(donnees);
  if (!lu.success) {
    journaliser('warn', 'shopify_preuve_job_illisible', {});
    return 'abandon';
  }
  const job = lu.data;
  const plusTard = async (): Promise<IssuePreuve> => {
    if (job.essai + 1 >= ESSAIS_PREUVE) return 'abandon';
    await deps.programmer({ ...job, essai: job.essai + 1 }, new Date((deps.maintenant ?? Date.now)() + REESSAI_PREUVE_MS));
    return 'reessai';
  };

  const acces = await deps.store.acces(job.tenantId);
  if (acces === null || acces.etat !== 'connectee') return 'abandon';
  const jeton = await (deps.jeton ?? demanderJeton)(acces.domaine, acces.clientId, acces.secret);
  if (!jeton.ok) return jeton.code === 'passager' ? plusTard() : 'abandon';
  const parcours = await (deps.lire ?? lireParcours)({ domaine: acces.domaine, jeton: jeton.jeton }, job.commandeId);
  if (!parcours.ok || !parcours.pret) return plusTard();
  if (parcours.modele === null) return 'sans_preuve';

  const payeeLe = new Date(job.payeeLe);
  const filiereApplication = (await deps.filiere(job.tenantId)) === 'application';
  const touche = await deps.ventes.derniereToucheDuModele(job.tenantId, job.contactId, parcours.modele, payeeLe, filiereApplication);
  if (touche === null) return 'sans_preuve';
  const vente = choisirSource({ payeeLe, touches: [], panierRelance: null, toucheUtm: touche });
  if (vente === null) return 'sans_preuve';
  const issue = await deps.ventes.appliquerPreuveUtm(job.tenantId, {
    commandeId: job.commandeId, contactId: job.contactId, montant: job.montant, devise: job.devise, payeeLe, test: job.test, ...vente,
  });
  return issue === 'appliquee' ? 'prouvee' : 'ignoree';
}
