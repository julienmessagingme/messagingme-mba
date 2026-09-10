import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import type { OutilBibliotheque } from '../agent/catalog';
import { consommateurMba } from '../agent/consommateur';
import { scopeTenant, estUuid } from './scope';

/**
 * La BIBLIOTHÈQUE d'outils d'un espace (migration 0127).
 *
 * 🔴 POURQUOI UN MODULE À PART DE `agent-tools.ts`. Les deux écrans ne parlent pas du même objet : celui-ci
 * montre les DÉFINITIONS de l'espace, l'autre le CONSENTEMENT d'un agent. Les fondre ferait un module dont
 * la moitié des gardes ne s'appliquent qu'à la moitié des routes, et c'est ainsi qu'une garde finit par
 * manquer là où elle comptait. Le découpage suit l'objet, pas la couche technique.
 *
 * ⚠️ Son isolation passe par `scopeTenant`, pas par un numéro ni un agent dans l'URL : la bibliothèque est
 * une propriété de l'ESPACE, et c'est exactement ce que le lot 1 vient d'établir.
 */

export interface AgentCatalogueRouteDeps {
  listCatalogue(tenantId: string): Promise<OutilBibliotheque[]>;
  supprimerDefinition(tenantId: string, outilId: string): Promise<'ok' | 'rattachee' | 'introuvable'>;
  /**
   * Numéro Meta du client, RÉSOLU CÔTÉ SERVEUR. `null` = aucun numéro connecté, donc aucun MBA à exposer.
   *
   * ⚠️ Le navigateur n'envoie JAMAIS le numéro : le lui faire porter est exactement ce qui a produit trois
   * pannes du toggle MBA le 2026-09-10, la dernière parce qu'il ne l'avait pas encore chargé au clic.
   */
  numeroDuTenant?(tenantId: string): Promise<string | null>;
  rattacherConsommateur?(tenantId: string, consommateur: string, outilId: string): Promise<boolean>;
  detacherConsommateur?(tenantId: string, consommateur: string, outilId: string): Promise<boolean>;
  activerConsommateur?(tenantId: string, consommateur: string, outilId: string, actif: boolean, parUtilisateur: string): Promise<unknown>;
}

export function registerAgentCatalogue(app: FastifyInstance, deps: AgentCatalogueRouteDeps, guard?: Guard): void {
  // Même forme que `registerAgentTools` : le garde est OPTIONNEL pour que les tests montent le module avec
  // des dépendances minimales. En production il est TOUJOURS câblé, et `buildServer` refuse de démarrer si
  // un module à routes `:tenantId` est monté sans authentification.
  const opts = guard ? { preHandler: guard } : {};
  const base = '/tenants/:tenantId/agent-tools';

  app.get(base, opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'espace interdit' });
    return reply.code(200).send({ outils: await deps.listCatalogue(tenant) });
  });

  /**
   * Exposer, ou retirer, cet outil au Meta Business Agent.
   *
   * 🔴 EXPOSER = RATTACHER **ET** ACTIVER, EN UN SEUL GESTE, et c'est la seule fois où ces deux-là se
   * confondent. Pour un agent, ils sont distincts (on ajoute un outil, puis un humain relit ses mots avant
   * de l'exposer au modèle). Le MBA n'a pas d'écran de relecture chez nous : la case EST le consentement, et
   * la fabriquer en deux temps produirait un état « rattaché mais éteint » que rien n'afficherait.
   *
   * 🔴 CE QUE LE CLIENT PERD EN COCHANT, ET QUI DOIT ÊTRE DIT À L'ÉCRAN : `risk` et `autonome` N'EXISTENT
   * PAS chez Meta. Un outil marqué `irreversible` exposé au MBA sera appelé SANS notre garde d'autonomie,
   * parce que le modèle de Meta n'a aucun champ pour la porter. C'est le seul endroit de ce programme où
   * l'on abaisse une protection existante, et l'avertissement vit au moment du clic, pas dans une doc.
   *
   * ⚠️ L'identité vient du JETON, jamais du corps : la migration 0127 exige un activateur en base, et le lire
   * dans la requête ferait désigner à l'appelant qui a consenti à sa place.
   */
  app.put(`${base}/:outilId/mba`, opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'espace interdit' });
    if (!deps.numeroDuTenant || !deps.rattacherConsommateur || !deps.detacherConsommateur || !deps.activerConsommateur) {
      return reply.code(503).send({ error: 'exposition au MBA indisponible sur cette instance' });
    }
    const { outilId } = req.params as { outilId: string };
    if (!estUuid(outilId)) return reply.code(404).send({ error: 'outil introuvable' });
    const b = (req.body ?? {}) as { valeur?: unknown };
    if (typeof b.valeur !== 'boolean') return reply.code(400).send({ error: 'valeur booléenne requise' });

    const userId = (req as { auth?: { userId?: string } }).auth?.userId ?? '';
    if (b.valeur && userId === '') {
      return reply.code(403).send({ error: 'exposition impossible sans utilisateur identifié' });
    }

    const pn = await deps.numeroDuTenant(tenant);
    if (!pn) {
      // Pas de numéro connecté : il n'y a aucun agent Meta à qui exposer quoi que ce soit. On le DIT plutôt
      // que d'écrire une ligne pour un consommateur qui n'existe pas.
      return reply.code(409).send({ error: 'Aucun numéro WhatsApp connecté : il n’y a pas d’agent Meta à qui exposer cet outil.' });
    }
    const cle = consommateurMba(pn);

    if (!b.valeur) {
      await deps.detacherConsommateur(tenant, cle, outilId);
      return reply.code(200).send({ expose: false, consommateur: cle });
    }
    const rattache = await deps.rattacherConsommateur(tenant, cle, outilId);
    // `rattacherConsommateur` rend `false` quand la ligne existait DÉJÀ : ce n'est pas un échec, et il faut
    // quand même activer (l'outil pouvait être rattaché et éteint).
    const actif = await deps.activerConsommateur(tenant, cle, outilId, true, userId);
    if (!rattache && actif === null) return reply.code(404).send({ error: 'outil introuvable' });
    return reply.code(200).send({ expose: true, consommateur: cle });
  });

  /**
   * Supprime une DÉFINITION, donc pour TOUT LE MONDE.
   *
   * 🔴 REFUSE en 409 tant qu'un consommateur y est rattaché, MÊME INACTIF. La contrainte de la migration
   * 0127 est en `on delete cascade` : sans ce refus applicatif, la suppression emporterait en silence le
   * consentement d'agents qu'on ne regardait pas, et l'écran annoncerait un succès.
   *
   * ⚠️ 409 et pas 500 : Cloudflare remplace le corps de toute réponse 5xx par sa page d'erreur, donc un
   * message destiné à l'utilisateur n'arriverait jamais.
   */
  app.delete(`${base}/:outilId`, opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'espace interdit' });
    const { outilId } = req.params as { outilId: string };
    if (!estUuid(outilId)) return reply.code(404).send({ error: 'outil introuvable' });
    const verdict = await deps.supprimerDefinition(tenant, outilId);
    if (verdict === 'introuvable') return reply.code(404).send({ error: 'outil introuvable' });
    if (verdict === 'rattachee') {
      return reply.code(409).send({
        error: 'Cet outil est encore utilisé par au moins un agent. Retirez-le de chaque agent avant de le supprimer de l’espace.',
      });
    }
    return reply.code(204).send();
  });
}
