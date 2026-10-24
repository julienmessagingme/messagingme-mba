import { z } from 'zod';
import { MAX_OPT_IN_SOURCE } from '../api/contacts-upsert';
import type { DepsEnvoiPublic } from '../api/envoi-public';
import type { PgContactStore } from '../crm/contact-store.pg';
import { waIdOf } from '../crm/identity';
import { normalizePhone } from '../crm/phone';
import type { OrigineMessage } from '../inbox/origine';
import type { PgInboxStore } from '../inbox/store.pg';
import type { QuotaModeles } from '../offres/compteurs';
import type { Queue } from '../queue/queue';
import type { ClientApplication, RaisonClient } from './client';
import type { CompteApplication, ComptesApplication } from './comptes';
import { idDuMessage, jidDuWaId } from './message';

/**
 * ÉCRIRE EN PREMIER PAR LA FILIÈRE APPLICATION (plan 2026-10-23, tâche 2 ; conception
 * `docs/superpowers/specs/2026-10-23-shopify-numero-qr-design.md`, § 5.1). Une porte unique pour tout message qu'un
 * espace relié par QR code écrit sans répondre : Shopify, Claude, l'API, une réponse hors des 24 heures. Elle garde
 * (filière, compte, premier contact, gel, fiche, STOP, blocage, messages du mois), réserve un créneau espacé par espace et
 * enfile ; le job (`traiterPremierMessage`) relit tout ce qui a pu changer, vérifie l'adresse, envoie et inscrit l'issue.
 *
 * 🔴 RÉSERVÉE AUX RÉPONSES DEPUIS LE 2026-10-24 (décision de Julien, sur deux mesures) : un appareil lié qui écrit en
 * premier à quelqu'un qui ne lui a pas écrit est sanctionné par WhatsApp. Premier essai, le message arrive et l'appareil
 * est déconnecté (401) 2,8 s après ; second essai, le message est refusé dans l'accusé (erreur 463, « reachout
 * timelock ») et n'arrive jamais. Seule une réponse différée à un contact qui NOUS A ÉCRIT (mode `conversation`) passe
 * encore ; Shopify, Claude et l'API qui écriraient en premier sont refusés (`premier_contact`), avant toute écriture.
 *
 * 🔴 AU PLUS UNE FOIS. La route d'envoi du service n'a aucune idempotence : ce qui empêche un second envoi, c'est la clé
 * unique de la file (un rejeu ne crée rien) et la RÉCLAMATION de la ligne par le job (`en_file` -> `envoi`, une seule
 * écriture gardée) : un job en double ne trouve rien à réclamer, et un crash après la réclamation laisse `envoi`, que
 * personne ne reprend.
 *
 * Aucun import de `transport/` : l'API et le worker l'importent (`tests/application-sans-baileys.test.ts`).
 */

export const FILE_PREMIER_MESSAGE = 'application-premier-message';
/** Le job de la file : la ligne, et rien d'autre (tout le reste se relit en base, à l'heure de l'envoi). */
export const jobPremierSchema = z.object({ id: z.uuid() });

/** 🔴 Les listes des CHECK de la migration 0252, que `tests/application-premier-message.test.ts` compare. */
export const ORIGINES_PREMIER = ['shopify_commande', 'shopify_panier', 'mcp', 'api', 'reponse'] as const;
export type OriginePremier = (typeof ORIGINES_PREMIER)[number];
export const STATUTS_PREMIER = ['en_file', 'envoi', 'envoye', 'abandonne'] as const;
export type StatutPremier = (typeof STATUTS_PREMIER)[number];

export interface DemandePremierMessage {
  tenantId: string;
  /** L'idempotence : une clé déjà en file rend sa ligne, sans rien créer ni compter. */
  cle: string;
  /** Les chiffres du numéro, indicatif compris, sans « + ». */
  telephone: string;
  texte: string;
  origine: OriginePremier;
  /** La clé d'événement Shopify ou le jeton du panier : rendue à `noterIssue`. */
  reference: string | null;
  /**
   * `conversation` : une réponse différée à un contact qui NOUS A ÉCRIT (décision de Julien, 2026-10-24 : il a donné son
   * accord pour qu'on lui réponde, même plus tard) ; seul un STOP l'arrête, et rien ne s'écrit sur la fiche. C'est le
   * SEUL mode qui passe : `exige_opt_in` (une fiche consentante), `declare` (Claude, l'API) et `marchand` (Shopify)
   * écriraient en premier, et la porte les refuse (`premier_contact`). Gardés dans le type pour que chaque appelant dise
   * encore ce qu'il demande, et reçoive le refus de la porte plutôt qu'une erreur.
   */
  consentement: { mode: 'exige_opt_in' } | { mode: 'conversation' } | { mode: 'declare'; source: string } | { mode: 'marchand'; source: string };
}

/** `premier_contact` : la demande écrirait en premier à quelqu'un qui ne nous a pas écrit (tout mode sauf `conversation`). */
export type RefusPremier =
  | 'filiere_api' | 'numero_coupe' | 'numero_indisponible' | 'premier_contact' | 'gele' | 'desabonne' | 'bloque'
  | 'limite_modeles' | 'sans_telephone';

export type ResultatPremier = { ok: true; id: string; prevuLe: Date; dejaEnFile: boolean } | { ok: false; refus: RefusPremier };

/**
 * Ce que devient un message réclamé par le job : l'issue inscrite chez l'appelant. `envoi_incertain` : le service n'a
 * pas répondu à l'envoi, le message est peut-être parti, il ne repart pas. `expire` : réclamé plus de 24 heures après
 * son créneau. `filiere_api` : l'espace est passé à l'API entre-temps.
 */
export type IssueJobPremier =
  | 'envoye' | 'pas_sur_whatsapp' | 'numero_coupe' | 'refuse_whatsapp' | 'desabonne' | 'bloque' | 'gele' | 'abandonne'
  | 'envoi_incertain' | 'expire' | 'filiere_api';

export interface PremierMessage {
  id: string;
  tenantId: string;
  cle: string;
  /** Les chiffres du numéro du contact (CHECK de la migration). */
  waId: string;
  texte: string;
  origine: OriginePremier;
  reference: string | null;
  statut: StatutPremier;
  issue: IssueJobPremier | null;
  prevuLe: Date;
  /** Les réclamations faites, celle en cours comprise. */
  essais: number;
  messageId: string | null;
}

export type NouveauPremier = Pick<PremierMessage, 'tenantId' | 'cle' | 'waId' | 'texte' | 'origine' | 'reference'>;

/** La file en base (`src/application/premier-message.pg.ts`). */
export interface PremiersMessages {
  existant(tenantId: string, cle: string): Promise<PremierMessage | null>;
  /**
   * Réserve le créneau de l'espace et insère, dans une seule transaction sous verrou de l'espace : au moins 30 s après
   * le dernier prévu, plus `aleatoire` (0 à 1) fois 30 s. Une clé déjà là rend la ligne existante (`cree: false`).
   */
  inserer(m: NouveauPremier, aleatoire: number): Promise<{ ligne: PremierMessage; cree: boolean }>;
  /** `en_file` -> `envoi`, essais + 1 ; `null` si la ligne n'est plus en file (déjà prise, finie, inconnue). */
  reclamer(id: string): Promise<PremierMessage | null>;
  /** Une ligne réclamée repart en file, à `prevuLe`. */
  remettreEnFile(id: string, prevuLe: Date): Promise<void>;
  /** Une ligne réclamée se termine. */
  terminer(id: string, statut: 'envoye' | 'abandonne', issue: IssueJobPremier, messageId: string | null): Promise<void>;
  /** La fin du gel des premiers messages du compte, ou `null`. */
  geleJusqua(compteId: string): Promise<Date | null>;
  /** Gèle le compte jusqu'à `jusqua`, sauf gel déjà actif ; `true` si CET appel l'a posé (un seul e-mail par gel). */
  geler(compteId: string, jusqua: Date): Promise<boolean>;
  /**
   * Efface les lignes créées il y a plus de `jours` jours, quel que soit leur statut : les finies, et celles qu'un job
   * perdu laisse `en_file` ou qu'un crash laisse `envoi` (elles ne partiront plus : `PEREMPTION_MS`). Rend leur nombre.
   */
  purgerTermines(jours: number): Promise<number>;
}

/** Enfile le job d'une ligne, groupé par espace, pas avant `startAfter`. */
export type EnfilerPremier = (tenantId: string, id: string, startAfter: Date) => Promise<void>;

/**
 * L'enfilement, écrit une fois pour la porte (l'API) et pour le job (ses réessais, le worker) : le groupe est l'espace,
 * que la file plafonne à un job à la fois (`src/worker.ts`), donc un seul envoi à la fois par numéro.
 */
export function enfileurPremier(queue: Pick<Queue, 'enqueue'>): EnfilerPremier {
  return (tenantId, id, startAfter) => queue.enqueue(FILE_PREMIER_MESSAGE, { id }, { groupId: tenantId, startAfter });
}

export interface DepsPremierMessage {
  premiers: Pick<PremiersMessages, 'existant' | 'inserer' | 'geleJusqua'>;
  comptes: Pick<ComptesApplication, 'parEspace' | 'filiereDe'>;
  /** La fiche (`resoudreFiche`, jamais créée) et sa lecture avant le tri, comme l'envoi public. */
  fiches: Pick<DepsEnvoiPublic, 'resoudreFiche'> & Pick<DepsEnvoiPublic['repo'], 'listContactsPourEnvoiApi'>;
  contacts: Pick<PgContactStore, 'estDesabonneParWaId' | 'machineSeTaitParWaId'>;
  /** Les messages du mois de l'offre : un message écrit en premier y compte, comme un modèle sur l'API. */
  quota: Pick<QuotaModeles, 'consommer'>;
  enfiler: EnfilerPremier;
  /** Pour les tests seulement. */
  maintenant?: () => Date;
  aleatoire?: () => number;
}

const sourceConsentement = z.string().trim().min(1).max(MAX_OPT_IN_SOURCE);
/** Les bornes des CHECK de la migration : une demande qui les passe ne fait jamais lever l'insertion. */
const schemaDemande = z.object({
  tenantId: z.string().min(1),
  cle: z.string().min(1).max(200),
  telephone: z.string().min(1).max(64),
  texte: z.string().min(1).max(4096),
  origine: z.enum(ORIGINES_PREMIER),
  reference: z.string().max(200).nullable(),
  consentement: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('exige_opt_in') }),
    z.object({ mode: z.literal('conversation') }),
    z.object({ mode: z.literal('declare'), source: sourceConsentement }),
    z.object({ mode: z.literal('marchand'), source: sourceConsentement }),
  ]),
});

const refus = (r: RefusPremier): ResultatPremier => ({ ok: false, refus: r });

/**
 * 🔴 Au-delà de 24 heures après son créneau, un message ne part plus (`expire`) : une relance de panier ou un avis
 * d'expédition d'hier n'a plus de sens, et un job retrouvé des jours plus tard enverrait une nouvelle périmée.
 */
export const PEREMPTION_MS = 24 * 3_600_000;
const perime = (l: Pick<PremierMessage, 'prevuLe'>, maintenant: Date): boolean => maintenant.getTime() - l.prevuLe.getTime() > PEREMPTION_MS;

/**
 * Une ligne déjà là : rien n'est créé ni compté. Encore en file, son job est enfilé de nouveau à son heure : c'est le
 * rattrapage d'un enfilement perdu, et un job en double ne réclame rien. Sauf une ligne périmée, qui ne partira plus.
 */
async function dejaLa(d: Pick<DepsPremierMessage, 'enfiler'>, l: PremierMessage, maintenant: Date): Promise<ResultatPremier> {
  if (l.statut === 'en_file' && !perime(l, maintenant)) await d.enfiler(l.tenantId, l.id, l.prevuLe);
  return { ok: true, id: l.id, prevuLe: l.prevuLe, dejaEnFile: true };
}

/**
 * La porte, dans cet ordre : la filière, le compte, le premier contact, la clé, le gel, la fiche, le STOP et le blocage,
 * les messages du mois, puis le créneau et la file. Rien n'est écrit, rien n'est compté avant le dernier refus possible.
 * Une demande hors des bornes de la migration est une faute de l'appelant : elle lève.
 */
export async function enfilerPremierMessage(d: DepsPremierMessage, demande: DemandePremierMessage): Promise<ResultatPremier> {
  const lu = schemaDemande.safeParse(demande);
  if (!lu.success) throw new Error(`premier message : demande invalide (${lu.error.issues.map((i) => i.path.join('.')).join(', ')})`);
  const m = lu.data;
  const maintenant = d.maintenant ?? (() => new Date());

  // Sans filière (aucun compte, ou un compte retiré), le compte ci-dessous le dit : numéro indisponible.
  if ((await d.comptes.filiereDe(m.tenantId)) === 'api') return refus('filiere_api');
  const compte = await d.comptes.parEspace(m.tenantId);
  if (compte?.statut === 'banni') return refus('numero_coupe');
  // Relié, ou endormi : le job réveille un compte endormi avant d'envoyer.
  if (compte?.statut !== 'relie' && compte?.statut !== 'sommeil') return refus('numero_indisponible');
  // 🔴 Réservée aux réponses (2026-10-24, voir l'en-tête). Avant la fiche et les messages du mois, rien n'est touché ; et
  // avant la clé : aucune demande qui écrirait en premier ne rend une ligne, pas même celle d'avant cette règle.
  if (m.consentement.mode !== 'conversation') return refus('premier_contact');

  const deja = await d.premiers.existant(m.tenantId, m.cle);
  if (deja) return dejaLa(d, deja, maintenant());
  const gel = await d.premiers.geleJusqua(compte.id);
  if (gel !== null && gel.getTime() > maintenant().getTime()) return refus('gele');

  // Le numéro tel que la fiche le porte, et son `wa_id` : une seule conversation par personne.
  // 🔴 Lu en international STRICT (relecture du lot B) : `e164DepuisSaisie` retombe sur le numéro français quand la
  // lecture internationale échoue, et un numéro étranger mal saisi (`+65 1234 567`) devenait un mobile français, à qui le
  // message partait avec un consentement écrit à tort. Les chiffres lus doivent être ceux demandés, sans retouche.
  const e164 = /^[0-9]{8,15}$/.test(m.telephone) ? (normalizePhone(`+${m.telephone}`).e164 ?? null) : null;
  const waId = e164 && e164 === `+${m.telephone}` ? waIdOf(e164, null) : null;
  if (!e164 || !waId || jidDuWaId(waId) === null) return refus('sans_telephone');
  // Le contact a écrit, sa fiche existe : elle n'est jamais créée ici (une place de l'offre). Aucune fiche à ce numéro,
  // c'est que personne ne nous a écrit d'ici : ce serait écrire en premier.
  const fiche = await d.fiches.resoudreFiche(m.tenantId, { phone: e164 }, { creer: 'jamais' });
  if (!fiche.ok) return refus(fiche.code === 'unknown_contact' ? 'premier_contact' : 'sans_telephone');

  // La lecture de la fiche que fait l'envoi public avant son tri (`listContactsPourEnvoiApi`).
  const [lue] = await d.fiches.listContactsPourEnvoiApi(m.tenantId, [fiche.contactId]);
  if (lue?.optInStatus === 'opted_out') return refus('desabonne');

  if (await d.contacts.estDesabonneParWaId(m.tenantId, waId)) return refus('desabonne');
  if (await d.contacts.machineSeTaitParWaId(m.tenantId, waId)) return refus('bloque');

  // Compté en dernier : une unité consommée n'est jamais rendue, elle ne doit l'être que pour un message qui part en file.
  if (!(await d.quota.consommer(m.tenantId, 1)).ok) return refus('limite_modeles');

  const aleatoire = Math.min(Math.max((d.aleatoire ?? Math.random)(), 0), 1);
  const { ligne, cree } = await d.premiers.inserer(
    { tenantId: m.tenantId, cle: m.cle, waId, texte: m.texte, origine: m.origine, reference: m.reference }, aleatoire,
  );
  // Une demande concurrente de la même clé l'a insérée entre la lecture et ici : la sienne part, l'unité est perdue.
  if (!cree) return dejaLa(d, ligne, maintenant());
  await d.enfiler(m.tenantId, ligne.id, ligne.prevuLe);
  return { ok: true, id: ligne.id, prevuLe: ligne.prevuLe, dejaEnFile: false };
}

/** Au plus trois réclamations, une minute d'écart : un compte endormi se réveille en quelques secondes. */
export const ESSAIS_MAX = 3;
export const REESSAI_MS = 60_000;
/** Le gel des premiers messages après un refus de WhatsApp. */
export const GEL_MS = 72 * 3_600_000;

/**
 * L'origine du message dans la conversation : celle que pose déjà chaque chemin d'aujourd'hui. Un message Shopify part
 * de l'envoi public, donc d'une campagne (`src/campaign/engine.ts`) ; Claude est `mcp` ; l'API et la réponse différée
 * sont `api`.
 */
export const ORIGINE_DU_MESSAGE: Record<OriginePremier, OrigineMessage> = {
  shopify_commande: 'campagne',
  shopify_panier: 'campagne',
  mcp: 'mcp',
  api: 'api',
  reponse: 'api',
};

export interface DepsJobPremier {
  premiers: Pick<PremiersMessages, 'reclamer' | 'remettreEnFile' | 'terminer' | 'geleJusqua' | 'geler'>;
  comptes: Pick<ComptesApplication, 'parEspace' | 'filiereDe'>;
  /** `null` : le service n'est pas configuré ; le message attend ses essais, puis est abandonné. */
  client: Pick<ClientApplication, 'relier' | 'verifier' | 'envoyer'> | null;
  contacts: Pick<PgContactStore, 'estDesabonneParWaId' | 'machineSeTaitParWaId'>;
  inbox: Pick<PgInboxStore, 'recordOutboundByWaId'>;
  /** Dire aux administrateurs que les premiers messages du numéro sont gelés (`avisDeGel`, `src/application/avis.ts`). */
  prevenirDuGel(compte: CompteApplication, jusqua: Date): Promise<void>;
  enfiler: EnfilerPremier;
  /** L'issue chez l'appelant (Shopify à la tâche 5 ; Claude, l'API et la réponse : rien). */
  noterIssue(origine: OriginePremier, tenantId: string, reference: string | null, issue: IssueJobPremier): Promise<void>;
  /** Pour les tests seulement. */
  maintenant?: () => Date;
}

type Suite = { type: 'fin'; issue: IssueJobPremier } | { type: 'reessai' };
const fin = (issue: IssueJobPremier): Suite => ({ type: 'fin', issue });

/**
 * Ce que fait un refus du service. 🔴 Un compte coupé ne se relie jamais : `banni`, `statut` (le service refuse de le
 * relier) et `compte_inconnu` finissent. Un compte pas encore ouvert ou endormi, et une panne AVANT l'envoi, se
 * réessaient : on ne conclut jamais sur un doute. Le reste (`refuse`) finit sans rien de plus. Une panne À l'envoi ne
 * passe pas ici (`envoi_incertain`, dans `traiterPremierMessage`).
 */
function suiteDuRefus(raison: RaisonClient): Suite {
  if (raison === 'non_relie' || raison === 'sommeil' || raison === 'service_injoignable') return { type: 'reessai' };
  if (raison === 'banni' || raison === 'statut' || raison === 'compte_inconnu') return fin('numero_coupe');
  return fin('abandonne');
}

/** Ce que le job relit avant d'envoyer : tout a pu changer depuis l'enfilement. */
async function avantEnvoi(
  d: DepsJobPremier, l: PremierMessage, maintenant: Date,
): Promise<Suite | { type: 'envoyer'; compte: CompteApplication; client: NonNullable<DepsJobPremier['client']> }> {
  if (await d.contacts.estDesabonneParWaId(l.tenantId, l.waId)) return fin('desabonne');
  if (await d.contacts.machineSeTaitParWaId(l.tenantId, l.waId)) return fin('bloque');
  const compte = await d.comptes.parEspace(l.tenantId);
  if (!compte || compte.statut === 'banni' || compte.statut === 'deconnecte' || compte.statut === 'retire') return fin('numero_coupe');
  const gel = await d.premiers.geleJusqua(compte.id);
  if (gel !== null && gel.getTime() > maintenant.getTime()) return fin('gele');
  // Un espace passé à l'API depuis l'enfilement n'écrit plus par l'application (un numéro de Meta relié prime).
  if ((await d.comptes.filiereDe(l.tenantId)) !== 'application') return fin('filiere_api');
  if (!d.client) return { type: 'reessai' };
  if (compte.statut === 'sommeil') {
    // Réveillé ici, relu à l'essai suivant : la session met quelques secondes à s'ouvrir. Un refus du réveil ne change
    // rien, l'essai suivant le redemande.
    const r = await d.client.relier(compte.id);
    if (!r.ok) console.error(`application-premier-message ${l.id} : réveil du compte ${compte.id} refusé (${r.raison})`);
    return { type: 'reessai' };
  }
  const v = await d.client.verifier(compte.id, l.waId);
  if (!v.ok) return suiteDuRefus(v.raison);
  if (!v.present) return fin('pas_sur_whatsapp');
  return { type: 'envoyer', compte, client: d.client };
}

/**
 * Le job d'une ligne : la réclamer, relire STOP, blocage, compte et gel, vérifier l'adresse, envoyer, tracer dans la
 * conversation SANS prendre le fil (l'agent IA reste le répondeur), puis inscrire l'issue.
 */
export async function traiterPremierMessage(d: DepsJobPremier, data: { id: string }): Promise<void> {
  const ligne = await d.premiers.reclamer(data.id);
  if (!ligne) return;
  const maintenant = d.maintenant ?? (() => new Date());

  const finir = async (statut: 'envoye' | 'abandonne', issue: IssueJobPremier, messageId: string | null = null): Promise<void> => {
    await d.premiers.terminer(ligne.id, statut, issue, messageId);
    // La ligne est finie : un échec ici ne doit pas faire rejouer le job, qui ne trouverait plus rien à réclamer.
    try {
      await d.noterIssue(ligne.origine, ligne.tenantId, ligne.reference, issue);
    } catch (err) {
      console.error(`application-premier-message ${ligne.id} : issue ${issue} non inscrite chez l’appelant`, err);
    }
  };
  const reessayer = async (): Promise<void> => {
    if (ligne.essais >= ESSAIS_MAX) return finir('abandonne', 'abandonne');
    const prevuLe = new Date(maintenant().getTime() + REESSAI_MS);
    await d.premiers.remettreEnFile(ligne.id, prevuLe);
    await d.enfiler(ligne.tenantId, ligne.id, prevuLe);
  };

  if (perime(ligne, maintenant())) return finir('abandonne', 'expire');

  let suite: Awaited<ReturnType<typeof avantEnvoi>>;
  try {
    suite = await avantEnvoi(d, ligne, maintenant());
  } catch (err) {
    // Rien n'est parti : une lecture en échec remet la ligne en file plutôt que de la laisser réclamée pour toujours.
    console.error(`application-premier-message ${ligne.id} : lecture en échec avant l’envoi, nouvel essai`, err);
    return reessayer();
  }
  if (suite.type === 'fin') return finir('abandonne', suite.issue);
  if (suite.type === 'reessai') return reessayer();
  const { compte, client } = suite;

  // Le `wa_id` est fait de chiffres (CHECK de la migration) : son adresse existe toujours.
  const r = await client.envoyer(compte.id, jidDuWaId(ligne.waId)!, ligne.texte);
  if (r.ok) {
    const messageId = idDuMessage(compte.id, r.messageId);
    try {
      await d.inbox.recordOutboundByWaId(ligne.tenantId, ligne.waId, {
        body: ligne.texte, messageId, type: 'text', origine: ORIGINE_DU_MESSAGE[ligne.origine],
      });
    } catch (err) {
      // Le message est parti : une trace manquée ne doit pas le faire croire perdu, ni le faire renvoyer.
      console.error(`application-premier-message ${ligne.id} : envoyé, mais non tracé dans la conversation`, err);
    }
    return finir('envoye', 'envoye', messageId);
  }
  if (r.raison === 'refuse_whatsapp') {
    // 🔴 Arrêter et prévenir : les premiers messages du compte sont gelés, la session n'est pas touchée.
    const jusqua = new Date(maintenant().getTime() + GEL_MS);
    if (await d.premiers.geler(compte.id, jusqua)) {
      try {
        await d.prevenirDuGel(compte, jusqua);
      } catch (err) {
        console.error(`application-premier-message ${ligne.id} : gel du compte ${compte.id} posé, courriel non émis`, err);
      }
    }
    return finir('abandonne', 'refuse_whatsapp');
  }
  // 🔴 Au plus une fois : le service n'a pas répondu à l'ENVOI (délai dépassé, panne après le départ), le message est
  // peut-être parti. Il ne se réessaie jamais ; seul ce qui précède l'envoi se réessaie.
  if (r.raison === 'service_injoignable') return finir('abandonne', 'envoi_incertain');
  const s = suiteDuRefus(r.raison);
  return s.type === 'reessai' ? reessayer() : finir('abandonne', s.issue);
}
