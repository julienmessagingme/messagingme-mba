import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';

export interface Session {
  userId: string;
  tenantId: string;
  role: string;
  /**
   * 🔴 Session d'emprunt, émise depuis `/ops` pour entrer dans l'espace d'un client : aucune écriture permise
   * (garde globale), état du porteur non relu en base (il n'a pas de compte ici), rien marqué comme lu.
   * Absent = session normale ; le champ n'existe que sur un jeton émis par `/ops`, sous une session d'exploitation.
   */
  impersonated?: true;
  /** L'adresse de l'exploitant qui observe. N'existe que sur une session d'emprunt : c'est elle qui dit qui regardait. */
  observateur?: string;
  /**
   * Posé par la seule garde `adminOuLien` quand l'autorité vient du lien de connexion du numéro (lot 3c), jamais par
   * un jeton : une trace d'audit dit ainsi que l'écriture vient du lien que Claude Code a donné.
   */
  viaLien?: true;
}

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

/**
 * Signe un JWT de session HS256 (sub = userId, claims tenantId + role).
 * `expiresIn` : une durée (`'12h'`), ou un INSTANT absolu en secondes depuis l'epoch, celui d'une session qu'on
 * remplace (le changement d'espace, `src/http/espaces.ts`) : la remplaçante ne vit pas plus longtemps que sa preuve.
 */
export async function signSession(s: Session, secret: string, expiresIn: string | number = '12h'): Promise<string> {
  const emprunt = s.impersonated ? { impersonated: true, ...(s.observateur ? { observateur: s.observateur } : {}) } : {};
  return new SignJWT({ tenantId: s.tenantId, role: s.role, ...emprunt })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(s.userId)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(key(secret));
}

/** Vérifie un JWT de session. Retourne la session ou null (invalide/expiré/malformé). */
export async function verifySession(token: string, secret: string): Promise<Session | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret), { algorithms: ['HS256'] });
    if (typeof payload.sub !== 'string' || typeof payload.tenantId !== 'string' || typeof payload.role !== 'string') {
      return null;
    }
    // 🔴 Un jeton qui porte un `kind` n'est jamais une session (choix d'espace, second facteur, enrôlement, exploitation) :
    // ils n'ont ni `tenantId` ni `role` à la racine, et ce test tient le jour où quelqu'un les y ajouterait.
    if (payload.kind !== undefined) return null;
    // `=== true` strict : un emprunt ne se déduit jamais d'une valeur approximative.
    const emprunt = payload.impersonated === true
      ? { impersonated: true as const, ...(typeof payload.observateur === 'string' ? { observateur: payload.observateur } : {}) }
      : {};
    return { userId: payload.sub, tenantId: payload.tenantId, role: payload.role, ...emprunt };
  } catch {
    return null;
  }
}

/**
 * L'échéance d'un jeton de session (`exp`, en secondes depuis l'epoch), signature vérifiée. `null` si le jeton est
 * invalide, expiré, ou porte un `kind` (ce n'est pas une session). Sert au changement d'espace, dont la session neuve
 * garde cette échéance.
 */
export async function echeanceSession(token: string, secret: string): Promise<number | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret), { algorithms: ['HS256'] });
    return payload.kind === undefined && typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

/**
 * Jeton de choix d'espace : le temps intermédiaire d'une connexion quand une adresse ouvre plusieurs espaces.
 * Ce n'est pas une session : sans `tenantId` ni `role` à la racine, `verifySession` le rejette. 🔴 Il porte
 * la liste signée des espaces autorisés, sans laquelle un jeton légitime ouvrirait n'importe quel espace. Il
 * vit 5 minutes.
 */
export interface ChoiceToken {
  email: string;
  comptes: Array<{ userId: string; tenantId: string; role: string }>;
}

export async function signChoice(c: ChoiceToken, secret: string, expiresIn = '5m'): Promise<string> {
  return new SignJWT({ kind: 'choice', email: c.email, comptes: c.comptes })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(key(secret));
}

/** Vérifie un jeton de choix. `null` si invalide, expiré, ou si ce n'est pas un jeton de choix. */
export async function verifyChoice(token: string, secret: string): Promise<ChoiceToken | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret), { algorithms: ['HS256'] });
    // `kind` vérifié : un jeton de session ne sert pas de jeton de choix, ni l'inverse.
    if (payload.kind !== 'choice' || typeof payload.email !== 'string' || !Array.isArray(payload.comptes)) return null;
    const comptes = payload.comptes.filter(
      (c): c is { userId: string; tenantId: string; role: string } =>
        !!c && typeof c === 'object'
        && typeof (c as { userId?: unknown }).userId === 'string'
        && typeof (c as { tenantId?: unknown }).tenantId === 'string'
        && typeof (c as { role?: unknown }).role === 'string',
    );
    if (comptes.length === 0) return null;
    return { email: payload.email, comptes };
  } catch {
    return null;
  }
}

/**
 * Les deux étapes d'une connexion qui attend le second facteur : `mfa` (un facteur actif, il faut son code)
 * et `enrolement` (admin sans facteur, qui doit en poser un avant d'entrer). Pas des sessions, comme le jeton
 * de choix : ils portent la liste signée des comptes, la suite prévue de la connexion, et rien ne s'ouvre
 * avant le code. 🔴 Un `kind` par étape, chaque vérification refusant l'autre : un jeton d'enrôlement présenté
 * à la place d'un jeton de code permettrait de remplacer un facteur actif, donc de le contourner.
 */
export interface EtapeConnexion {
  identityId: string;
  email: string;
  /**
   * Les comptes que le mot de passe ouvre. Pas les noms d'espaces : le jeton se lit en base64, et le seul mot de
   * passe ne doit pas révéler chez qui il ouvre avant le second facteur. Les noms se relisent après le code.
   */
  comptes: Array<{ userId: string; tenantId: string; role: string }>;
  /**
   * Une connexion à l'exploitation : au bout du second facteur, une session d'exploitation et jamais une session
   * d'espace. Signé avec le reste : un jeton d'étape ordinaire ne devient pas une entrée dans `/ops`, ni l'inverse.
   */
  ops?: true;
}

type KindEtape = 'mfa' | 'enrolement';

async function signEtape(kind: KindEtape, e: EtapeConnexion, secret: string, expiresIn: string): Promise<string> {
  return new SignJWT({ kind, identityId: e.identityId, email: e.email, comptes: e.comptes, ...(e.ops ? { ops: true } : {}) })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(key(secret));
}

async function verifyEtape(kind: KindEtape, token: string, secret: string): Promise<EtapeConnexion | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret), { algorithms: ['HS256'] });
    if (payload.kind !== kind || typeof payload.identityId !== 'string' || typeof payload.email !== 'string' || !Array.isArray(payload.comptes)) {
      return null;
    }
    const comptes = payload.comptes.filter(
      (c): c is EtapeConnexion['comptes'][number] =>
        !!c && typeof c === 'object'
        && typeof (c as { userId?: unknown }).userId === 'string'
        && typeof (c as { tenantId?: unknown }).tenantId === 'string'
        && typeof (c as { role?: unknown }).role === 'string',
    ).map((c) => ({ userId: c.userId, tenantId: c.tenantId, role: c.role }));
    if (comptes.length === 0) return null;
    return { identityId: payload.identityId, email: payload.email, comptes, ...(payload.ops === true ? { ops: true as const } : {}) };
  } catch {
    return null;
  }
}

/** Le jeton de l'étape « code » : 5 minutes, le temps d'ouvrir l'application. */
export function signMfa(e: EtapeConnexion, secret: string): Promise<string> {
  return signEtape('mfa', e, secret, '5m');
}
export function verifyMfa(token: string, secret: string): Promise<EtapeConnexion | null> {
  return verifyEtape('mfa', token, secret);
}

/** Le jeton de l'étape « enrôlement » : 10 minutes, le temps d'installer une application et de scanner. */
export function signEnrolement(e: EtapeConnexion, secret: string): Promise<string> {
  return signEtape('enrolement', e, secret, '10m');
}
export function verifyEnrolement(token: string, secret: string): Promise<EtapeConnexion | null> {
  return verifyEtape('enrolement', token, secret);
}

/** Le moyen qui a prouvé le second facteur : le code de l'application, ou un code de secours. */
export type MoyenFacteur = 'totp' | 'secours';

/**
 * La session d'exploitation : l'autorité de `/ops`, nominative. Elle porte l'identité (et son adresse), et le
 * moyen qui a prouvé le second facteur.
 * 🔴 Portée distincte des sessions d'espace, dans les deux sens : son `kind` fait que `verifySession` la refuse
 * (aucune route d'espace ne s'ouvre avec), et `verifySessionOps` refuse tout jeton qui n'a pas ce `kind` (une
 * session d'espace, même d'admin, n'ouvre pas `/ops`). Elle ne se signe qu'au bout d'un second facteur vérifié
 * (`suiteDeConnexion`, `src/auth/routes.ts`), et la garde de `/ops` relit la liste et le facteur à chaque requête.
 */
export interface SessionOps {
  identityId: string;
  email: string;
  facteur: MoyenFacteur;
}

/** 12 heures, comme une session d'admin (décision du plan `2026-09-28-ops-nominatif.md`). */
export async function signSessionOps(s: SessionOps, secret: string): Promise<string> {
  return new SignJWT({ kind: 'ops', email: s.email, facteur: s.facteur })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(s.identityId)
    .setIssuedAt()
    .setExpirationTime('12h')
    .sign(key(secret));
}

export async function verifySessionOps(token: string, secret: string): Promise<SessionOps | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret), { algorithms: ['HS256'] });
    if (payload.kind !== 'ops' || typeof payload.sub !== 'string' || typeof payload.email !== 'string') return null;
    // Sans la preuve du facteur, ce n'est pas une session d'exploitation.
    if (payload.facteur !== 'totp' && payload.facteur !== 'secours') return null;
    return { identityId: payload.sub, email: payload.email, facteur: payload.facteur };
  } catch {
    return null;
  }
}

/**
 * LES DEUX JETONS SIGNÉS DE L'OAUTH (migration 0204). Pas des sessions : leur `kind` fait que `verifySession` les
 * refuse, et chaque vérification refuse le `kind` de l'autre. Le contenu relu passe par Zod (`safeParse`) : la
 * signature prouve d'où il vient, pas qu'il a la forme attendue.
 */
async function signerKind(kind: string, corps: Record<string, unknown>, secret: string, expiresIn: string): Promise<string> {
  return new SignJWT({ kind, ...corps })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(key(secret));
}

async function verifierKind<T>(kind: string, schema: z.ZodType<T>, token: string, secret: string): Promise<T | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret), { algorithms: ['HS256'] });
    if (payload.kind !== kind) return null;
    const lu = schema.safeParse(payload);
    return lu.success ? lu.data : null;
  } catch {
    return null;
  }
}

/**
 * La demande d'autorisation vérifiée par `/oauth/authorize`, portée jusqu'à la page de consentement de la console
 * dans son adresse : aucune table de demandes en attente. 10 minutes, le temps de se connecter et de choisir.
 */
const demandeOauth = z.object({
  clientId: z.string(),
  redirectUri: z.string(),
  codeChallenge: z.string(),
  scopes: z.array(z.string()).min(1),
  state: z.string(),
  resource: z.string(),
});
export type DemandeOauth = z.infer<typeof demandeOauth>;

export function signDemandeOauth(d: DemandeOauth, secret: string): Promise<string> {
  return signerKind('oauth_demande', {
    clientId: d.clientId, redirectUri: d.redirectUri, codeChallenge: d.codeChallenge, scopes: d.scopes, state: d.state,
    resource: d.resource,
  }, secret, '10m');
}
export function verifyDemandeOauth(token: string, secret: string): Promise<DemandeOauth | null> {
  return verifierKind('oauth_demande', demandeOauth, token, secret);
}

/**
 * La preuve qu'une personne s'est authentifiée par Google sur la page de consentement : son adresse vérifiée, et
 * l'empreinte du jeton de demande auquel elle répond (`demande`), pour qu'elle ne serve pas à une autre demande.
 * 🔴 Ni rôle ni espace : le rôle se relit en base au moment d'émettre le code. 5 minutes, comme le choix d'espace.
 */
const choixOauth = z.object({
  email: z.string().min(1),
  demande: z.string().min(1),
});
export type ChoixOauth = z.infer<typeof choixOauth>;

export function signChoixOauth(c: ChoixOauth, secret: string): Promise<string> {
  return signerKind('oauth_choix', { email: c.email, demande: c.demande }, secret, '5m');
}
export function verifyChoixOauth(token: string, secret: string): Promise<ChoixOauth | null> {
  return verifierKind('oauth_choix', choixOauth, token, secret);
}

/**
 * LE LIEN DE CONNEXION DU NUMÉRO (lot 3c, livraison A). Claude Code le donne au client : il ouvre la page
 * « Connecter WhatsApp » d'UN espace sans passer par la console. 🔴 Ce n'est pas une session : son `kind` fait que
 * `verifySession` le refuse, donc aucune route d'espace ne s'ouvre avec lui. Seule la garde `adminOuLien`
 * (`src/auth/middleware.ts`) le lit, sur les seules routes de la page, et relit l'utilisateur en base à chaque appel.
 * Une heure, rouvrable : le temps de payer, de faire la fenêtre de Meta et d'attendre l'appel (décision de Julien).
 */
export const DUREE_LIEN_NUMERO_MS = 3_600_000;
const lienNumero = z.object({
  tenantId: z.string().min(1),
  userId: z.string().min(1),
  mode: z.enum(['fourni', 'apporte']),
});
export type LienNumero = z.infer<typeof lienNumero>;

export function signLienNumero(l: LienNumero, secret: string): Promise<string> {
  return signerKind('lien_numero', { tenantId: l.tenantId, userId: l.userId, mode: l.mode }, secret, `${DUREE_LIEN_NUMERO_MS / 1000}s`);
}
export function verifyLienNumero(token: string, secret: string): Promise<LienNumero | null> {
  return verifierKind('lien_numero', lienNumero, token, secret);
}
