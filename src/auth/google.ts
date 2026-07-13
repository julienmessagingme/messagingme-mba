import { createRemoteJWKSet, jwtVerify } from 'jose';

/** Identité extraite d'un jeton ID Google vérifié. */
export interface GoogleIdentity {
  email: string;
  name: string | null;
  emailVerified: boolean;
  sub: string;
}

// Clés publiques Google (JWKS) : jose les récupère + met en cache tout seul. Pas de dépendance en plus.
const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

/**
 * Vérifie un jeton ID Google (flux « Sign in with Google » côté front) : signature via le JWKS Google,
 * `issuer` = accounts.google.com, `audience` = NOTRE client_id. Renvoie l'identité, ou null si invalide/expiré
 * (jamais de throw : donnée non fiable). L'appelant doit exiger `emailVerified`.
 */
export async function verifyGoogleIdToken(idToken: string, clientId: string): Promise<GoogleIdentity | null> {
  if (!idToken || !clientId) return null;
  try {
    const { payload } = await jwtVerify(idToken, GOOGLE_JWKS, {
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: clientId,
    });
    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    if (email === '') return null;
    return {
      email,
      name: typeof payload.name === 'string' && payload.name.trim() !== '' ? payload.name.trim() : null,
      emailVerified: payload.email_verified === true,
      sub: typeof payload.sub === 'string' ? payload.sub : '',
    };
  } catch {
    return null;
  }
}
