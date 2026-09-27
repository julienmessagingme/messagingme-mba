import { z } from 'zod';
import type { HttpTransport, HttpTransportPatch } from '../../meta/http';

/**
 * Provisionner une clé AI Gateway chez Vercel, une par espace client.
 *
 * Deux appels qui se ressemblent et ne s'écrivent pas pareil :
 *   - créer une clé : `api.vercel.com/v1/api-keys?teamId=...`, avec le jeton de compte (`VERCEL_API_TOKEN`) ;
 *   - bouger son plafond : `ai-gateway.vercel.sh/v1/quotas?quotaEntityId=api_key_id_<id>`, avec la clé
 *     Gateway maison (`AI_GATEWAY_API_KEY`), et l'entité préfixée `api_key_id_`, pas l'id nu.
 *
 * 🔴 Le secret n'est rendu qu'une fois, à la création : un échec d'écriture en base après un appel réussi
 * laisse une clé qui facture sans servir. Il n'entre jamais dans un journal : les erreurs ne portent que le
 * statut HTTP et l'opération, jamais le corps.
 */

const CREATION_URL = 'https://api.vercel.com/v1/api-keys';
const QUOTAS_URL = 'https://ai-gateway.vercel.sh/v1/quotas';

/**
 * `none` et pas `monthly` : le crédit d'un client est prépayé, un plafond rechargé le premier du mois lui
 * redonnerait gratuitement ce qu'il n'a pas acheté.
 */
const PERIODE = 'none';

/**
 * Réponse de création (`safeParse` : réponse externe). L'identifiant est sous `apiKey.id`, pas à la racine
 * comme l'annonce la documentation de Vercel : sans cette garde, on enregistrerait une clé sans identifiant,
 * impossible à replafonner ou à révoquer pendant qu'elle facture.
 */
const creationSchema = z.object({
  apiKeyString: z.string().min(1),
  apiKey: z.object({ id: z.string().min(1) }),
});

export class CleGatewayError extends Error {
  constructor(readonly operation: 'creation' | 'plafond' | 'revocation', readonly status: number | null, detail: string) {
    // `detail` est un libellé choisi ici, jamais le corps de la réponse : celui d'une création réussie
    // porte le secret, et ce message finit dans les journaux.
    super(`cle gateway : ${operation} impossible (${status ?? 'reseau'}) : ${detail}`);
    this.name = 'CleGatewayError';
  }
}

export interface CleCreee {
  /** Identifiant Vercel, en clair : sert a bouger le plafond et a revoquer. */
  id: string;
  /** Le secret. A chiffrer immediatement, a ne journaliser jamais. */
  cle: string;
}

/** Crée la clé d'un espace, avec son plafond. `nom` ne sert qu'à s'y retrouver dans le tableau de bord Vercel. */
export async function creerCleGateway(
  transport: HttpTransport,
  o: { jetonCompte: string; teamId: string; nom: string; plafondDollars: number },
): Promise<CleCreee> {
  let res;
  try {
    res = await transport.post(
      `${CREATION_URL}?teamId=${encodeURIComponent(o.teamId)}`,
      {
        purpose: 'ai-gateway',
        name: o.nom,
        aiGatewayQuota: { limitAmount: o.plafondDollars, refreshPeriod: PERIODE },
      },
      { authorization: `Bearer ${o.jetonCompte}` },
    );
  } catch (err) {
    // Réseau, délai dépassé : la création a peut-être abouti chez Vercel sans que la réponse arrive.
    // L'appelant refuse la création d'agent ; la clé orpheline reste bornée par le plafond d'équipe.
    throw new CleGatewayError('creation', null, err instanceof Error ? err.name : 'appel impossible');
  }
  if (res.status < 200 || res.status >= 300) {
    throw new CleGatewayError('creation', res.status, 'reponse en echec');
  }
  const parse = creationSchema.safeParse(res.json);
  if (!parse.success) {
    // 200 avec un corps inconnu : la clé existe peut-être, on ne sait pas la lire. Échouer plutôt que deviner.
    throw new CleGatewayError('creation', res.status, 'reponse illisible');
  }
  return { id: parse.data.apiKey.id, cle: parse.data.apiKeyString };
}

/** Déplace le plafond d'une clé existante, au rechargement du crédit (autre hôte, autre authentification). */
export async function majPlafondCleGateway(
  transport: HttpTransportPatch,
  o: { cleGatewayMaison: string; cleId: string; plafondDollars: number },
): Promise<void> {
  let res;
  try {
    res = await transport.patch(
      `${QUOTAS_URL}?quotaEntityId=${encodeURIComponent(`api_key_id_${o.cleId}`)}`,
      { limitAmount: o.plafondDollars, refreshPeriod: PERIODE },
      { authorization: `Bearer ${o.cleGatewayMaison}` },
    );
  } catch (err) {
    throw new CleGatewayError('plafond', null, err instanceof Error ? err.name : 'appel impossible');
  }
  if (res.status < 200 || res.status >= 300) {
    throw new CleGatewayError('plafond', res.status, 'reponse en echec');
  }
}

/**
 * Supprime une clé chez Vercel, pour le rattrapage : entre l'appel réussi et l'écriture en base, une clé
 * peut exister chez Vercel et nulle part chez nous, facturable et inutilisable. Ne lève jamais : elle est
 * appelée depuis un chemin qui échoue déjà, et masquerait l'erreur d'origine.
 */
export async function supprimerCleGateway(
  transport: HttpTransportSuppression,
  o: { jetonCompte: string; teamId: string; cleId: string },
): Promise<boolean> {
  try {
    const res = await transport.delete(
      `${CREATION_URL}/${encodeURIComponent(o.cleId)}?teamId=${encodeURIComponent(o.teamId)}`,
      { authorization: `Bearer ${o.jetonCompte}` },
    );
    return res.status >= 200 && res.status < 300;
  } catch {
    return false;
  }
}

/** Le transport, plus `DELETE`, à part pour ne pas ajouter une méthode obligatoire aux faux existants. */
export interface HttpTransportSuppression {
  delete(url: string, headers: Record<string, string>): Promise<{ status: number }>;
}

/**
 * Le Gateway a-t-il refusé cet appel parce que le plafond est atteint ? Un fait commercial, pas une panne :
 * le rejouer échouerait en boucle, et le client doit recharger. On lit le type, stable, pas le message.
 */
export function estPlafondAtteint(corps: unknown): boolean {
  const type = (corps as { error?: { type?: unknown } } | null)?.error?.type;
  return type === 'quota_for_entity_exceeded';
}
