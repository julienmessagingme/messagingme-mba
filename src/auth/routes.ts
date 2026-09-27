import { randomBytes, createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { verifyPassword, hashPassword, hashPasswordSync } from './password';
import { signSession, signChoice, verifyChoice, signMfa, signEnrolement, type EtapeConnexion } from './token';
import { RateLimiter } from './rate-limit';
import { registerMfa, type MfaRouteDeps } from './mfa-routes';
import type { UserAuthStore } from './store';
import type { UserStateLoader, Guard } from './middleware';
import type { GoogleIdentity } from './google';
import { DuplicateEmailError } from '../user/store.pg';
import { nomEspace, MESSAGE_NOM_ESPACE_INVALIDE } from '../user/nom-espace';

export interface AuthRouteDeps extends MfaRouteDeps {
  /**
   * Journal d'audit des connexions échouées ; absent : aucune trace. Écrit seulement pour un compte qui existe :
   * `audit_log.tenant_id` est NOT NULL, une tentative sur une adresse inconnue n'a nulle part où s'écrire, et
   * l'écran doit le dire. Sûr sur ce chemin non authentifié grâce au frein placé avant (dix tentatives par
   * minute et par clé, 429 avant la vérification du mot de passe). L'acteur est le compte visé ; le `detail`
   * ne porte ni l'adresse ni l'IP (table jamais purgée, l'IP est une donnée personnelle), seulement la cause.
   */
  auditConnexion?: (tenantId: string, userId: string, cause: 'mot_de_passe' | 'compte_desactive') => Promise<void>;
  users: UserAuthStore;
  secret: string;
  /** Rate-limit du login (clé `ip::adresse`). Défaut : 10 tentatives par minute. */
  loginRateLimit?: { max: number; windowMs: number };
  /** Relecture par requête de l'état du compte (révoqué, supprimé, rôle frais). Absent en test (JWT seul).
   *  Voir makeRequireAuth. */
  getUserState?: UserStateLoader;
  /** Inscription libre : crée un espace et son admin. `passwordHash` null = compte Google seul. Absent : 503. */
  createTenantWithAdmin?(workspaceName: string, admin: { email: string; name: string | null; passwordHash: string | null }): Promise<{ tenantId: string; userId: string }>;
  /** Pose (écrase) le hash de mot de passe d'un compte (reset / changement). */
  setPassword?(userId: string, hash: string): Promise<boolean>;
  /** Hash de mot de passe courant d'un compte (vérification au changement). null si absent/sans mdp. */
  getPasswordHash?(userId: string): Promise<string | null>;
  /** Le mot de passe de l'identité d'une adresse : `undefined` = adresse inconnue, `null` = identité sans mot de passe. */
  motDePasseDeLAdresse?(email: string): Promise<string | null | undefined>;
  /** {tenantId, role, email} d'un compte par id : émettre une session après acceptation d'invitation. */
  sessionUser?(userId: string): Promise<{ tenantId: string; role: string; email: string } | null>;
  /** Client OAuth Google (public) : exposé via GET /auth/config, sert au front pour le bouton. */
  googleClientId?: string;
  /** Vérifie un jeton ID Google -> identité (email vérifié), ou null si invalide. */
  verifyGoogle?(idToken: string): Promise<GoogleIdentity | null>;
  /** Tous les comptes d'une adresse, tout statut (login Google lié par adresse). Vide = adresse inconnue. */
  getUserByEmail?(email: string): Promise<Array<{ id: string; tenantId: string; tenantName: string; role: string; disabled: boolean }>>;
  /** Tokens à usage unique (reset / invite). */
  tokens?: {
    create(purpose: 'reset' | 'invite', userId: string, ttlMs: number): Promise<string>;
    consume(purpose: 'reset' | 'invite', raw: string): Promise<string | null>;
  };
  /** Envoi d'e-mail (Resend) pour les liens. Absent : forgot-password répond 200 sans rien envoyer. */
  sendEmail?(input: { to: string; subject: string; text: string; html?: string }): Promise<void>;
  /** Base URL du front pour les liens d'email. */
  appUrl?: string;
  /** Durée de validité d'un lien de reset (ms). */
  resetTtlMs?: number;
  /**
   * Horodate la dernière connexion réussie (page Équipe). Optionnel : les tests construisent `auth` avec
   * `{ users, secret }` seuls.
   */
  touchLastLogin?(userId: string): Promise<void>;
}

/**
 * Marque une connexion réussie sans jamais bloquer ni faire échouer la réponse (fire-and-forget) : une
 * écriture Postgres sur ce chemin transformerait un pool saturé en « identifiants refusés ». `?.` sur le
 * retour : dépendance absente, `undefined`, et `.catch` dessus lèverait.
 */
function markLogin(deps: AuthRouteDeps, userId: string): void {
  void deps.touchLastLogin?.(userId)?.catch(() => {});
}

/**
 * La suite d'une connexion réussie, une fois le second facteur passé ou non dû : une session si l'identité
 * n'a qu'un espace, un jeton de choix sinon. Une seule fonction pour `/auth/login`, `/auth/mfa/verifier` et
 * `/auth/mfa/activer` : une copie qui divergerait ouvrirait un espace sans passer par le choix. `markLogin`
 * n'est appelé qu'ici, à l'ouverture effective d'une session.
 */
async function suiteDeConnexion(deps: AuthRouteDeps, etape: EtapeConnexion): Promise<Record<string, unknown>> {
  const [premier, ...autres] = etape.comptes;
  // Impossible par construction : lever plutôt que d'ouvrir quoi que ce soit sur une étape sans compte.
  if (!premier) throw new Error('suite de connexion sans compte');
  // Un seul espace : on y va, sans écran de plus.
  if (autres.length === 0) {
    const token = await signSession({ userId: premier.userId, tenantId: premier.tenantId, role: premier.role }, deps.secret);
    markLogin(deps, premier.userId);
    return { token, user: { email: etape.email, role: premier.role, tenantId: premier.tenantId } };
  }
  // Plusieurs espaces : on demande, choisir au hasard ferait entrer chez le mauvais client. 🔴 Aucun jeton de
  // session ici : un jeton de choix, court, qui ne vaut que pour `/auth/choose-workspace`.
  const choix = await signChoice(
    { email: etape.email, comptes: etape.comptes.map((c) => ({ userId: c.userId, tenantId: c.tenantId, role: c.role })) },
    deps.secret,
  );
  return {
    choiceToken: choix,
    workspaces: etape.comptes.map((c) => ({ tenantId: c.tenantId, tenantName: c.tenantName, role: c.role })),
  };
}

/**
 * Le second facteur, après le mot de passe et avant tout accès : connexion, inscription et invitation
 * acceptée passent par ici.
 *  - facteur actif : `{ mfaToken }`, quel que soit le rôle ;
 *  - admin quelque part sans facteur : `{ enrolToken }`, il doit en poser un avant d'entrer ;
 *  - sinon : la suite de connexion.
 *
 * 🔴 Aucune session ni liste d'espaces avant le code : le jeton d'étape porte la suite prévue, signée. Aucun
 * interrupteur pour sauter cette étape, jamais : ce serait une porte en production (les tests passent par le
 * vrai parcours, `tests/mfa.ts`). `/auth/google` ne passe pas par ici : une connexion Google suffit.
 */
async function apresLeMotDePasse(
  deps: AuthRouteDeps,
  etape: EtapeConnexion,
  facteur: { actif: boolean; obligatoire: boolean },
): Promise<Record<string, unknown>> {
  if (facteur.actif) return { mfaToken: await signMfa(etape, deps.secret) };
  if (facteur.obligatoire) return { enrolToken: await signEnrolement(etape, deps.secret) };
  return suiteDeConnexion(deps, etape);
}

// Hash leurre (scrypt valide) : `verifyPassword` tourne toujours, même pour une adresse inconnue, pour
// qu'aucun écart de temps ne révèle l'existence d'un compte.
const DUMMY_HASH = hashPasswordSync(randomBytes(24).toString('hex')); // une seule fois au chargement -> sync OK
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/**
 * Longueur minimale d'un mot de passe choisi. Elle ne mord que sur les chemins qui en choisissent un
 * (inscription, invitation acceptée, réinitialisation, changement) : `/auth/login` compare un hash, un compte
 * existant plus court continue de se connecter. Aucune règle de composition : elles poussent à `Password1!`,
 * la longueur seule laisse passer les phrases de passe.
 */
const MIN_PASSWORD = 12;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * Clé de rate-limit : `req.ip::discriminant`. `req.ip` seul désigne le proxy (Fastify sans `trustProxy`
 * derrière Cloudflare puis NPM) : un limiteur sur lui serait transverse. Le discriminant (adresse
 * normalisée, jeton) garde un plafond par identité tentée.
 *
 * Le discriminant est borné : au-delà de 100 caractères, son empreinte le remplace (64 caractères,
 * discrimine tout aussi bien), sinon un jeton Google entier ferait un kilo-octet par clé dans une table qu'un
 * robot peut remplir. Posé ici, seul point par où passent toutes les clés.
 */
const MAX_DISCRIMINANT = 100;
function rateKey(req: { ip: string }, discriminant: string): string {
  const d = discriminant.length <= MAX_DISCRIMINANT
    ? discriminant
    : createHash('sha256').update(discriminant).digest('hex');
  return `${req.ip}::${d}`;
}

/**
 * Plafond de clés vivantes par limiteur : leurs clés viennent toutes de l'appelant (adresse, jeton), et sous
 * flot `prune()` ne retire rien dans la fenêtre. Dix mille est très large pour l'usage légitime ; au-delà,
 * une clé neuve est refusée et les clés connues restent servies.
 */
const MAX_CLES = 10_000;

export function registerAuth(app: FastifyInstance, deps: AuthRouteDeps, garde: Guard): void {
  // Le 3e argument est l'horloge, le 4e le plafond de clés. Les six limiteurs le portent : leurs six clés
  // sont choisies par l'appelant.
  const horloge = (): number => Date.now();
  const cfg = deps.loginRateLimit ?? { max: 10, windowMs: 60_000 };
  const limiter = new RateLimiter(cfg.max, cfg.windowMs, horloge, MAX_CLES);
  const signupLimiter = new RateLimiter(10, 60_000, horloge, MAX_CLES);
  const forgotLimiter = new RateLimiter(5, 60_000, horloge, MAX_CLES);
  const resetLimiter = new RateLimiter(10, 60_000, horloge, MAX_CLES);
  const acceptLimiter = new RateLimiter(10, 60_000, horloge, MAX_CLES);
  const googleLimiter = new RateLimiter(20, 60_000, horloge, MAX_CLES);

  app.post('/auth/login', async (req, reply) => {
    const b = (req.body ?? {}) as { email?: unknown; password?: unknown };
    if (typeof b.email !== 'string' || typeof b.password !== 'string' || b.email === '' || b.password === '') {
      return reply.code(400).send({ error: 'email et password requis' });
    }
    const email = b.email.trim().toLowerCase();
    // Rate-limit après le parse (la clé porte l'adresse) et avant le scrypt (protège le coût CPU du brute-force).
    if (!limiter.take(rateKey(req, email))) {
      return reply.code(429).send({ error: 'trop de tentatives, réessaie plus tard' });
    }

    const identite = await deps.users.findIdentity(email);
    // Toujours vérifier un hash (leurre si l'adresse est inconnue) : même temps CPU, pas de fuite d'existence.
    const ok = await verifyPassword(b.password, identite?.passwordHash ?? DUMMY_HASH);
    if (!identite || !ok) {
      /**
       * 🔴 On n'attend pas cette écriture : une adresse connue produit une ligne, une inconnue aucune, et attendre
       * ferait durer la réponse plus longtemps dans le premier cas, un écart mesurable qui révélerait le compte.
       * Le `.catch` évite qu'une promesse flottante rejetée tue le process.
       */
      const cible = identite?.comptes[0];
      if (cible && deps.auditConnexion) {
        void deps.auditConnexion(cible.tenantId, cible.id, 'mot_de_passe').catch(() => {});
      }
      return reply.code(401).send({ error: 'identifiants invalides' });
    }

    // Une adresse peut ouvrir plusieurs espaces : le mot de passe vaut pour l'adresse ; restent le second
    // facteur, puis le choix de l'espace.
    if (identite.comptes.length === 0) return reply.code(401).send({ error: 'identifiants invalides' });
    const etape: EtapeConnexion = {
      identityId: identite.identityId,
      email,
      comptes: identite.comptes.map((c) => ({ userId: c.id, tenantId: c.tenantId, role: c.role, tenantName: c.tenantName })),
    };
    // `comptes` ne porte que les comptes actifs (`findIdentity`) : un admin révoqué n'oblige plus à rien.
    return reply.code(200).send(await apresLeMotDePasse(deps, etape, {
      actif: identite.mfaActif,
      obligatoire: identite.comptes.some((c) => c.role === 'admin'),
    }));
  });

  /**
   * Deuxième temps d'une connexion à plusieurs espaces : le jeton de choix et l'espace retenu. 🔴 L'espace
   * demandé doit figurer dans la liste signée du jeton, sinon n'importe quel espace s'ouvrirait.
   */
  app.post('/auth/choose-workspace', async (req, reply) => {
    const b = (req.body ?? {}) as { choiceToken?: unknown; tenantId?: unknown };
    if (typeof b.choiceToken !== 'string' || typeof b.tenantId !== 'string' || b.choiceToken === '' || b.tenantId === '') {
      return reply.code(400).send({ error: 'choiceToken et tenantId requis' });
    }
    if (!limiter.take(rateKey(req, b.choiceToken))) {
      return reply.code(429).send({ error: 'trop de tentatives, réessaie plus tard' });
    }
    const choix = await verifyChoice(b.choiceToken, deps.secret);
    if (!choix) return reply.code(401).send({ error: 'choix expiré, reconnecte-toi' });
    const compte = choix.comptes.find((c) => c.tenantId === b.tenantId);
    if (!compte) return reply.code(403).send({ error: 'espace non autorisé pour cette adresse' });

    const token = await signSession({ userId: compte.userId, tenantId: compte.tenantId, role: compte.role }, deps.secret);
    markLogin(deps, compte.userId);
    return reply.code(200).send({ token, user: { email: choix.email, role: compte.role, tenantId: compte.tenantId } });
  });

  // Config publique : le front en a besoin pour afficher (ou non) le bouton Google.
  app.get('/auth/config', async (_req, reply) => {
    return reply.code(200).send({ googleClientId: deps.googleClientId ?? '', googleEnabled: !!deps.googleClientId });
  });

  // Se connecter avec Google : vérifie le jeton ID, connecte un compte existant ou crée un espace (inconnu).
  app.post('/auth/google', async (req, reply) => {
    if (!deps.verifyGoogle || !deps.getUserByEmail || !deps.createTenantWithAdmin) return reply.code(503).send({ error: 'connexion Google indisponible' });
    const idToken = str((req.body as { idToken?: unknown } | undefined)?.idToken);
    if (idToken === '') return reply.code(400).send({ error: 'idToken requis' });
    // Clé sur l'idToken Google : borne les tentatives par jeton, plus de blocage transverse.
    if (!googleLimiter.take(rateKey(req, idToken))) return reply.code(429).send({ error: 'trop de tentatives, réessaie plus tard' });
    const identity = await deps.verifyGoogle(idToken);
    if (!identity || !identity.emailVerified) return reply.code(401).send({ error: 'jeton Google invalide' });
    const comptes = await deps.getUserByEmail(identity.email);
    if (comptes.length > 0) {
      // Compte existant (actif ou invitation en attente) : Google fait foi (liaison par adresse vérifiée). Un
      // compte révoqué n'ouvre rien et n'apparaît pas dans le choix.
      const actifs = comptes.filter((c) => !c.disabled);
      const [existing, ...autres] = actifs;
      if (!existing) return reply.code(403).send({ error: 'compte révoqué' });
      if (autres.length > 0) {
        // Plusieurs espaces : on demande, comme `/auth/login` ; Google ne prouve que l'adresse, pas l'espace voulu.
        const choix = await signChoice(
          { email: identity.email, comptes: actifs.map((c) => ({ userId: c.id, tenantId: c.tenantId, role: c.role })) },
          deps.secret,
        );
        return reply.code(200).send({
          choiceToken: choix,
          workspaces: actifs.map((c) => ({ tenantId: c.tenantId, tenantName: c.tenantName, role: c.role })),
        });
      }
      const jwt = await signSession({ userId: existing.id, tenantId: existing.tenantId, role: existing.role }, deps.secret);
      // Après le contrôle `disabled` : un compte révoqué ne doit pas être crédité d'une connexion qui n'a pas eu
      // lieu.
      markLogin(deps, existing.id);
      return reply.code(200).send({ token: jwt, user: { email: identity.email, role: existing.role, tenantId: existing.tenantId }, isNew: false });
    }
    // Adresse inconnue : inscription libre via Google (espace et admin, sans mot de passe). Le nom construit
    // passe par la règle de l'inscription (`nomEspace`) : un nom Google refusé donne « Mon espace », jamais un
    // refus de connexion.
    const gname = (identity.name ?? '').slice(0, 60).trim();
    const construit = nomEspace.safeParse(gname !== '' ? `Espace de ${gname}` : '');
    const workspaceName = construit.success ? construit.data : 'Mon espace';
    const { tenantId, userId } = await deps.createTenantWithAdmin(workspaceName, { email: identity.email, name: identity.name, passwordHash: null });
    const jwt = await signSession({ userId, tenantId, role: 'admin' }, deps.secret);
    // Une inscription est une connexion : sinon le compte neuf s'afficherait « jamais connecté » sur la page
    // Équipe.
    markLogin(deps, userId);
    // isNew:true : le front envoie vers /accueil (onboarding « connecter ton numéro »).
    return reply.code(201).send({ token: jwt, user: { email: identity.email, role: 'admin', tenantId }, isNew: true });
  });

  // Inscription libre : crée un nouvel espace et son admin, puis passe par le second facteur avant la session.
  app.post('/auth/signup', async (req, reply) => {
    // Sans magasin du second facteur, l'inscription ne pourrait pas enrôler l'admin qu'elle crée : refus avant
    // de créer quoi que ce soit.
    if (!deps.createTenantWithAdmin || !deps.mfa || !deps.motDePasseDeLAdresse) return reply.code(503).send({ error: 'inscription indisponible' });
    const b = (req.body ?? {}) as { workspaceName?: unknown; email?: unknown; password?: unknown; name?: unknown };
    const email = str(b.email).trim().toLowerCase();
    const password = str(b.password);
    const name = str(b.name).trim() || null;
    if (str(b.workspaceName).trim() === '') return reply.code(400).send({ error: 'nom de l\'espace requis' });
    // La même règle que le renommage (`src/user/nom-espace.ts`) : un nom de 500 Ko ou un saut de ligne
    // s'afficheraient tels quels dans l'écran de choix.
    const nomLu = nomEspace.safeParse(str(b.workspaceName));
    if (!nomLu.success) return reply.code(400).send({ error: MESSAGE_NOM_ESPACE_INVALIDE });
    const workspaceName = nomLu.data;
    if (!EMAIL_RE.test(email)) return reply.code(400).send({ error: 'email invalide' });
    if (!signupLimiter.take(rateKey(req, email))) return reply.code(429).send({ error: 'trop de tentatives, réessaie plus tard' });
    if (password.length < MIN_PASSWORD) return reply.code(400).send({ error: `mot de passe trop court (min ${MIN_PASSWORD})` });
    // 🔴 Une adresse déjà connue ne s'inscrit qu'avec son mot de passe : l'inscription réutilise son identité, et
    // sans cette vérification n'importe qui se rattacherait à l'identité d'un autre, puis changerait le mot de
    // passe de tous ses espaces. Une identité sans mot de passe (invitation en attente, Google) ne s'étend pas
    // par ici.
    const existant = await deps.motDePasseDeLAdresse(email);
    if (existant !== undefined && (existant === null || !(await verifyPassword(password, existant)))) {
      return reply.code(409).send({ error: 'un compte existe déjà avec cet email' });
    }
    try {
      const { tenantId, userId } = await deps.createTenantWithAdmin(workspaceName, { email, name, passwordHash: await hashPassword(password) });
      // L'inscription crée un admin : elle rend un jeton d'enrôlement, jamais une session ; une identité qui a
      // déjà un facteur actif donne son code.
      const facteur = await deps.mfa.lireParCompte(userId);
      if (!facteur) throw new Error('inscription : le compte créé n’a pas d’identité');
      const etape: EtapeConnexion = { identityId: facteur.identityId, email, comptes: [{ userId, tenantId, role: 'admin', tenantName: workspaceName }] };
      return reply.code(201).send(await apresLeMotDePasse(deps, etape, { actif: facteur.secret !== null, obligatoire: true }));
    } catch (err) {
      if (err instanceof DuplicateEmailError) return reply.code(409).send({ error: 'un compte existe déjà avec cet email' });
      throw err;
    }
  });

  // Mot de passe perdu : toujours 200 (anti-énumération), un lien si le compte existe.
  app.post('/auth/forgot-password', async (req, reply) => {
    const email = str((req.body as { email?: unknown } | undefined)?.email).trim().toLowerCase();
    // Clé sur l'adresse. Le `take()` précède toute lecture : le seuil du 429 ne révèle pas l'existence du compte.
    if (!forgotLimiter.take(rateKey(req, email))) return reply.code(429).send({ error: 'trop de tentatives, réessaie plus tard' });
    const generic = { ok: true, message: 'Si un compte existe pour cet email, un lien de réinitialisation a été envoyé.' };
    if (EMAIL_RE.test(email) && deps.tokens && deps.sendEmail && deps.appUrl) {
      try {
        // Le jeton vise un compte de l'adresse, mais `setPassword` écrit sur l'identité : le nouveau mot de passe
        // vaut pour tous ses espaces, l'utilisateur n'en ayant qu'un.
        const identite = await deps.users.findIdentity(email); // null si inconnue / sans mdp (Google-only)
        const user = identite?.comptes[0] ?? null;
        if (user) {
          const raw = await deps.tokens.create('reset', user.id, deps.resetTtlMs ?? 60 * 60 * 1000);
          // Envoi en fire-and-forget : la réponse ne dépend pas de la latence de Resend, qui trahirait une adresse
          // connue.
          void deps.sendEmail({
            to: email,
            subject: 'Réinitialiser ton mot de passe',
            text: `Tu as demandé à réinitialiser ton mot de passe.\n\nClique sur ce lien (valide 1 h) :\n${deps.appUrl}/reset/${raw}\n\nSi tu n'es pas à l'origine de cette demande, ignore ce message.`,
          }).catch(() => {});
        }
      } catch {
        // On ne révèle jamais une erreur ici (anti-énumération).
      }
    }
    return reply.code(200).send(generic);
  });

  // Réinitialisation : consomme le token (usage unique) et pose le nouveau mot de passe.
  app.post('/auth/reset-password', async (req, reply) => {
    if (!deps.tokens || !deps.setPassword) return reply.code(503).send({ error: 'réinitialisation indisponible' });
    const b = (req.body ?? {}) as { token?: unknown; password?: unknown };
    const token = str(b.token);
    const password = str(b.password);
    if (token === '') return reply.code(400).send({ error: 'token requis' });
    // Clé sur le jeton (pas d'adresse ici) : borne le brute-force d'un lien sans bloquer les autres.
    if (!resetLimiter.take(rateKey(req, token))) return reply.code(429).send({ error: 'trop de tentatives, réessaie plus tard' });
    if (password.length < MIN_PASSWORD) return reply.code(400).send({ error: `mot de passe trop court (min ${MIN_PASSWORD})` });
    const userId = await deps.tokens.consume('reset', token);
    if (!userId) return reply.code(400).send({ error: 'lien invalide ou expiré' });
    await deps.setPassword(userId, await hashPassword(password));
    return reply.code(200).send({ ok: true });
  });

  // Acceptation d'invitation : consomme le token (usage unique), pose le mot de passe, puis la même porte que la
  // connexion (second facteur si dû, session sinon).
  app.post('/auth/invitations/accept', async (req, reply) => {
    if (!deps.tokens || !deps.setPassword || !deps.sessionUser || !deps.mfa) return reply.code(503).send({ error: 'invitations indisponibles' });
    const b = (req.body ?? {}) as { token?: unknown; password?: unknown };
    const token = str(b.token);
    const password = str(b.password);
    if (token === '') return reply.code(400).send({ error: 'token requis' });
    // Clé sur le jeton d'invitation : borne le brute-force d'un lien sans bloquer les autres.
    if (!acceptLimiter.take(rateKey(req, token))) return reply.code(429).send({ error: 'trop de tentatives, réessaie plus tard' });
    if (password.length < MIN_PASSWORD) return reply.code(400).send({ error: `mot de passe trop court (min ${MIN_PASSWORD})` });
    const userId = await deps.tokens.consume('invite', token);
    if (!userId) return reply.code(400).send({ error: 'invitation invalide ou expirée' });
    const su = await deps.sessionUser(userId);
    if (!su) return reply.code(400).send({ error: 'invitation invalide ou expirée' });
    const facteur = await deps.mfa.lireParCompte(userId);
    if (!facteur) return reply.code(400).send({ error: 'invitation invalide ou expirée' });
    await deps.setPassword(userId, await hashPassword(password));
    // Accepter une invitation, c'est se connecter pour la première fois : même porte que la connexion. Une
    // invitation d'admin (ou une identité déjà admin ailleurs) enrôle d'abord ; une identité qui a déjà un
    // facteur donne son code.
    const etape: EtapeConnexion = {
      identityId: facteur.identityId,
      email: su.email,
      comptes: [{ userId, tenantId: su.tenantId, role: su.role, tenantName: '' }],
    };
    return reply.code(200).send(await apresLeMotDePasse(deps, etape, {
      actif: facteur.secret !== null,
      obligatoire: facteur.obligatoire || su.role === 'admin',
    }));
  });

  // Changement de mot de passe (compte connecté) : vérifie le mdp courant.
  app.post('/auth/change-password', { preHandler: garde }, async (req, reply) => {
    if (!deps.getPasswordHash || !deps.setPassword) return reply.code(503).send({ error: 'indisponible' });
    const userId = req.auth?.userId;
    if (!userId) return reply.code(401).send({ error: 'authentification requise' });
    const b = (req.body ?? {}) as { currentPassword?: unknown; newPassword?: unknown };
    const current = str(b.currentPassword);
    const next = str(b.newPassword);
    if (next.length < MIN_PASSWORD) return reply.code(400).send({ error: `mot de passe trop court (min ${MIN_PASSWORD})` });
    const hash = await deps.getPasswordHash(userId);
    const ok = await verifyPassword(current, hash ?? DUMMY_HASH);
    if (!hash || !ok) return reply.code(401).send({ error: 'mot de passe actuel incorrect' });
    await deps.setPassword(userId, await hashPassword(next));
    return reply.code(200).send({ ok: true });
  });

  // Le second facteur : routes d'étape (avant session) et de la page Compte. La suite leur est passée, pas
  // recopiée : la même fonction que pour `/auth/login`.
  registerMfa(app, deps, garde, (etape) => suiteDeConnexion(deps, etape));
}
