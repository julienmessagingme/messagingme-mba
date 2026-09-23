import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { forbidNonAdmin, gardeEtendue, type Guard, type PreHandler } from '../auth/middleware';
import { scopeTenant } from './scope';
import type { ActifsAccordes } from '../meta/pubs';
import type { ConnexionPub } from '../pubs/connexion.pg';
import { makeJournal, type AuditSink } from '../audit/journal';

/**
 * LA CONNEXION PUBLICITAIRE D'UN ESPACE (lot 2 « Connecter », spec § 3.1).
 *
 * Quatre routes : lire l'état, échanger le code rendu par la fenêtre Meta, choisir le compte et la Page,
 * se déconnecter. La création d'une pub et son suivi sont le lot 3 et n'ont rien à faire ici.
 *
 * 🔴 LE JETON N'ENTRE JAMAIS DANS CE FICHIER, exactement comme dans `EmbeddedSignupRouteDeps` : le câblage
 * l'échange, le chiffre et le range, et ne laisse passer que le `tenantId`. Un jeton qui n'entre pas dans une
 * route ne peut ni fuiter dans un journal, ni partir dans un corps de réponse, ni être lu dans une trace de
 * pile.
 *
 * 🔴 AUCUNE DÉPENDANCE OPTIONNELLE, garde et plafond compris. Le dépôt a payé ce motif deux fois : la garde
 * d'authentification déclarée `guard?`, puis `estDesabonne?`, qui a fait écrire à des contacts désabonnés.
 * Un câblage qui en oublie une ne compile pas.
 */
export interface PubsRouteDeps {
  /**
   * `config_id` de la configuration Facebook Login for Business « publicités ». VIDE = fonctionnalité
   * éteinte, et l'écran le dit au lieu d'ouvrir une fenêtre qui échouerait.
   */
  configId: string;
  /** App ID Meta (public : sert au `FB.init` du front). */
  appId: string;
  graphVersion: string;
  /** L'état de la connexion, SANS le jeton. */
  lire(tenantId: string): Promise<ConnexionPub | null>;
  /** Échange le code (TTL 30 s), chiffre le jeton, le range, et rend ce que ce jeton accorde. */
  connecter(tenantId: string, code: string, userId: string | null): Promise<ActifsAccordes>;
  /** Ce que le jeton DÉJÀ rangé accorde. Sert à vérifier un choix, donc relu chez Meta, pas en base. */
  actifsAccordes(tenantId: string): Promise<ActifsAccordes>;
  /** Enregistre le choix après avoir lu chez Meta la devise, le fuseau et l'état de la liaison. */
  choisir(tenantId: string, choix: { comptePubId: string; pageId: string }): Promise<ConnexionPub>;
  deconnecter(tenantId: string): Promise<void>;
  audit: AuditSink;
}

/** `.strict()` : une clé en trop est refusée, le navigateur ne choisit pas ce qu'il envoie. */
const corpsEchange = z.object({ code: z.string().min(1).max(4096) }).strict();
const corpsChoix = z.object({
  comptePubId: z.string().min(1).max(64),
  pageId: z.string().min(1).max(64),
}).strict();

export function registerPubs(app: FastifyInstance, deps: PubsRouteDeps, garde: Guard, limiteCouteuse: PreHandler): void {
  const opts = { preHandler: garde };
  // L'échange et le choix appellent Meta : ils portent le plafond des routes coûteuses, par espace.
  const couteux = gardeEtendue(garde, limiteCouteuse);
  const journal = makeJournal(deps.audit);

  app.get('/tenants/:tenantId/pubs/connexion', opts, async (req, reply) => {
    const tenantId = scopeTenant(req);
    if (tenantId === null) return reply.code(403).send({ error: 'interdit' });
    const connexion = await deps.lire(tenantId);
    return reply.send({
      configure: deps.configId !== '',
      configId: deps.configId,
      appId: deps.appId,
      graphVersion: deps.graphVersion,
      connexion,
    });
  });

  app.post('/tenants/:tenantId/pubs/connexion/echange', couteux, async (req, reply) => {
    const tenantId = scopeTenant(req);
    if (tenantId === null) return reply.code(403).send({ error: 'interdit' });
    if (forbidNonAdmin(req, reply)) return;
    if (deps.configId === '') return reply.code(503).send({ error: 'publicités non configurées (META_ADS_CONFIG_ID)' });
    const corps = corpsEchange.safeParse(req.body);
    if (!corps.success) return reply.code(400).send({ error: 'code manquant' });

    let actifs: ActifsAccordes;
    try {
      actifs = await deps.connecter(tenantId, corps.data.code, req.auth?.userId ?? null);
    } catch (err) {
      // Le code a 30 secondes de vie et ne sert qu'une fois : l'échec le plus courant est un client qui a
      // laissé la fenêtre ouverte. On rend le message de Meta, c'est SON compte, et lui seul peut agir.
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'échange refusé par Meta' });
    }
    await journal(tenantId, req, 'pubs.connectee', { kind: 'pub_connexion', id: tenantId },
      { comptes: actifs.comptesPub.length, pages: actifs.pages.length });
    return reply.send(actifs);
  });

  app.post('/tenants/:tenantId/pubs/connexion/choix', couteux, async (req, reply) => {
    const tenantId = scopeTenant(req);
    if (tenantId === null) return reply.code(403).send({ error: 'interdit' });
    if (forbidNonAdmin(req, reply)) return;
    const corps = corpsChoix.safeParse(req.body);
    if (!corps.success) return reply.code(400).send({ error: 'choix invalide' });

    /**
     * 🔴 LE CHOIX SE VÉRIFIE CONTRE CE QUE LE JETON ACCORDE, ET CETTE LISTE SE RELIT CHEZ META.
     * Les identifiants viennent du navigateur : sans ce contrôle, un admin pourrait enregistrer le compte
     * publicitaire d'une autre entreprise, que nos appels utiliseraient ensuite en son nom. La relire en
     * base au lieu de chez Meta la rendrait périmée au premier retrait de droit côté client.
     */
    let actifs: ActifsAccordes;
    try {
      actifs = await deps.actifsAccordes(tenantId);
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'Meta ne répond pas' });
    }
    if (!actifs.comptesPub.includes(corps.data.comptePubId)) {
      return reply.code(400).send({ error: 'ce compte publicitaire n’est pas accordé par la connexion' });
    }
    if (!actifs.pages.includes(corps.data.pageId)) {
      return reply.code(400).send({ error: 'cette Page n’est pas accordée par la connexion' });
    }

    let connexion: ConnexionPub;
    try {
      connexion = await deps.choisir(tenantId, corps.data);
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'Meta ne répond pas' });
    }
    await journal(tenantId, req, 'pubs.actifs_choisis', { kind: 'pub_connexion', id: tenantId },
      { comptePubId: connexion.comptePubId, pageId: connexion.pageId, pageLiee: connexion.pageLiee });
    return reply.send({ connexion });
  });

  app.delete('/tenants/:tenantId/pubs/connexion', opts, async (req, reply) => {
    const tenantId = scopeTenant(req);
    if (tenantId === null) return reply.code(403).send({ error: 'interdit' });
    if (forbidNonAdmin(req, reply)) return;
    await deps.deconnecter(tenantId);
    await journal(tenantId, req, 'pubs.deconnectee', { kind: 'pub_connexion', id: tenantId });
    return reply.send({ ok: true });
  });
}
