import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { gardeEtendue, type Guard, type PreHandler } from '../auth/middleware';
import { espaceVerifie, nonEmpty } from './scope';
import { makeJournal, type AuditSink } from '../audit/journal';
import type { VerrousCourts } from '../db/verrous-courts';
import type { BilanDeconnexion, IssueDeconnexion } from '../account/deconnexion-numero';
import {
  activerNumero,
  connecterNumero,
  demanderCodeNumero,
  type DepsActivationNumero,
  type DepsConnexionNumero,
  type DepsDemandeCodeNumero,
} from '../account/connexion-numero';

export interface EmbeddedSignupRouteDeps extends DepsConnexionNumero, DepsDemandeCodeNumero, DepsActivationNumero {
  /**
   * Journal d'audit (les fixtures qui ne l'observent pas passent `journalMuet`). Rattacher un numéro, c'est donner
   * une voix : le produit parle aux clients sous cette identité, et un token business chiffré est conservé.
   * 🔴 Le `detail` ne porte pas le numéro affiché (donnée personnelle, table jamais purgée), seulement les
   * identifiants Meta du compte et du numéro.
   */
  audit: AuditSink;
  /** config_id de la configuration ES (dashboard Meta, Facebook Login for Business). Vide -> feature OFF. */
  configId: string;
  /** App ID Meta (public : sert au FB.init du front). */
  appId: string;
  graphVersion: string;

  // ----- « Délier » et « Relier » : l'interrupteur du numéro sur l'Accueil -----
  //
  // Requises, comme les précédentes. Aucune ne parle à Meta : délier est un état de cet espace, le numéro reste
  // relié à son compte WhatsApp et son jeton reste chiffré chez nous.

  /**
   * Délie le numéro de l'espace et met en pause ses campagnes WhatsApp en cours ou programmées
   * (`PgNumeroDelieStore.delier`). `null` = l'espace n'a aucun numéro.
   */
  delierNumero(tenantId: string): Promise<{ delieLe: string; campagnesEnPause: number } | null>;
  /**
   * Relie le numéro et lève les pauses `numero_delie` (`PgNumeroDelieStore.relier`). `null` = aucun numéro.
   */
  relierNumero(tenantId: string): Promise<{ campagnesReprises: number; campagnesReprogrammees: number } | null>;

  /**
   * Les verrous courts partagés par les copies de l'API (`src/db/verrous-courts.ts`) : ils tiennent la minute entre
   * deux demandes de code d'un numéro, quelle que soit la copie qui sert chacune. Requis : en mémoire, deux copies
   * laissaient partir deux demandes dans la même minute, et chacune coûte un des dix essais de Meta. Ils tiennent aussi
   * « Déconnecter le numéro » le temps du geste : un double clic, ou deux copies, ne le jouent pas deux fois.
   */
  verrous: Pick<VerrousCourts, 'prendre' | 'relacher'>;

  // ----- « Déconnecter le numéro » : le numéro quitte l'espace pour de bon -----
  //
  // Requises, comme les précédentes, et sans jeton : le câblage le résout.

  /**
   * Ce que la déconnexion effacerait et arrêterait, lu sans rien écrire (`PgDeconnexionNumeroStore.bilan`, plus le jeton
   * relu par le résolveur des appels chez Meta). `null` = l'espace n'a aucun numéro.
   */
  bilanDeconnexion(tenantId: string): Promise<BilanDeconnexion | null>;
  /**
   * Le déroulé (`deconnecterNumero`, `src/account/deconnexion-numero.ts`) avec ses gestes câblés, puis les caches de ce
   * process vidés (garde du numéro délié, jetons).
   */
  deconnecterNumero(tenantId: string, bilan: BilanDeconnexion): Promise<IssueDeconnexion>;
}

/**
 * La durée du verrou de « Déconnecter le numéro » : relâché à la fin du geste, il ne sert d'échéance que si la copie qui
 * le tient meurt en route. Assez long pour une purge et trois appels à Meta, assez court pour qu'un geste interrompu se
 * rejoue sans attendre.
 */
export const DUREE_VERROU_DECONNEXION_MS = 5 * 60_000;

/** Le corps de « Déconnecter le numéro » : la confirmation, explicite. */
const CORPS_DECONNEXION = z.object({ confirme: z.literal(true) });

/** Ce que dit un échec, par raison : rien de technique, et ce qu'il faut faire. */
const MESSAGE_ECHEC_DECONNEXION: Record<'purge' | 'detachement' | 'deja_detache', string> = {
  purge: 'L’effacement des conversations a échoué : le numéro est toujours connecté. Recommencez dans un instant.',
  detachement: 'Le numéro n’a pas pu être détaché : il est toujours connecté, mais Meta a peut-être déjà été prévenu. Recommencez dans un instant.',
  deja_detache: 'Cet espace n’a plus de numéro : la déconnexion a déjà eu lieu.',
};

/**
 * Embedded Signup (Tech Provider), admin. Quatre routes :
 *  - GET  /embedded-signup/config   : de quoi le front lance la popup (appId + configId publics, pas de secret).
 *  - POST /embedded-signup/complete : reçoit { code, wabaId, phoneNumberId } de la popup (code TTL 30 s),
 *    échange le code contre un business token, rattache WABA et numéro à l'espace, abonne les webhooks, register
 *    un numéro neuf (jamais un numéro déjà CONNECTED ni non vérifié), stocke le token chiffré, et offre le crédit
 *    de bienvenue si Meta dit le numéro vérifié. Les étapes non bloquantes qui échouent remontent en `warnings`.
 *  - POST /numero/code              : Meta envoie le code de vérification du numéro (appel par défaut, ou SMS).
 *  - POST /numero/activer           : vérifie le code s'il le faut (le crédit de bienvenue part alors), puis
 *    enregistre le numéro sur la Cloud API.
 * Les deux dernières existent parce que la fenêtre Meta peut se terminer sur un numéro non vérifié.
 */
export function registerEmbeddedSignup(
  app: FastifyInstance,
  deps: EmbeddedSignupRouteDeps,
  /**
   * La garde des quatre routes de la connexion : `adminOuLien`, la session d'admin OU le lien que donne Claude Code
   * (lot 3c). « Délier » et « relier » ne sont pas de la connexion : elles restent sur `gardeAdmin`.
   */
  garde: Guard,
  gardeAdmin: Guard,
  limiteCouteuse?: PreHandler,
): void {
  const journal = makeJournal(deps.audit);
  const opts = { preHandler: garde };
  const optsAdmin = { preHandler: gardeAdmin };
  // Les deux routes d'activation appellent Meta sur un quota étroit : elles portent la limite coûteuse, comme
  // l'import ou l'aperçu de site.
  const couteux = gardeEtendue(garde, limiteCouteuse);

  app.get('/tenants/:tenantId/embedded-signup/config', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const enabled = deps.configId !== '' && deps.appId !== '';
    return reply.code(200).send({ enabled, appId: deps.appId, configId: deps.configId, graphVersion: deps.graphVersion });
  });

  app.post('/tenants/:tenantId/embedded-signup/complete', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    if (deps.configId === '') return reply.code(503).send({ error: 'Embedded Signup non configuré (META_ES_CONFIG_ID)' });
    const b = (req.body ?? {}) as { code?: unknown; wabaId?: unknown; phoneNumberId?: unknown; evenement?: unknown };
    if (!nonEmpty(b.code)) return reply.code(400).send({ error: 'code requis' });
    const r = await connecterNumero(deps, {
      tenantId: tenant,
      code: b.code.trim(),
      ...(nonEmpty(b.wabaId) ? { wabaId: b.wabaId.trim() } : {}),
      ...(nonEmpty(b.phoneNumberId) ? { phoneNumberId: b.phoneNumberId.trim() } : {}),
      ...(typeof b.evenement === 'string' ? { evenement: b.evenement } : {}),
    }, async (trace) => {
      if (trace.action === 'compte.relie_sans_numero') {
        await journal(tenant, req, trace.action, { kind: 'waba', id: trace.wabaId }, { avertissements: trace.avertissements });
        return;
      }
      if (trace.action === 'numero.connecte') {
        await journal(tenant, req, trace.action, { kind: 'phone_number', id: trace.phoneNumberId }, {
          wabaId: trace.wabaId,
          avertissements: trace.avertissements,
        });
      }
    });
    if (!r.ok) return reply.code(r.statut).send({ error: r.error });
    if (!r.connected) {
      return reply.code(200).send({ connected: false, sansNumero: true, wabaId: r.wabaId, warnings: r.warnings });
    }
    return reply.code(200).send({
      connected: true,
      wabaId: r.wabaId,
      phoneNumberId: r.phoneNumberId,
      displayPhoneNumber: r.displayPhoneNumber,
      ...(r.aActiver ? { aActiver: true } : {}),
      ...(r.warnings.length > 0 ? { warnings: r.warnings } : {}),
    });
  });

  /**
   * Demande à Meta d'envoyer le code de vérification du numéro de l'espace. Elle lit l'état avant d'agir : Meta
   * refuse une demande sur un numéro déjà vérifié (136024), et chaque refus consomme une des dix requêtes.
   */
  app.post('/tenants/:tenantId/numero/code', couteux, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const body = (req.body ?? {}) as { methode?: unknown };
    const methode = body.methode === undefined ? 'VOICE' : body.methode;
    // VOICE par défaut : Meta déconseille le SMS sur un numéro VoIP, et un numéro qui ne reçoit pas de SMS
    // laisserait le client sans recours. Le SMS reste offert, c'est lui qui sait ce qu'est son numéro.
    if (methode !== 'VOICE' && methode !== 'SMS') return reply.code(400).send({ error: "methode invalide ('VOICE' ou 'SMS')" });
    const r = await demanderCodeNumero(deps, { tenantId: tenant, methode });
    if (!r.ok) return reply.code(r.statut).send({ error: r.error });
    return reply.code(200).send({ envoye: true, methode: r.methode });
  });

  /**
   * Active le numéro : vérifie le code s'il le faut, puis l'enregistre sur la Cloud API. Aucune relance
   * automatique : un échec laisse le numéro « à activer », et une répétition invisible consommerait le quota.
   */
  app.post('/tenants/:tenantId/numero/activer', couteux, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const body = (req.body ?? {}) as { code?: unknown };
    const r = await activerNumero(deps, {
      tenantId: tenant,
      ...(nonEmpty(body.code) ? { code: body.code.trim() } : {}),
    }, async (trace) => {
      if (trace.action === 'numero.active') {
        await journal(tenant, req, trace.action, { kind: 'phone_number', id: trace.phoneNumberId }, {
          verificationFaite: trace.verificationFaite,
        });
      }
    });
    if (!r.ok) return reply.code(r.statut).send({ error: r.error });
    return reply.code(200).send({ actif: true, ...(r.deja ? { deja: true } : {}) });
  });

  /**
   * Délie le numéro de l'espace (interrupteur « Numéro WhatsApp » de l'Accueil, éteint) : aucun envoi ne part
   * (`NumeroDelieError`), les campagnes WhatsApp en cours ou programmées passent en pause `numero_delie`, et les
   * messages reçus ne sont plus enregistrés. Rien n'est touché chez Meta ni supprimé chez nous : « Relier » se
   * fait d'un clic. Admin seulement (`g.admin`).
   */
  app.post('/tenants/:tenantId/numero/delier', optsAdmin, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const r = await deps.delierNumero(tenant);
    if (r === null) return reply.code(404).send({ error: 'aucun numéro rattaché à cet espace' });
    // L'identifiant de l'espace en cible : délier porte sur tous ses numéros, et le numéro affiché est une donnée
    // personnelle que ce journal, jamais purgé, n'a pas à porter.
    await journal(tenant, req, 'numero.delie', { kind: 'tenant', id: tenant }, { campagnesEnPause: r.campagnesEnPause });
    return reply.code(200).send({ delie: true, delieLe: r.delieLe, campagnesEnPause: r.campagnesEnPause });
  });

  /**
   * Relie le numéro, sans confirmation (éteindre se confirme, rallumer non). Les campagnes mises en pause par
   * « Délier » repartent : `running` pour celles qui tournaient (reprises par le balayage), `scheduled` pour les
   * programmées.
   */
  app.post('/tenants/:tenantId/numero/relier', optsAdmin, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const r = await deps.relierNumero(tenant);
    if (r === null) return reply.code(404).send({ error: 'aucun numéro rattaché à cet espace' });
    await journal(tenant, req, 'numero.relie', { kind: 'tenant', id: tenant }, { ...r });
    return reply.code(200).send({ relie: true, ...r });
  });

  /**
   * Le bilan que la confirmation de « Déconnecter le numéro » affiche : ce qui sera effacé, arrêté, perdu. Lecture seule.
   */
  app.get('/tenants/:tenantId/numero/deconnexion', optsAdmin, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const b = await deps.bilanDeconnexion(tenant);
    if (b === null) return reply.code(404).send({ error: 'aucun numéro rattaché à cet espace' });
    return reply.code(200).send(b);
  });

  /**
   * « Déconnecter le numéro » : le numéro quitte l'espace pour de bon (plan
   * `docs/superpowers/plans/2026-10-10-deconnecter-le-numero.md`). Les conversations sont effacées, l'agent de Meta
   * éteint et notre app désabonnée du compte WhatsApp (sauf objet partagé ou jeton global), un numéro fourni sorti et son
   * abonnement arrêté en fin de période, puis le numéro, son compte et son jeton oubliés : l'espace peut en connecter un
   * autre. Admin seulement, et `{ confirme: true }` exigé : un appel nu ne détache rien.
   *
   * 🔴 Un échec rend 409 avec les étapes jouées, jamais 5xx (Cloudflare remplacerait le corps par sa page) : avant le
   * détachement, rien n'est perdu que les conversations déjà effacées, et le geste se rejoue.
   */
  app.post('/tenants/:tenantId/numero/deconnecter', optsAdmin, async (req, reply) => {
    const tenant = espaceVerifie(req);
    if (!CORPS_DECONNEXION.safeParse(req.body).success) {
      return reply.code(400).send({ error: 'confirmation requise : { "confirme": true }' });
    }
    const prise = await deps.verrous.prendre([[`numero.deconnecter:${tenant}`, DUREE_VERROU_DECONNEXION_MS]]);
    if (prise === null) return reply.code(409).send({ error: 'Une déconnexion du numéro est déjà en cours pour cet espace.', cause: 'en_cours' });
    try {
      const b = await deps.bilanDeconnexion(tenant);
      if (b === null) return reply.code(404).send({ error: 'aucun numéro rattaché à cet espace' });
      const r = await deps.deconnecterNumero(tenant, b);
      // Les identifiants Meta seulement : le numéro affiché est une donnée personnelle, et ce journal n'est jamais purgé.
      await journal(tenant, req, 'numero.deconnecte', { kind: 'tenant', id: tenant }, {
        phoneNumberId: b.phoneNumberId, wabaId: b.wabaId, fait: r.fait, etapes: r.etapes.map((e) => `${e.etape}:${e.etat}`),
      });
      if (!r.fait) {
        return reply.code(409).send({ error: MESSAGE_ECHEC_DECONNEXION[r.raison], cause: r.raison, etapes: r.etapes });
      }
      return reply.code(200).send({ deconnecte: true, conversations: r.conversations, campagnesArretees: r.campagnesArretees, etapes: r.etapes });
    } finally {
      await deps.verrous.relacher(prise);
    }
  });
}
