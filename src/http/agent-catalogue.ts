import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import type { OutilBibliotheque } from '../agent/catalog';
import { consommateurMba } from '../agent/consommateur';
import { scopeTenant, estUuid } from './scope';
import { risqueSelonMethode, type MethodeConnecteur } from '../agent/http-cible';

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
  /**
   * Crée un outil de connecteur rattaché DIRECTEMENT au Meta Business Agent, sans passer par un agent IA.
   *
   * 🔴 IL N'Y AVAIT AUCUN CHEMIN POUR ÇA, et c'est ce que ce lot ouvre. Un outil naissait en le donnant à un
   * agent IA : exposer un appel à Meta obligeait donc à créer un agent dont on n'a pas besoin, et à répondre
   * pour lui à des questions que Meta ignore. Julien, 2026-09-15 : « je ne sais pas où l'affecter pour le MBA ».
   */
  creerPourMba?(tenantId: string, phoneNumberId: string, outil: {
    sourceId: string; requestId: string; name: string; title: string; description: string; nePasUtiliser: string;
    params: unknown; risk: 'read' | 'write' | 'irreversible';
  }): Promise<{ id: string } | null>;
  /** La REQUÊTE que l'outil désignera, LUE côté serveur : le risque plancher et la source en dérivent. */
  requetePourOutil?(tenantId: string, requeteId: string): Promise<{ id: string; sourceId: string; methode: string; variables: Array<{ nom: string; type: string; origine: { type: string }; description?: string; requis?: boolean; enum?: string[] }> } | null>;
}

export function registerAgentCatalogue(app: FastifyInstance, deps: AgentCatalogueRouteDeps, garde: Guard): void {
  // Même forme que `registerAgentTools` : la garde est REQUISE depuis le lot 2 du plan 2026-09-14. Elle
  // était optionnelle « pour que les tests montent le module avec des dépendances minimales », et ce confort
  // d'écriture se payait en sûreté : un câblage qui l'omettait montait ces routes sans aucun contrôle, sans
  // qu'aucune erreur ne le dise. Les tests passent désormais `gardeOuverte` (`tests/gardes.ts`), qui DIT
  // qu'ils se moquent de l'authentification au lieu de le laisser deviner.
  const opts = { preHandler: garde };
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
   * CRÉER un outil et l'exposer à l'agent de Meta, d'un seul geste, sans agent IA.
   *
   * 🔴 AUCUNE QUESTION « POUSSE OU INTÈGRE » ICI, ET CE N'EST PAS UN OUBLI. Meta appelle le système du
   * client EN DIRECT et lit toute la réponse : notre filtre de sortie ne s'y applique pas, et la nature non
   * plus. Poser la question donnerait un réglage sans effet, c'est-à-dire le motif « offert-et-inerte » que
   * ce produit s'interdit ailleurs.
   *
   * 🔴 CRÉER **ET** EXPOSER EN UN SEUL GESTE, comme la case de la bibliothèque juste au-dessus, et pour la
   * même raison : le MBA n'a pas d'écran de relecture chez nous, donc un état « créé mais éteint » ne
   * s'afficherait nulle part.
   *
   * ⚠️ LA REQUÊTE EST LUE, PAS CRUE SUR PAROLE : le risque plancher en dérive, exactement comme sur la route
   * jumelle de `agent-tools.ts`. Un client qui déclarerait « read » sur un DELETE désarmerait une garde.
   */
  app.post(`${base}/connecteur-mba`, opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'espace interdit' });
    if (!deps.numeroDuTenant || !deps.creerPourMba || !deps.requetePourOutil || !deps.activerConsommateur) {
      return reply.code(503).send({ error: 'exposition au MBA indisponible sur cette instance' });
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const texte = (v: unknown, max: number): string | null =>
      (typeof v === 'string' && v.trim() !== '' && v.length <= max ? v.trim() : null);
    const requeteId = typeof b.requeteId === 'string' && estUuid(b.requeteId) ? b.requeteId : null;
    const name = typeof b.name === 'string' && /^[a-z0-9_]{1,64}$/.test(b.name) ? b.name : null;
    const title = texte(b.title, 120);
    const description = texte(b.description, 2000);
    const nePasUtiliser = texte(b.nePasUtiliser, 2000);
    if (!requeteId || !name || !title || !description || !nePasUtiliser) {
      return reply.code(400).send({ error: 'requête, nom technique et les trois textes sont requis' });
    }

    const userId = (req as { auth?: { userId?: string } }).auth?.userId ?? '';
    if (userId === '') return reply.code(403).send({ error: 'exposition impossible sans utilisateur identifié' });

    const pn = await deps.numeroDuTenant(tenant);
    if (!pn) {
      return reply.code(409).send({ error: 'Aucun numéro WhatsApp connecté : il n’y a pas d’agent Meta à qui exposer cet outil.' });
    }
    const requete = await deps.requetePourOutil(tenant, requeteId);
    if (!requete) return reply.code(404).send({ error: 'requête introuvable' });

    // Ce que le MODÈLE de Meta remplira : les variables dont l'origine est `modele`, comme pour un agent IA.
    // Les autres sont résolues par notre serveur, et les exposer inviterait à désigner la ressource d'un autre.
    const params = requete.variables
      .filter((v) => v.origine.type === 'modele')
      .map((v) => ({
        name: v.nom, type: v.type, source: 'modele' as const,
        ...(v.description ? { description: v.description } : {}),
        ...(v.requis ? { required: true } : {}),
        ...(v.enum && v.enum.length > 0 ? { enum: v.enum } : {}),
      }));

    try {
      const outil = await deps.creerPourMba(tenant, pn, {
        sourceId: requete.sourceId, requestId: requete.id,
        name, title, description, nePasUtiliser,
        params, risk: risqueSelonMethode(requete.methode as MethodeConnecteur),
      });
      if (!outil) return reply.code(404).send({ error: 'requête introuvable' });
      await deps.activerConsommateur(tenant, consommateurMba(pn), outil.id, true, userId);
      return reply.code(201).send({ id: outil.id, expose: true, consommateur: consommateurMba(pn) });
    } catch (err) {
      // Un nom déjà pris est un cas ordinaire, pas une panne : 409 avec le message, jamais une 5xx dont
      // Cloudflare remplacerait le corps.
      if (err instanceof Error && /nom/i.test(err.message)) return reply.code(409).send({ error: err.message });
      throw err;
    }
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
