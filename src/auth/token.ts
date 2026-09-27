import { SignJWT, jwtVerify } from 'jose';

export interface Session {
  userId: string;
  tenantId: string;
  role: string;
  /**
   * 🔴 Session d'emprunt, émise depuis `/ops` pour entrer dans l'espace d'un client : aucune écriture permise
   * (garde globale), état du porteur non relu en base (il n'a pas de compte ici), rien marqué comme lu.
   * Absent = session normale ; le champ n'existe que sur un jeton émis par `/ops`, protégé par son propre jeton.
   */
  impersonated?: true;
}

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

/** Signe un JWT de session HS256 (sub = userId, claims tenantId + role). */
export async function signSession(s: Session, secret: string, expiresIn = '12h'): Promise<string> {
  return new SignJWT({ tenantId: s.tenantId, role: s.role, ...(s.impersonated ? { impersonated: true } : {}) })
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
    // 🔴 Un jeton qui porte un `kind` n'est jamais une session (choix d'espace, second facteur, enrôlement) :
    // ils n'ont ni `tenantId` ni `role` à la racine, et ce test tient le jour où quelqu'un les y ajouterait.
    if (payload.kind !== undefined) return null;
    return {
      userId: payload.sub,
      tenantId: payload.tenantId,
      role: payload.role,
      // `=== true` strict : un emprunt ne se déduit jamais d'une valeur approximative.
      ...(payload.impersonated === true ? { impersonated: true as const } : {}),
    };
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
  comptes: Array<{ userId: string; tenantId: string; role: string; tenantName: string }>;
}

type KindEtape = 'mfa' | 'enrolement';

async function signEtape(kind: KindEtape, e: EtapeConnexion, secret: string, expiresIn: string): Promise<string> {
  return new SignJWT({ kind, identityId: e.identityId, email: e.email, comptes: e.comptes })
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
        && typeof (c as { role?: unknown }).role === 'string'
        && typeof (c as { tenantName?: unknown }).tenantName === 'string',
    );
    if (comptes.length === 0) return null;
    return { identityId: payload.identityId, email: payload.email, comptes };
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
