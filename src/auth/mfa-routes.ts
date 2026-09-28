import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Guard } from './middleware';
import type { EtatMfa, MfaStore } from './mfa-store.pg';
import { RateLimiter } from './rate-limit';
import { verifyPassword } from './password';
import { verifyMfa, verifyEnrolement, type EtapeConnexion, type MoyenFacteur } from './token';
import {
  verifierCode, genererSecret, uriOtpauth, EMETTEUR_TOTP, genererCodesSecours, empreinteCodeSecours,
} from './totp';

/** Les lignes de journal du second facteur que la connexion écrit elle-même (la réinitialisation s'écrit ailleurs). */
export type ActionMfa = 'mfa.active' | 'mfa.code_secours_utilise' | 'mfa.echec' | 'mfa.codes_regeneres' | 'mfa.desactive';

export interface MfaRouteDeps {
  secret: string;
  /**
   * Le magasin du second facteur. Absent : ces routes répondent 503, et la connexion d'un admin rend un jeton
   * d'étape que rien n'honore, donc aucune session d'admin sans second facteur. L'absence ferme, jamais
   * n'ouvre.
   */
  mfa?: MfaStore;
  /**
   * Journal, écrit dans chaque espace de l'identité, jamais attendu sur le chemin de réponse ; le `detail` ne
   * porte ni code ni secret. Absent : aucune trace (câblages de test).
   */
  auditMfa?: (identityId: string, action: ActionMfa, detail?: Record<string, unknown>) => Promise<void>;
}

/**
 * `ttlChoix` allonge le jeton de choix quand l'écran des codes de secours s'intercale avant le choix.
 * `facteur` : le moyen qui vient de prouver le second facteur. Seules les routes du code et de l'activation le
 * passent, après vérification : c'est la preuve qu'exige une session d'exploitation.
 */
export interface OptionsSuite { ttlChoix?: string; facteur?: MoyenFacteur }

/**
 * Ce que la connexion fait une fois le second facteur passé : session (un espace), jeton de choix (plusieurs),
 * ou session d'exploitation (une étape `ops`).
 */
export type SuiteDeConnexion = (etape: EtapeConnexion, options?: OptionsSuite) => Promise<Record<string, unknown>>;

/** 🔴 Un seul message pour un code faux, rejoué ou hors fenêtre : les distinguer dirait lequel a été juste. */
export const MESSAGE_CODE_INVALIDE = 'Code invalide ou expiré.';
const MESSAGE_ETAPE_EXPIREE = 'Cette étape a expiré, reconnectez-vous.';
const MESSAGE_TROP = 'Trop de tentatives, réessayez dans une minute.';
const MESSAGE_INDISPONIBLE = 'Double authentification indisponible.';
const MESSAGE_DEJA_ACTIVE = 'La double authentification est déjà active.';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * Le code présenté correspond-il au facteur ? TOTP d'abord, code de secours ensuite ; rend le moyen, ou
 * `null`. Le TOTP n'est accepté qu'après l'écriture conditionnelle du pas (`marquerPas`) : deux
 * présentations simultanées du même code passent toutes deux la vérification en mémoire.
 * 🔴 Pendant un blocage (`bloqueJusqua`), seul un code de secours est lu : 80 bits ne se devinent pas.
 */
async function verifierFacteur(mfa: MfaStore, etat: EtatMfa, code: string): Promise<'totp' | 'secours' | null> {
  if (etat.secret === null) return null;
  if (!estBloque(etat)) {
    const pas = verifierCode(etat.secret, code, Date.now(), etat.dernierPas);
    if (pas !== null) return (await mfa.marquerPas(etat.identityId, pas)) ? 'totp' : null;
  }
  const empreinte = empreinteCodeSecours(code);
  if (empreinte !== null && (await mfa.consommerCodeSecours(etat.identityId, empreinte))) return 'secours';
  return null;
}

const estBloque = (etat: EtatMfa): boolean => etat.bloqueJusqua !== null && etat.bloqueJusqua.getTime() > Date.now();

/** Le refus d'un code pendant un blocage : il dit combien de temps, et que le code de secours reste une porte. */
function messageBloque(fin: Date): string {
  const minutes = Math.max(1, Math.ceil((fin.getTime() - Date.now()) / 60_000));
  return `Trop de codes faux : le code de l’application est bloqué pendant ${minutes} min. Un code de secours reste accepté.`;
}

/**
 * Les routes du second facteur, en deux familles :
 *  - `/auth/mfa/verifier`, `/auth/mfa/enroler`, `/auth/mfa/activer` : avant toute session, autorisées par un
 *    jeton d'étape signé (`mfaToken` ou `enrolToken`), 401 sans lui ;
 *  - `/auth/mfa/moi*` : avec une session (`garde`), pour l'enrôlement volontaire, la régénération des codes
 *    et la désactivation.
 *
 * Plafond par identité (5 essais par minute), pas par IP : la clé vient d'un jeton signé ou d'une session, la
 * table est bornée par les personnes qui ont passé leur mot de passe.
 */
export function registerMfa(app: FastifyInstance, deps: MfaRouteDeps, garde: Guard, suite: SuiteDeConnexion): void {
  const essais = new RateLimiter(5, 60_000);
  // L'enrôlement tire un secret neuf à chaque appel : il ne se devine pas, il se borne seulement.
  const enrolements = new RateLimiter(10, 60_000);
  const journal = (identityId: string, action: ActionMfa, detail?: Record<string, unknown>): void => {
    // `?.` sur le retour : dépendance absente, `undefined`, et `.catch` dessus lèverait.
    void deps.auditMfa?.(identityId, action, detail)?.catch(() => {});
  };

  /** Le jeton d'étape du corps, vérifié, et le magasin. Répond lui-même (401, 503, 429) et rend `null` sinon. */
  async function etapeDe(
    reply: FastifyReply,
    jeton: unknown,
    verifier: (t: string, s: string) => Promise<EtapeConnexion | null>,
    limiteur: RateLimiter,
  ): Promise<{ etape: EtapeConnexion; mfa: MfaStore } | null> {
    // Le jeton avant le magasin : sans lui, rien n'autorise l'appel, et la réponse est celle d'une route gardée.
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

  /**
   * Vérifie `code` et tient le compteur d'échecs en base. Rend le moyen, ou répond lui-même (401, ou 429 pendant
   * un blocage) et rend `null`.
   */
  async function controler(
    reply: FastifyReply, mfa: MfaStore, etat: EtatMfa, code: string, etape: string,
  ): Promise<'totp' | 'secours' | null> {
    const moyen = await verifierFacteur(mfa, etat, code);
    if (moyen) {
      await mfa.noterReussite(etat.identityId);
      return moyen;
    }
    const bloque = await mfa.noterEchec(etat.identityId);
    journal(etat.identityId, 'mfa.echec', { etape, ...(bloque ? { bloque: true } : {}) });
    if (bloque) await reply.code(429).send({ error: messageBloque(bloque) });
    else await reply.code(401).send({ error: MESSAGE_CODE_INVALIDE });
    return null;
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
    if (!etat) return reply.code(401).send({ error: MESSAGE_ETAPE_EXPIREE });
    const moyen = await controler(reply, ok.mfa, etat, str(b.code), 'connexion');
    if (!moyen) return reply;
    if (moyen === 'secours') {
      journal(ok.etape.identityId, 'mfa.code_secours_utilise');
      // Lu avant la consommation, d'où le -1 : la console prévient quand il n'en reste plus beaucoup.
      return reply.code(200).send({ ...(await suite(ok.etape, { facteur: moyen })), codesSecoursRestants: Math.max(0, etat.codesSecoursRestants - 1) });
    }
    return reply.code(200).send(await suite(ok.etape, { facteur: moyen }));
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
    // 15 minutes : l'écran des dix codes s'intercale avant le choix de l'espace. Le premier code de
    // l'application vient d'être vérifié par `activer`.
    return reply.code(200).send({ codesSecours: codes, ...(await suite(ok.etape, { ttlChoix: '15m', facteur: 'totp' })) });
  });

  /**
   * Active le secret en attente si `code` est juste. Rend les dix codes de secours en clair (montrés une fois),
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

  /**
   * Enrôlement volontaire (agent, manager), ou d'un admin après une réinitialisation, depuis la page Compte.
   * 🔴 Le mot de passe est exigé : une session volée ne doit pas pouvoir poser SON facteur sur le compte.
   * 403 et non 401 sur un mot de passe faux : un 401 ferait perdre la session à la console.
   */
  app.post('/auth/mfa/moi/enroler', opts, async (req, reply) => {
    const ok = await etatDeLaSession(req, reply);
    if (!ok) return reply;
    if (!enrolements.take(ok.etat.identityId)) return reply.code(429).send({ error: MESSAGE_TROP });
    if (ok.etat.secret !== null) return reply.code(409).send({ error: MESSAGE_DEJA_ACTIVE });
    const hash = await ok.mfa.motDePasse(ok.etat.identityId);
    if (hash === null) return reply.code(409).send({ error: 'Posez d’abord un mot de passe sur ce compte.' });
    if (!(await verifyPassword(str((req.body as { motDePasse?: unknown } | undefined)?.motDePasse), hash))) {
      journal(ok.etat.identityId, 'mfa.echec', { etape: 'enrolement' });
      return reply.code(403).send({ error: 'Mot de passe incorrect.' });
    }
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
   * Régénère les dix codes de secours. 🔴 Un code est exigé, même avec une session : une session volée ne doit
   * pas pouvoir se fabriquer un second facteur à elle.
   */
  app.post('/auth/mfa/moi/codes', opts, async (req, reply) => {
    const ok = await etatDeLaSession(req, reply);
    if (!ok) return reply;
    if (!essais.take(ok.etat.identityId)) return reply.code(429).send({ error: MESSAGE_TROP });
    if (ok.etat.secret === null) return reply.code(409).send({ error: 'La double authentification n’est pas active.' });
    if (!(await controler(reply, ok.mfa, ok.etat, str((req.body as { code?: unknown } | undefined)?.code), 'codes'))) return reply;
    const { clairs, empreintes } = genererCodesSecours();
    if (!(await ok.mfa.remplacerCodesSecours(ok.etat.identityId, empreintes))) {
      return reply.code(409).send({ error: 'La double authentification n’est pas active.' });
    }
    journal(ok.etat.identityId, 'mfa.codes_regeneres');
    return reply.code(200).send({ codesSecours: clairs });
  });

  /**
   * Désactive le facteur. 🔴 Refusé à un admin, où qu'il le soit : le facteur est obligatoire pour lui. Un code
   * est exigé, pour la même raison que la régénération.
   */
  app.post('/auth/mfa/moi/desactiver', opts, async (req, reply) => {
    const ok = await etatDeLaSession(req, reply);
    if (!ok) return reply;
    if (ok.etat.obligatoire) {
      return reply.code(403).send({ error: 'La double authentification est obligatoire pour les administrateurs.' });
    }
    if (!essais.take(ok.etat.identityId)) return reply.code(429).send({ error: MESSAGE_TROP });
    if (ok.etat.secret === null) return reply.code(409).send({ error: 'La double authentification n’est pas active.' });
    if (!(await controler(reply, ok.mfa, ok.etat, str((req.body as { code?: unknown } | undefined)?.code), 'desactivation'))) return reply;
    // Le journal après l'effacement : il dit ce qui a eu lieu.
    await ok.mfa.desactiver(ok.etat.identityId);
    journal(ok.etat.identityId, 'mfa.desactive');
    return reply.code(200).send({ ok: true });
  });
}
