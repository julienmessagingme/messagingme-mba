import { compteurEnvoiRefuse, type OptionsEnvoiPublic, type RapportEnvoi, type ResultatEnvoiPublic } from '../api/envoi-public';
import type { Filiere } from '../application/comptes';
import type {
  DemandePremierMessage, DepsJobPremier, IssueJobPremier, OriginePremier, RefusPremier, ResultatPremier,
} from '../application/premier-message';
import type { DonneeShopify, EvenementShopify } from './donnees';
import { composerTexteShopify, TEXTE_SHOPIFY_MAX } from './preparation';
import type { MessageBranche, PgShopifyStore } from './store.pg';

/**
 * L'ENVOI D'UN MESSAGE SHOPIFY, troisième adaptateur de `lancerEnvoiPublic` après `POST /v1/sends` et
 * `send_template_to_contact` (plan 2026-10-21, relecture du lot 1).
 *
 * 🔴 PAS LE MOTEUR DE SCÉNARIO : une automation ordinaire ne reprend jamais le fil (`automatisme_ordinaire`), donc une
 * confirmation ne partirait pas quand l'agent de Meta ou un opérateur tient la conversation, et quand elle part, elle clôt
 * le parcours en cours et la session d'agent IA. L'envoi public ne touche pas au fil, lit la catégorie du modèle chez
 * Meta, applique `optInAllows` (un MARKETING ne part qu'à une fiche consentante), le STOP, la limite des modèles du mois
 * et les gardes du numéro, et crée la fiche (limite de contacts comprise).
 *
 * Trois choix d'adaptateur, et rien d'autre :
 *   - la clé d'idempotence est la clé métier (`shopify:<boutique>:orders/paid:<id>`) : un webhook rejoué relit le rapport
 *     au lieu de renvoyer ;
 *   - le compteur ne décompte rien : le plafond de l'API publique est fait pour les intégrations, une vente flash ne doit
 *     pas y buter (la limite des modèles du mois, elle, s'applique dans le cycle) ;
 *   - les valeurs partent en variables du destinataire, jamais écrites sur la fiche (le lien de commande porte une clé
 *     d'accès), et une ligne de Campagnes porte le nom de l'événement ; un envoi où personne ne part n'en laisse aucune.
 */

export type EnvoyerPublic = (
  tenantId: string, corps: unknown, compter: (unites: number) => Promise<boolean>, options: OptionsEnvoiPublic,
) => Promise<ResultatEnvoiPublic>;

export interface EnvoiShopify {
  tenantId: string;
  cle: string;
  /** Le nom de la ligne dans Campagnes. */
  nomLigne: string;
  modele: string;
  langue: string;
  /** Les données de {{1}}, {{2}}... dans l'ordre ; chacune doit avoir sa valeur dans `valeurs`. */
  variables: readonly DonneeShopify[];
  valeurs: Partial<Record<DonneeShopify, string>>;
  telephone: string;
  /** La source du consentement affirmé par le marchand, ou `null` : la fiche ne devient pas consentante. */
  sourceConsentement: string | null;
}

/** Ce que devient un événement : l'issue inscrite, comptée par la carte. `en_cours` n'en est pas une (on réessaie). */
export type IssueEnvoi =
  | 'envoye' | 'desabonne' | 'sans_consentement' | 'bloque' | 'limite_contacts' | 'limite_modeles' | 'modele_refuse'
  | 'numero_indisponible' | 'sans_telephone' | 'refuse' | 'en_cours';

export async function envoyerShopify(envoyer: EnvoyerPublic, e: EnvoiShopify): Promise<IssueEnvoi> {
  const corps = {
    idempotencyKey: e.cle,
    target: { template: { name: e.modele, language: e.langue } },
    params: e.variables.map((cle, i) => ({ position: i + 1, source: { type: 'variable', key: cle } })),
    recipients: [{
      phone: e.telephone,
      ...(e.sourceConsentement !== null ? { consent: 'opted_in', consentSource: e.sourceConsentement } : {}),
      ...(e.variables.length > 0 ? { variables: Object.fromEntries(e.variables.map((cle) => [cle, e.valeurs[cle] ?? ''])) } : {}),
    }],
  };
  const r = await envoyer(e.tenantId, corps, async () => true, { nom: e.nomLigne, sansCampagneVide: true });
  if (compteurEnvoiRefuse(r)) return 'refuse';
  const c = r.corps as { code?: unknown; limite?: unknown } | null;
  if (r.statut === 201 || r.statut === 200) return issueDuRapport(r.corps as RapportEnvoi);
  if (r.statut === 402) return c?.limite === 'envoisModelesMois' ? 'limite_modeles' : 'refuse';
  if (r.statut === 409 && c?.code === 'idempotency_in_progress') return 'en_cours';
  if (r.statut === 409) return 'numero_indisponible';
  // La même clé avec un autre corps : le message a été rebranché entre deux tentatives. Rien n'est parti.
  if (r.statut === 422 && c?.code === 'idempotency_key_reused') return 'refuse';
  if (r.statut === 404 || r.statut === 422) return 'modele_refuse';
  return 'refuse';
}

/**
 * LES ISSUES DU TEXTE D'UN NUMÉRO RELIÉ PAR QR CODE (plan 2026-10-23, tâche 5), en plus de celles de l'envoi public.
 * `en_file` : la porte « écrire en premier » a mis le message en file ; le job inscrit ensuite son issue finale
 * (`noterIssueShopify`). `filiere_differente` : le message réglé ne correspond plus à la filière de l'espace (un modèle
 * sur un numéro relié par QR code, un texte sur l'API), rien ne part. `texte_trop_long` : une fois les données
 * remplies, le texte dépasse ce qu'un message WhatsApp porte, rien ne part. `premier_contact` : la porte refuse depuis le
 * 2026-10-24 tout message qu'un numéro relié par QR code écrirait en premier, donc chacun des trois (un texte réglé
 * avant cette règle), et le branchement en refuse un neuf (`brancherMessage`). Les autres viennent du job
 * (`IssueJobPremier`).
 */
export type IssueTexte =
  | 'en_file' | 'pas_sur_whatsapp' | 'gele' | 'numero_coupe' | 'refuse_whatsapp' | 'filiere_differente' | 'envoi_incertain'
  | 'expire' | 'abandonne' | 'texte_trop_long' | 'premier_contact';
export type IssueShopify = IssueEnvoi | IssueTexte;

/** Un refus de la porte devient l'issue du même nom ; `filiere_api` (l'espace est passé à l'API) est un croisement. */
export function issueDuRefusPremier(r: RefusPremier): IssueShopify {
  return r === 'filiere_api' ? 'filiere_differente' : r;
}

/** L'issue finale du job, inscrite chez Shopify : la même, `filiere_api` lue comme un croisement. */
export function issueDuJobPremier(i: IssueJobPremier): IssueShopify {
  return i === 'filiere_api' ? 'filiere_differente' : i;
}

export interface DepsEnvoiShopify {
  envoyer: EnvoyerPublic;
  /** La filière de l'espace, lue à l'envoi (`filiereDe`) : un espace a pu passer de l'une à l'autre depuis le réglage. */
  filiere(tenantId: string): Promise<Filiere | null>;
  /** La porte « écrire en premier » de la filière application (`enfilerPremierMessage`, liée par le câblage). */
  ecrirePremier(demande: DemandePremierMessage): Promise<ResultatPremier>;
}

export interface MessageShopify {
  tenantId: string;
  /** La clé métier de l'envoi public (`shopify:<boutique>:orders/paid:<id>`), clé de la file aussi. */
  cle: string;
  origine: Extract<OriginePremier, 'shopify_commande' | 'shopify_panier'>;
  /** La clé de l'événement ou le jeton du panier : là où le job inscrit l'issue finale. */
  reference: string;
  evenement: EvenementShopify;
  nomLigne: string;
  message: Pick<MessageBranche, 'modele' | 'texte' | 'langue' | 'variables'>;
  valeurs: Partial<Record<DonneeShopify, string>>;
  /** En E.164. */
  telephone: string;
  /** La source du consentement affirmé par le marchand, ou `null`. */
  sourceConsentement: string | null;
}

/**
 * L'AIGUILLAGE D'UN MESSAGE SHOPIFY, à l'envoi : un texte sur la filière application va à la porte « écrire en premier »,
 * qui le refuse depuis le 2026-10-24 (`premier_contact` : ce numéro ne fait que répondre, et un message Shopify ne répond
 * à rien) ; un modèle sur la filière API part par l'envoi public, comme avant. Tout croisement rend `filiere_differente`, sans rien envoyer. Un espace sans filière (son numéro retiré)
 * suit la voie de son réglage, qui le dit (`numero_indisponible`).
 */
export async function envoyerMessageShopify(d: DepsEnvoiShopify, e: MessageShopify): Promise<IssueShopify> {
  const filiere = await d.filiere(e.tenantId);
  if (e.message.texte !== null) {
    if (filiere === 'api') return 'filiere_differente';
    // 🔴 Sur un numéro relié par QR code, aucun des trois messages ne part sans l'accord affirmé du marchand (décision de
    // Julien du 2026-10-23) : la politique de WhatsApp vise tout message d'entreprise.
    if (e.sourceConsentement === null) return 'sans_consentement';
    const texte = composerTexteShopify(e.message.texte, e.evenement, e.valeurs, e.message.langue);
    if (texte.length > TEXTE_SHOPIFY_MAX) return 'texte_trop_long';
    const r = await d.ecrirePremier({
      tenantId: e.tenantId, cle: e.cle, telephone: e.telephone.replace(/^\+/, ''), texte, origine: e.origine,
      reference: e.reference, consentement: { mode: 'marchand', source: e.sourceConsentement },
    });
    // Déjà en file (un rejeu de la même clé) : la même issue, rien n'est compté deux fois.
    return r.ok ? 'en_file' : issueDuRefusPremier(r.refus);
  }
  // La contrainte de la migration 0252 exige l'un ou l'autre : sans modèle ni texte, rien ne part.
  if (e.message.modele === null) return 'refuse';
  if (filiere === 'application') return 'filiere_differente';
  return envoyerShopify(d.envoyer, {
    tenantId: e.tenantId, cle: e.cle, nomLigne: e.nomLigne, modele: e.message.modele, langue: e.message.langue,
    variables: e.message.variables, valeurs: e.valeurs, telephone: e.telephone, sourceConsentement: e.sourceConsentement,
  });
}

/**
 * L'issue finale d'un message Shopify écrit en premier, inscrite par le job de la file (`traiterPremierMessage`, worker) :
 * celle de l'événement (`reference` = sa clé) ou celle du panier (`reference` = son jeton), dans l'espace. Les autres
 * origines (Claude, l'API, une réponse) ne gardent aucune issue.
 */
export function noterIssueShopify(store: Pick<PgShopifyStore, 'noterIssue' | 'noterIssuePanier'>): DepsJobPremier['noterIssue'] {
  return async (origine, tenantId, reference, issue) => {
    if (reference === null) return;
    if (origine === 'shopify_commande') await store.noterIssue(tenantId, reference, issueDuJobPremier(issue));
    else if (origine === 'shopify_panier') await store.noterIssuePanier(tenantId, reference, issueDuJobPremier(issue));
  };
}

function issueDuRapport(rapport: RapportEnvoi): IssueEnvoi {
  if (rapport.recipientCount > 0) return 'envoye';
  const motif = rapport.skipped[0]?.reason;
  if (motif === 'opted_out') return 'desabonne';
  if (motif === 'no_consent') return 'sans_consentement';
  if (motif === 'blocked_contact') return 'bloque';
  if (motif === 'plan_limit_reached') return 'limite_contacts';
  if (motif === 'invalid_phone' || motif === 'no_phone' || motif === 'invalid_recipient') return 'sans_telephone';
  return 'refuse';
}
