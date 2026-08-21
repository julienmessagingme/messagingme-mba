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
