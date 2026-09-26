import { SignJWT, jwtVerify } from 'jose';

export interface Session {
  userId: string;
  tenantId: string;
  role: string;
  /**
   * Session d'EMPRUNT, émise depuis la surface d'exploitation pour entrer dans l'espace d'un client.
   *
   * Trois conséquences, toutes voulues :
   *   - AUCUNE écriture n'est permise (garde globale) ;
   *   - le porteur n'a pas de compte dans cet espace, donc son état n'est pas relu en base ;
   *   - rien n'est marqué comme lu, pour ne pas faire disparaître les non-lus du client.
   *
   * Absent = session normale. Le champ n'existe QUE sur un jeton émis par `/ops`, qui est lui-même protégé
   * par un jeton d'exploitation distinct du JWT client.
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
    // 🔴 UN JETON QUI PORTE UN `kind` N'EST JAMAIS UNE SESSION (choix d'espace, second facteur, enrôlement). Aucun
    // d'eux ne porte `tenantId` ni `role` à la racine, donc le test ci-dessus les refuse déjà ; celui-ci tient le
    // jour où quelqu'un les y ajouterait pour « simplifier » la suite de la connexion.
    if (payload.kind !== undefined) return null;
    return {
      userId: payload.sub,
      tenantId: payload.tenantId,
      role: payload.role,
      // `=== true` strict : n'importe quelle autre valeur (chaîne, 1, objet) vaut « session normale ».
      // Un emprunt ne doit jamais être déduit d'une valeur approximative.
      ...(payload.impersonated === true ? { impersonated: true as const } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Jeton de CHOIX D'ESPACE : le temps intermédiaire d'une connexion quand une adresse donne accès à
 * plusieurs espaces.
 *
 * 🔴 Ce n'est PAS une session, et il ne doit jamais pouvoir en tenir lieu :
 *   - il ne porte ni `tenantId` ni `role` à la racine, donc `verifySession` le REJETTE (elle exige les deux) ;
 *   - il porte la liste des espaces autorisés, SIGNÉE : sans elle, présenter un jeton de choix légitime avec
 *     l'identifiant d'un espace quelconque suffirait à y entrer ;
 *   - il vit 5 minutes. C'est le temps de cliquer, pas celui de travailler.
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
    // `kind` vérifié explicitement : un jeton de SESSION valide ne doit pas pouvoir servir de jeton de choix,
    // ni l'inverse. Deux usages, deux formes, aucun recouvrement.
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
 * Les deux ÉTAPES d'une connexion qui attend encore le second facteur (plan du 2026-09-25) : `mfa` (l'identité a
 * un facteur actif, il faut son code) et `enrolement` (l'identité est admin quelque part et n'a pas de facteur,
 * elle doit en poser un avant d'entrer).
 *
 * 🔴 CE NE SONT PAS DES SESSIONS, sur le modèle exact du jeton de choix : ni `tenantId` ni `role` à la racine, et
 * un `kind` que `verifySession` refuse. Ils portent la liste SIGNÉE des comptes, c'est-à-dire la suite prévue de la
 * connexion : une session si un seul espace, un jeton de choix sinon. Rien ne s'ouvre avant le code.
 *
 * ⚠️ Un `kind` par étape, et chaque vérification refuse l'autre : un jeton d'enrôlement présenté au lieu d'un jeton
 * de code permettrait de REMPLACER un facteur actif par un facteur neuf, c'est-à-dire de le contourner.
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
