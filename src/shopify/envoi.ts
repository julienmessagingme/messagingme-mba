import { compteurEnvoiRefuse, type OptionsEnvoiPublic, type RapportEnvoi, type ResultatEnvoiPublic } from '../api/envoi-public';
import type { DonneeShopify } from './donnees';

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
