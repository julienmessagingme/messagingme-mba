import { z } from 'zod';
import type { HttpTransport, HttpTransportPatch } from '../../meta/http';

/**
 * PROVISIONNER une cle AI Gateway chez Vercel, une par espace client (2026-09-09, demande de Julien).
 *
 * 🔴 DEUX APPELS, DEUX HOTES, DEUX AUTHENTIFICATIONS, et c'est le piege de ce fichier. Ils se ressemblent
 * assez pour qu'on croie pouvoir les ecrire pareil, et ils ne le sont pas :
 *   - CREER une cle : `api.vercel.com/v1/api-keys?teamId=...`, porte le JETON DE COMPTE (`VERCEL_API_TOKEN`),
 *     celui qui sait fabriquer des cles ;
 *   - BOUGER son plafond : `ai-gateway.vercel.sh/v1/quotas?quotaEntityId=api_key_id_<id>`, porte la CLE
 *     GATEWAY maison (`AI_GATEWAY_API_KEY`), et l'entite s'ecrit avec le prefixe `api_key_id_`, pas l'id nu.
 * Verifie dans la documentation Vercel avant d'ecrire une ligne, precisement parce que le second etait
 * devinable de travers de trois facons independantes.
 *
 * 🔴 LE SECRET N'EST RENDU QU'UNE FOIS, a la creation. Il n'existe aucun moyen de le relire ensuite. Un
 * echec d'ecriture en base APRES un appel reussi laisse donc une cle qui facture et que personne ne peut
 * plus utiliser : c'est l'appelant qui doit ecrire avant de rendre la main, jamais l'inverse.
 *
 * ⚠️ Le secret ne doit JAMAIS entrer dans un journal. Les erreurs de ce module ne portent que le statut HTTP
 * et le nom de l'operation, jamais le corps de la reponse (qui contient la cle en cas de succes partiel).
 */

const CREATION_URL = 'https://api.vercel.com/v1/api-keys';
const QUOTAS_URL = 'https://ai-gateway.vercel.sh/v1/quotas';

/**
 * `none` et pas `monthly` : le credit d'un client est PREPAYE, pas une allocation mensuelle. Un plafond qui
 * se recharge tout seul le premier du mois lui redonnerait gratuitement ce qu'il n'a pas achete.
 */
const PERIODE = 'none';

/** Reponse de creation. `safeParse`, jamais `parse` ni `as` : c'est une reponse externe (regle du repo). */
const creationSchema = z.object({
  id: z.string().min(1),
  apiKeyString: z.string().min(1),
});

export class CleGatewayError extends Error {
  constructor(readonly operation: 'creation' | 'plafond', readonly status: number | null, detail: string) {
    // ⚠️ `detail` est un LIBELLE choisi ici, jamais le corps de la reponse : celui d'une creation reussie
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

/**
 * Cree la cle d'un espace, avec son plafond.
 *
 * `nom` sert UNIQUEMENT a s'y retrouver dans le tableau de bord Vercel : il porte le nom de l'espace et son
 * identifiant, parce qu'un nom d'espace peut etre change ou duplique, alors que l'identifiant tranche.
 */
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
    // Reseau, delai depasse : on ne connait meme pas le statut. ⚠️ Une creation a PEUT-ETRE abouti cote
    // Vercel sans que la reponse nous parvienne. L'appelant refuse alors la creation d'agent, et la cle
    // orpheline reste bornee par le plafond d'equipe, seul filet qui ne depend pas de nous.
    throw new CleGatewayError('creation', null, err instanceof Error ? err.name : 'appel impossible');
  }
  if (res.status < 200 || res.status >= 300) {
    throw new CleGatewayError('creation', res.status, 'reponse en echec');
  }
  const parse = creationSchema.safeParse(res.json);
  if (!parse.success) {
    // 200 avec un corps qu'on ne reconnait pas : la cle existe peut-etre, on ne sait pas la lire. Echouer
    // est le seul choix honnete, deviner un champ en serait un autre qu'on paierait plus tard.
    throw new CleGatewayError('creation', res.status, 'reponse illisible');
  }
  return { id: parse.data.id, cle: parse.data.apiKeyString };
}

/**
 * Deplace le plafond d'une cle EXISTANTE, au rechargement du credit.
 *
 * ⚠️ Pas le meme hote ni la meme authentification que la creation, cf. l'en-tete du fichier.
 */
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
 * Le Gateway a-t-il refuse cet appel PARCE QUE le plafond est atteint ?
 *
 * 🔴 CE N'EST PAS UNE ERREUR TECHNIQUE, c'est un fait commercial : le client a consomme ce qu'il a achete.
 * Le confondre avec une panne ferait rejouer l'appel (donc echouer en boucle) et afficher « reessayez plus
 * tard » a quelqu'un dont le probleme est de recharger. Le type est stable cote Vercel, le message ne l'est
 * pas : on lit le type.
 */
export function estPlafondAtteint(corps: unknown): boolean {
  const type = (corps as { error?: { type?: unknown } } | null)?.error?.type;
  return type === 'quota_for_entity_exceeded';
}
