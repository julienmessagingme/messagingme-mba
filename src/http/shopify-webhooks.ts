import type { FastifyInstance, FastifyRequest } from 'fastify';
import { domaineShopify } from '../shopify/connexion';
import { verifierSignatureShopify } from '../shopify/signature';
import type { BoutiqueSignee } from '../shopify/store.pg';
import type { BoutiqueRecue, ReponseTraitement } from '../shopify/traitement';

/**
 * `POST /shopify/webhooks` : tous les webhooks de toutes les boutiques branchées (plan 2026-10-21, lot 1). L'adresse
 * est la même pour tous ; la boutique se reconnaît à `X-Shopify-Shop-Domain`, et c'est le secret de CETTE boutique qui
 * vérifie la signature.
 *
 * Dans cet ordre, et rien n'est lu du corps avant la signature :
 *   1. le domaine, contrôlé par sa forme AVANT toute lecture en base (401 s'il manque ou est mal formé) ;
 *   2. le secret de la boutique, par un cache court, absence comprise : un flot de requêtes forgées sur des domaines
 *      publics ne coûte pas une lecture et un déchiffrement chacune. 🔴 Et AUCUN plafond de débit avant la
 *      vérification : un tiers ferait refuser en 429 les vrais webhooks d'un marchand ;
 *   3. le HMAC du corps brut (401 s'il est faux ou absent) ;
 *   4. la boutique relue sans cache (son état, son consentement), puis le traitement, qui rend 200 ou 503.
 */

type AvecCorpsBrut = FastifyRequest & { rawBody?: Buffer };

export interface ShopifyWebhooksRouteDeps {
  boutiques: { boutiqueParDomaine(domaine: string): Promise<BoutiqueSignee | null> };
  traiter(b: BoutiqueRecue, sujet: string, corps: unknown): Promise<ReponseTraitement>;
  /** Durée de vie d'une entrée du cache des secrets. */
  cacheMs?: number;
  maintenant?: () => number;
}

const CACHE_MS = 60_000;
/** Au-delà, le cache se vide : des domaines inventés ne doivent pas remplir la mémoire. */
const CACHE_MAX = 10_000;

const entete = (req: FastifyRequest, nom: string): string | undefined => {
  const v = req.headers[nom];
  return typeof v === 'string' ? v : undefined;
};

export function registerShopifyWebhooks(app: FastifyInstance, deps: ShopifyWebhooksRouteDeps): void {
  const maintenant = deps.maintenant ?? Date.now;
  const duree = deps.cacheMs ?? CACHE_MS;
  const cache = new Map<string, { b: BoutiqueSignee | null; expire: number }>();

  const enCache = async (domaine: string): Promise<BoutiqueSignee | null> => {
    const t = maintenant();
    const e = cache.get(domaine);
    if (e && e.expire > t) return e.b;
    const b = await deps.boutiques.boutiqueParDomaine(domaine);
    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(domaine, { b, expire: t + duree });
    return b;
  };

  const refus = { error: 'signature invalide' };

  app.post('/shopify/webhooks', async (req, reply) => {
    const domaine = domaineShopify(entete(req, 'x-shopify-shop-domain'));
    const brut = (req as AvecCorpsBrut).rawBody;
    if (domaine === null || !brut) return reply.code(401).send(refus);
    const connue = await enCache(domaine);
    if (connue === null || !verifierSignatureShopify(brut, entete(req, 'x-shopify-hmac-sha256'), connue.secret)) {
      return reply.code(401).send(refus);
    }
    // Relue sans cache : « Couper » doit arrêter les messages tout de suite, pas une minute plus tard. Et le secret qui a
    // vérifié doit être ENCORE celui de la boutique : après une reconnexion avec une autre app, ou une reprise par un
    // autre espace, un webhook de l'ancienne app ne doit pas passer pendant la minute du cache (relecture du lot 1).
    const b = await deps.boutiques.boutiqueParDomaine(domaine);
    if (b === null || b.secret !== connue.secret || b.tenantId !== connue.tenantId) {
      cache.delete(domaine);
      return reply.code(401).send(refus);
    }
    const r = await deps.traiter(
      { tenantId: b.tenantId, domaine, etat: b.etat, pays: b.pays, consentementAffirme: b.consentementAffirme },
      entete(req, 'x-shopify-topic') ?? '',
      req.body,
    );
    return reply.code(r.statut).send(r.statut === 200 ? { recu: true } : { error: 'traitement à reprendre' });
  });
}
