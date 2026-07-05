import { SignJWT, jwtVerify } from 'jose';

export interface Session {
  userId: string;
  tenantId: string;
  role: string;
}

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

/** Signe un JWT de session HS256 (sub = userId, claims tenantId + role). */
export async function signSession(s: Session, secret: string, expiresIn = '12h'): Promise<string> {
  return new SignJWT({ tenantId: s.tenantId, role: s.role })
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
    return { userId: payload.sub, tenantId: payload.tenantId, role: payload.role };
  } catch {
    return null;
  }
}
