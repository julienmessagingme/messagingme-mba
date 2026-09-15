import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import {
  planifierPublication, descriptionPourMeta, authTypeMeta, corpsApiKey,
  type Geste, type SourceAPublier, type OutilAPublier, type EtatMeta,
} from '../mba/publication';
import { scopeTenant } from './scope';

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
 */

export interface MbaPublicationDeps {
  /** Numéro Meta du client, résolu côté serveur. `null` = aucun numéro, donc rien à publier. */
  numeroDuTenant(tenantId: string): Promise<string | null>;
  /** Les sources de l'espace, sans secret. */
  sources(tenantId: string): Promise<SourceAPublier[]>;
  /** Les outils EXPOSÉS au MBA, déjà résolus avec leur méthode et leur chemin. */
  outilsExposes(tenantId: string, phoneNumberId: string): Promise<OutilAPublier[]>;
  /** L'état actuel chez Meta. */
  etatMeta(tenantId: string, phoneNumberId: string): Promise<EtatMeta>;
  /**
   * Applique UN geste. Isolé pour rester testable sans réseau.
   *
   * ⚠️ `ctx` EST UN BAC À MÉMOIRE PARTAGÉ PAR TOUTE UNE PUBLICATION, et il n'est pas décoratif : sans lui,
   * l'implémentation relisait la liste des connecteurs CHEZ META et les sources EN BASE à chaque geste. Sur
   * un plan de vingt gestes, cela faisait quarante lectures dont la moitié sur le réseau, pour un état qui
   * ne change qu'aux gestes qu'on vient d'appliquer. La route le crée vide et le passe tel quel.
   */
  appliquer(tenantId: string, phoneNumberId: string, geste: Geste, ctx: Map<string, unknown>): Promise<void>;
}

export function registerMbaPublication(app: FastifyInstance, deps: MbaPublicationDeps, garde: Guard): void {
  const opts = { preHandler: garde };
  const base = '/tenants/:tenantId/mba-publication';

  async function planifier(tenantId: string, pn: string): Promise<Geste[]> {
    const [sources, outils, meta] = await Promise.all([
      deps.sources(tenantId),
      deps.outilsExposes(tenantId, pn),
      deps.etatMeta(tenantId, pn),
    ]);
    return planifierPublication(sources, outils, meta);
  }

  app.get(base, opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'espace interdit' });
    const pn = await deps.numeroDuTenant(tenant);
    if (!pn) return reply.code(200).send({ gestes: [], phoneNumberId: null });
    return reply.code(200).send({ gestes: await planifier(tenant, pn), phoneNumberId: pn });
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
 * Le corps d'un outil chez Meta, construit depuis le nôtre.
 *
 * ⚠️ `request_definition` reste MINIMAL : méthode et chemin. Les macros, `transformation_spec` et
 * `user_auth_required: true` de Meta ne sont PAS gérés au premier lot, et on ne prétend pas le contraire :
 * un outil qui les utiliserait serait modifié dans WhatsApp Manager, donc écrasé, et l'aperçu le montre.
 */
export function corpsOutilMeta(o: OutilAPublier): {
  name: string; description: string; request_definition: unknown; user_auth_required: boolean;
} {
  return {
    name: o.name,
    description: descriptionPourMeta(o),
    request_definition: { method: o.methode, path: o.chemin },
    // Exigé par le schéma de Meta. `false` est le seul choix honnête : nous ne collectons aucun jeton par
    // utilisateur final. L'omettre ferait échouer la création.
    user_auth_required: false,
  };
}

/**
 * Le corps d'un connecteur, construit depuis une source.
 *
 * 🔴 `auth_config` EST DÉLIBÉRÉMENT ABSENT, et ce n'est pas un oubli : la documentation de Meta impose
 * d'OMETTRE ce champ quand `auth_type` vaut `NONE` (400 sinon), et pour les autres cas nous passons par
 * `upsertApiKey`, seul chemin qui sache faire TOURNER un secret sans recréer le connecteur. Un secret qui
 * n'a qu'un chemin d'écriture n'a qu'un endroit à auditer.
 *
 * ⚠️ IL NE DEMANDE QUE LES TROIS CHAMPS QU'IL CONSOMME, et ce `Pick` est du bon côté de la règle du dépôt :
 * ses membres sont lus SUR PLACE, donc un oubli serait une erreur au point d'usage. Le faire porter une
 * `SourceAPublier` entière obligeait ses deux appelants à recopier la source champ par champ, liste qui
 * dérive dès qu'on y ajoute un champ (ce qui vient d'arriver avec `secretPublie`).
 */
export function corpsConnecteurMeta(s: Pick<SourceAPublier, 'label' | 'baseUrl' | 'authKind'>): {
  name: string; description: string; base_url: string; auth_type: string;
} {
  return {
    name: s.label,
    description: `Système « ${s.label} » déclaré dans Engage Me.`,
    base_url: s.baseUrl,
    auth_type: authTypeMeta(s.authKind),
  };
}

export { corpsApiKey };
