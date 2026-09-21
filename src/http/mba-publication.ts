import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import {
  planifierPublication, authConfigRelais, NOM_CONNECTEUR_RELAIS,
  type Geste, type RelaisAPublier, type OutilAPublier, type EtatMeta,
} from '../mba/publication';
import { scopeTenant } from './scope';

export { corpsOutilMeta } from '../mba/publication';

/**
 * Publier le catalogue d'outils de l'espace chez Meta.
 *
 * 🔴 DEUX ROUTES, ET LA PREMIÈRE N'ÉCRIT RIEN. « Engage Me fait foi, la publication écrase » est la décision
 * de Julien du 2026-09-10 : écraser n'est acceptable que si l'on montre QUOI avant de le faire. Le `GET`
 * rend le plan en toutes lettres, le `POST` l'exécute. Une publication sans aperçu serait une promesse tenue
 * dans le dos du client.
 *
 * ⚠️ LE PLAN EST RECALCULÉ AU MOMENT D'APPLIQUER, jamais transmis par le navigateur. Le lui faire porter
 * ouvrirait une fenêtre où Meta a changé entre l'aperçu et le clic, et où l'on exécuterait des gestes
 * calculés sur un état périmé, en croyant montrer ce qu'on allait faire.
 *
 * 🔴 DEPUIS LE 2026-09-21, CE QUI PART EST LE RELAIS (spec 2026-09-21-relais-mba-design.md) : un connecteur
 * `EngageMe` par espace, dont les outils appellent Engage Me. Le plan pur vit dans `src/mba/publication.ts`.
 */

export interface MbaPublicationDeps {
  /** Numéro Meta du client, résolu côté serveur. `null` = aucun numéro, donc rien à publier. */
  numeroDuTenant(tenantId: string): Promise<string | null>;
  /** Le relais tel qu'il se présente à Meta. `null` = `PUBLIC_API_URL` vide : Meta ne saurait pas où appeler. */
  relais(tenantId: string): Promise<RelaisAPublier | null>;
  /** Les outils EXPOSÉS au MBA, avec les variables de leur requête. */
  outilsExposes(tenantId: string, phoneNumberId: string): Promise<OutilAPublier[]>;
  /** L'état actuel chez Meta. */
  etatMeta(tenantId: string, phoneNumberId: string): Promise<EtatMeta>;
  /**
   * Applique UN geste. Isolé pour rester testable sans réseau.
   *
   * ⚠️ `ctx` EST UN BAC À MÉMOIRE PARTAGÉ PAR TOUTE UNE PUBLICATION, et il n'est pas décoratif : sans lui,
   * l'implémentation relisait la liste des connecteurs CHEZ META à chaque geste. La route le crée vide et le
   * passe tel quel.
   */
  appliquer(tenantId: string, phoneNumberId: string, geste: Geste, ctx: Map<string, unknown>): Promise<void>;
}

/** Sans adresse publique, publier poserait chez Meta un connecteur qui n'appelle rien. */
const SANS_ADRESSE = 'L’adresse publique de l’API n’est pas réglée : l’agent de Meta ne saurait pas où appeler.';

export function registerMbaPublication(app: FastifyInstance, deps: MbaPublicationDeps, garde: Guard): void {
  const opts = { preHandler: garde };
  const base = '/tenants/:tenantId/mba-publication';

  /** Le plan, ou `null` quand l'adresse publique n'est pas réglée. */
  async function planifier(tenantId: string, pn: string): Promise<Geste[] | null> {
    const relais = await deps.relais(tenantId);
    if (relais === null) return null;
    const [outils, meta] = await Promise.all([deps.outilsExposes(tenantId, pn), deps.etatMeta(tenantId, pn)]);
    return planifierPublication(relais, outils, meta);
  }

  app.get(base, opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'espace interdit' });
    const pn = await deps.numeroDuTenant(tenant);
    if (!pn) return reply.code(200).send({ gestes: [], phoneNumberId: null });
    const gestes = await planifier(tenant, pn);
    if (gestes === null) return reply.code(409).send({ error: SANS_ADRESSE });
    return reply.code(200).send({ gestes, phoneNumberId: pn });
  });

  /**
   * Exécute le plan.
   *
   * 🔴 ON S'ARRÊTE AU PREMIER ÉCHEC, et on rend ce qui a été fait. Continuer laisserait un état à moitié
   * publié dont personne ne connaîtrait la forme ; s'arrêter en le disant permet de rejouer, et la
   * publication étant IDEMPOTENTE, rejouer ne refait pas ce qui a réussi.
   */
  app.post(base, opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'espace interdit' });
    const pn = await deps.numeroDuTenant(tenant);
    if (!pn) {
      return reply.code(409).send({ error: 'Aucun numéro WhatsApp connecté : il n’y a pas d’agent Meta où publier.' });
    }
    const gestes = await planifier(tenant, pn);
    if (gestes === null) return reply.code(409).send({ error: SANS_ADRESSE });
    const faits: Geste[] = [];
    // Vit le temps de CETTE publication, et meurt avec elle : deux publications ne partagent jamais un état
    // lu, ce qui serait précisément la façon d'agir sur une photo périmée.
    const ctx = new Map<string, unknown>();
    for (const g of gestes) {
      try {
        await deps.appliquer(tenant, pn, g, ctx);
        faits.push(g);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`mba-publication: ${g.type} « ${g.nom} » a échoué (${tenant}):`, err instanceof Error ? err.message : err);
        return reply.code(409).send({
          error: `Meta a refusé « ${g.nom} » (${g.type}). ${faits.length} geste(s) déjà appliqué(s), le reste n’a pas été tenté. Relancez : ce qui a réussi ne sera pas refait.`,
          faits,
        });
      }
    }
    return reply.code(200).send({ faits });
  });
}

/**
 * Le connecteur unique de l'espace chez Meta : l'adresse du RELAIS, et la clé « Agent de Meta » dans son
 * corps.
 *
 * 🔴 `auth_config` VOYAGE AVEC LE CONNECTEUR, ET C'EST NON NÉGOCIABLE CÔTÉ META (mesuré le 2026-09-18) : une
 * création ou une modification en `API_KEY` sans lui rend 400. La clé arrive donc ici en paramètre, à chaque
 * écriture, et c'est pourquoi toute modification du connecteur pose une clé neuve (`src/mba/cle-relais.ts`).
 */
export function corpsConnecteurRelais(baseUrl: string, cle: string): {
  name: string; description: string; base_url: string; auth_type: 'API_KEY'; auth_config: ReturnType<typeof authConfigRelais>;
} {
  return {
    name: NOM_CONNECTEUR_RELAIS,
    description: 'Engage Me : les outils de cet espace, appelés avec les valeurs de son carnet de contacts.',
    base_url: baseUrl,
    auth_type: 'API_KEY',
    auth_config: authConfigRelais(cle),
  };
}
