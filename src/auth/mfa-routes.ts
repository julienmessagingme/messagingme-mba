import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Guard } from './middleware';
import type { EtatMfa, MfaStore } from './mfa-store.pg';
import { RateLimiter } from './rate-limit';
import { verifyMfa, verifyEnrolement, type EtapeConnexion } from './token';
import {
  verifierCode, genererSecret, uriOtpauth, EMETTEUR_TOTP, genererCodesSecours, empreinteCodeSecours,
} from './totp';

/** Les lignes de journal du second facteur que la connexion écrit elle-même (la réinitialisation s'écrit ailleurs). */
export type ActionMfa = 'mfa.active' | 'mfa.code_secours_utilise' | 'mfa.echec' | 'mfa.codes_regeneres' | 'mfa.desactive';

export interface MfaRouteDeps {
  secret: string;
  /**
   * Le magasin du second facteur. ABSENT -> ces routes répondent 503, et c'est un refus : la connexion d'un
   * admin rend alors un jeton d'étape que rien ne sait honorer, donc AUCUNE session d'admin sans second facteur.
   * L'absence ne peut jamais ouvrir une porte, seulement la fermer.
   */
  mfa?: MfaStore;
  /**
   * Journal, écrit dans CHAQUE espace de l'identité, jamais attendu sur le chemin de réponse. Le `detail` ne porte
   * ni code ni secret. Absent -> aucune trace (câblages de test).
   */
  auditMfa?: (identityId: string, action: ActionMfa, detail?: Record<string, unknown>) => Promise<void>;
}

/** Ce que la connexion fait une fois le second facteur passé : session (un espace) ou jeton de choix (plusieurs). */
export type SuiteDeConnexion = (etape: EtapeConnexion) => Promise<Record<string, unknown>>;

/**
 * 🔴 UN SEUL MESSAGE pour un code faux, rejoué ou hors fenêtre : les distinguer dirait à celui qui essaie lequel de
 * ses codes a été juste une fois.
 */
export const MESSAGE_CODE_INVALIDE = 'Code invalide ou expiré.';
const MESSAGE_ETAPE_EXPIREE = 'Cette étape a expiré, reconnectez-vous.';
const MESSAGE_TROP = 'Trop de tentatives, réessayez dans une minute.';
const MESSAGE_INDISPONIBLE = 'Double authentification indisponible.';
const MESSAGE_DEJA_ACTIVE = 'La double authentification est déjà active.';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * Le code présenté correspond-il au facteur ? TOTP d'abord, code de secours ensuite. Rend le moyen, ou `null`.
 *
 * 🔴 LE TOTP N'EST ACCEPTÉ QU'APRÈS L'ÉCRITURE CONDITIONNELLE DU PAS (`marquerPas`), et pas sur la seule
 * vérification en mémoire : deux présentations simultanées du même code lisent le même dernier pas et le
 * trouvent toutes deux neuf. Seule l'écriture en base les départage.
 */
async function verifierFacteur(mfa: MfaStore, etat: EtatMfa, code: string): Promise<'totp' | 'secours' | null> {
  if (etat.secret === null) return null;
  const pas = verifierCode(etat.secret, code, Date.now(), etat.dernierPas);
  if (pas !== null) return (await mfa.marquerPas(etat.identityId, pas)) ? 'totp' : null;
  const empreinte = empreinteCodeSecours(code);
  if (empreinte !== null && (await mfa.consommerCodeSecours(etat.identityId, empreinte))) return 'secours';
  return null;
}

/**
 * Les routes du second facteur (plan `docs/superpowers/plans/2026-09-25-mfa-admins.md`).
 *
 * DEUX FAMILLES, et elles ne se mélangent pas :
 *  - `/auth/mfa/verifier`, `/auth/mfa/enroler`, `/auth/mfa/activer` : AVANT toute session. Ce qui les autorise
 *    est un jeton d'étape signé (`mfaToken` ou `enrolToken`) ; sans lui, 401, comme une route gardée ;
 *  - `/auth/mfa/moi*` : AVEC une session (`garde`), pour l'enrôlement volontaire, la régénération des codes et la
 *    désactivation.
 *
 * ⚠️ LE PLAFOND EST PAR IDENTITÉ, pas par adresse IP : 5 essais par minute. La clé vient d'un jeton SIGNÉ ou d'une
 * session, donc d'une identité qui existe : la table est bornée par le nombre de personnes qui ont passé leur mot
 * de passe, et aucun plafond de clés n'est nécessaire (`src/auth/rate-limit.ts`, § « maxCles »).
 */
export function registerMfa(app: FastifyInstance, deps: MfaRouteDeps, garde: Guard, suite: SuiteDeConnexion): void {
  const essais = new RateLimiter(5, 60_000);
  // L'enrôlement tire un secret neuf à chaque appel : il ne se devine pas, il se borne seulement.
  const enrolements = new RateLimiter(10, 60_000);
  const journal = (identityId: string, action: ActionMfa, detail?: Record<string, unknown>): void => {
    // `?.` sur le RETOUR : dep absent -> `undefined`, et `.catch` dessus lèverait (cf. `markLogin`).
    void deps.auditMfa?.(identityId, action, detail)?.catch(() => {});
  };

  /** Le jeton d'étape du corps, vérifié, et le magasin. Répond lui-même (401, 503, 429) et rend `null` sinon. */
  async function etapeDe(
    reply: FastifyReply,
    jeton: unknown,
    verifier: (t: string, s: string) => Promise<EtapeConnexion | null>,
    limiteur: RateLimiter,
  ): Promise<{ etape: EtapeConnexion; mfa: MfaStore } | null> {
    // Le jeton AVANT le magasin : sans lui, rien n'autorise l'appel, et la réponse est celle d'une route gardée.
    const etape = typeof jeton === 'string' && jeton !== '' ? await verifier(jeton, deps.secret) : null;
    if (!etape) {
      await reply.code(401).send({ error: MESSAGE_ETAPE_EXPIREE });
      return null;
    }
    if (!deps.mfa) {
      await reply.code(503).send({ error: MESSAGE_INDISPONIBLE });
      return null;
    }
    if (!limiteur.take(etape.identityId)) {
      await reply.code(429).send({ error: MESSAGE_TROP });
      return null;
    }
    return { etape, mfa: deps.mfa };
  }

  /** L'état du facteur de la personne connectée. Répond lui-même (503, 404) et rend `null` sinon. */
  async function etatDeLaSession(req: FastifyRequest, reply: FastifyReply): Promise<{ etat: EtatMfa; mfa: MfaStore } | null> {
    if (!deps.mfa) {
      await reply.code(503).send({ error: MESSAGE_INDISPONIBLE });
      return null;
    }
    const etat = req.auth ? await deps.mfa.lireParCompte(req.auth.userId) : null;
    if (!etat) {
      await reply.code(404).send({ error: 'Compte inconnu.' });
      return null;
    }
    return { etat, mfa: deps.mfa };
  }

  // --- Avant toute session ---------------------------------------------------------------------------------

  /** Deuxième temps d'une connexion dont l'identité a un facteur actif : le code, puis la suite d'avant. */
  app.post('/auth/mfa/verifier', async (req, reply) => {
    const b = (req.body ?? {}) as { mfaToken?: unknown; code?: unknown };
    const ok = await etapeDe(reply, b.mfaToken, verifyMfa, essais);
    if (!ok) return reply;
    const etat = await ok.mfa.lire(ok.etape.identityId);
    const moyen = etat ? await verifierFacteur(ok.mfa, etat, str(b.code)) : null;
    if (!etat || !moyen) {
      journal(ok.etape.identityId, 'mfa.echec', { etape: 'connexion' });
      return reply.code(401).send({ error: MESSAGE_CODE_INVALIDE });
    }
    if (moyen === 'secours') {
      journal(ok.etape.identityId, 'mfa.code_secours_utilise');
      // Lu AVANT la consommation, d'où le -1 : la console prévient quand il n'en reste plus beaucoup.
      return reply.code(200).send({ ...(await suite(ok.etape)), codesSecoursRestants: Math.max(0, etat.codesSecoursRestants - 1) });
    }
    return reply.code(200).send(await suite(ok.etape));
  });

  /** Premier temps de l'enrôlement obligatoire : un secret neuf, à scanner ou à saisir à la main. */
  app.post('/auth/mfa/enroler', async (req, reply) => {
    const ok = await etapeDe(reply, (req.body as { enrolToken?: unknown } | undefined)?.enrolToken, verifyEnrolement, enrolements);
    if (!ok) return reply;
    const etat = await ok.mfa.lire(ok.etape.identityId);
    if (!etat) return reply.code(401).send({ error: MESSAGE_ETAPE_EXPIREE });
    // Activé entre-temps (un autre onglet) : le jeton d'enrôlement ne remplace jamais un facteur actif.
    if (etat.secret !== null) return reply.code(409).send({ error: `${MESSAGE_DEJA_ACTIVE} Reconnectez-vous.` });
    const secret = genererSecret();
    await ok.mfa.poserSecretEnAttente(ok.etape.identityId, secret);
    return reply.code(200).send({ secret, uri: uriOtpauth(EMETTEUR_TOTP, ok.etape.email, secret) });
  });

  /** Second temps de l'enrôlement : le premier code prouve que l'application lit le bon secret. */
  app.post('/auth/mfa/activer', async (req, reply) => {
    const b = (req.body ?? {}) as { enrolToken?: unknown; code?: unknown };
    const ok = await etapeDe(reply, b.enrolToken, verifyEnrolement, essais);
    if (!ok) return reply;
    const etat = await ok.mfa.lire(ok.etape.identityId);
    if (!etat) return reply.code(401).send({ error: MESSAGE_ETAPE_EXPIREE });
    if (etat.secret !== null) return reply.code(409).send({ error: `${MESSAGE_DEJA_ACTIVE} Reconnectez-vous.` });
    const codes = await activer(ok.mfa, etat, str(b.code), 'connexion');
    if (codes === 'invalide') return reply.code(401).send({ error: MESSAGE_CODE_INVALIDE });
    if (codes === 'deja_active') return reply.code(409).send({ error: `${MESSAGE_DEJA_ACTIVE} Reconnectez-vous.` });
    return reply.code(200).send({ codesSecours: codes, ...(await suite(ok.etape)) });
  });

  /**
   * Active le secret en attente si `code` est juste. Rend les dix codes de secours EN CLAIR (montrés une fois),
   * `invalide` ou `deja_active`. Partagé par l'enrôlement obligatoire et l'enrôlement volontaire.
   */
  async function activer(mfa: MfaStore, etat: EtatMfa, code: string, etape: string): Promise<string[] | 'invalide' | 'deja_active'> {
    // Aucun dernier pas : c'est le premier code de ce secret.
    const pas = etat.secretEnAttente === null ? null : verifierCode(etat.secretEnAttente, code, Date.now(), null);
    if (pas === null || etat.secretEnAttente === null) {
      journal(etat.identityId, 'mfa.echec', { etape });
      return 'invalide';
    }
    const { clairs, empreintes } = genererCodesSecours();
    if (!(await mfa.activer(etat.identityId, etat.secretEnAttente, pas, empreintes))) return 'deja_active';
    journal(etat.identityId, 'mfa.active');
    return clairs;
  }

  // --- Avec une session ------------------------------------------------------------------------------------

  const opts = { preHandler: garde };

  /** L'état, pour la page Compte. `obligatoire` dit si la désactivation sera refusée. */
  app.get('/auth/mfa/moi', opts, async (req, reply) => {
    const ok = await etatDeLaSession(req, reply);
    if (!ok) return reply;
    const { etat } = ok;
    return reply.code(200).send({
      actif: etat.secret !== null,
      activeLe: etat.activeLe?.toISOString() ?? null,
      codesSecoursRestants: etat.secret === null ? 0 : etat.codesSecoursRestants,
      obligatoire: etat.obligatoire,
    });
  });

  /** Enrôlement VOLONTAIRE (agent, manager), ou d'un admin après une réinitialisation, depuis la page Compte. */
  app.post('/auth/mfa/moi/enroler', opts, async (req, reply) => {
    const ok = await etatDeLaSession(req, reply);
    if (!ok) return reply;
    if (!enrolements.take(ok.etat.identityId)) return reply.code(429).send({ error: MESSAGE_TROP });
    if (ok.etat.secret !== null) return reply.code(409).send({ error: MESSAGE_DEJA_ACTIVE });
    const secret = genererSecret();
    await ok.mfa.poserSecretEnAttente(ok.etat.identityId, secret);
    return reply.code(200).send({ secret, uri: uriOtpauth(EMETTEUR_TOTP, ok.etat.email, secret) });
  });

  app.post('/auth/mfa/moi/activer', opts, async (req, reply) => {
    const ok = await etatDeLaSession(req, reply);
    if (!ok) return reply;
    if (!essais.take(ok.etat.identityId)) return reply.code(429).send({ error: MESSAGE_TROP });
    if (ok.etat.secret !== null) return reply.code(409).send({ error: MESSAGE_DEJA_ACTIVE });
    const codes = await activer(ok.mfa, ok.etat, str((req.body as { code?: unknown } | undefined)?.code), 'activation');
    if (codes === 'invalide') return reply.code(401).send({ error: MESSAGE_CODE_INVALIDE });
    if (codes === 'deja_active') return reply.code(409).send({ error: MESSAGE_DEJA_ACTIVE });
    return reply.code(200).send({ codesSecours: codes });
  });

  /**
   * RÉGÉNÈRE les dix codes de secours. 🔴 UN CODE EST EXIGÉ, même avec une session : une session volée (un poste
   * resté ouvert) ne doit pas pouvoir se fabriquer dix codes, qui lui donneraient un second facteur à elle.
   */
  app.post('/auth/mfa/moi/codes', opts, async (req, reply) => {
    const ok = await etatDeLaSession(req, reply);
    if (!ok) return reply;
    if (!essais.take(ok.etat.identityId)) return reply.code(429).send({ error: MESSAGE_TROP });
    if (ok.etat.secret === null) return reply.code(409).send({ error: 'La double authentification n’est pas active.' });
    if (!(await verifierFacteur(ok.mfa, ok.etat, str((req.body as { code?: unknown } | undefined)?.code)))) {
      journal(ok.etat.identityId, 'mfa.echec', { etape: 'codes' });
      return reply.code(401).send({ error: MESSAGE_CODE_INVALIDE });
    }
    const { clairs, empreintes } = genererCodesSecours();
    if (!(await ok.mfa.remplacerCodesSecours(ok.etat.identityId, empreintes))) {
      return reply.code(409).send({ error: 'La double authentification n’est pas active.' });
    }
    journal(ok.etat.identityId, 'mfa.codes_regeneres');
    return reply.code(200).send({ codesSecours: clairs });
  });

  /**
   * DÉSACTIVE le facteur. 🔴 REFUSÉ À UN ADMIN, quel que soit l'espace où il l'est : le facteur est obligatoire
   * pour lui, et le retirer lui-même reviendrait à rendre l'obligation facultative. Un code est exigé pour la même
   * raison que la régénération.
   */
  app.post('/auth/mfa/moi/desactiver', opts, async (req, reply) => {
    const ok = await etatDeLaSession(req, reply);
    if (!ok) return reply;
    if (ok.etat.obligatoire) {
      return reply.code(403).send({ error: 'La double authentification est obligatoire pour les administrateurs.' });
    }
    if (!essais.take(ok.etat.identityId)) return reply.code(429).send({ error: MESSAGE_TROP });
    if (ok.etat.secret === null) return reply.code(409).send({ error: 'La double authentification n’est pas active.' });
    if (!(await verifierFacteur(ok.mfa, ok.etat, str((req.body as { code?: unknown } | undefined)?.code)))) {
      journal(ok.etat.identityId, 'mfa.echec', { etape: 'desactivation' });
      return reply.code(401).send({ error: MESSAGE_CODE_INVALIDE });
    }
    // Le journal AVANT l'effacement serait faux s'il échouait ; APRÈS, il dit ce qui a eu lieu.
    await ok.mfa.desactiver(ok.etat.identityId);
    journal(ok.etat.identityId, 'mfa.desactive');
    return reply.code(200).send({ ok: true });
  });
}
