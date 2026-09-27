import { createHmac, randomBytes } from 'node:crypto';

/**
 * Émission du jeton d'install HubSpot signé, consommé par `/oauth/install?t=` côté mm-hubspot.
 *
 * 🔴 Le format doit rester identique au vérificateur de mm-hubspot (`src/oauth/install-token.ts`) :
 * `<ts>.<nonce>.<tenant>.<grant>.<hmac>`, HMAC-SHA256 hex sur `<ts>.<nonce>.<tenant>.<grant>`, secret partagé
 * (HUBSPOT_SERVICE_SECRET). Seul mba peut ainsi émettre un lien d'install pour un espace, depuis une route admin.
 */
const TENANT_RE = /^[0-9a-zA-Z_-]{1,64}$/;
const GRANT_RE = /^[0-9a-zA-Z_-]{0,32}$/;

export function issueInstallToken(secret: string, nowMs: number, tenant: string, grant?: string): string {
  const g = grant ?? '';
  if (!TENANT_RE.test(tenant)) throw new Error('tenant invalide');
  if (!GRANT_RE.test(g)) throw new Error('grant invalide');
  const payload = `${nowMs}.${randomBytes(8).toString('hex')}.${tenant}.${g}`;
  const sig = createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

/**
 * L'URL complète d'install ou de re-consentement à ouvrir dans le navigateur. `publicBaseUrl` = origine publique du
 * connecteur. null si le secret ou l'URL publique manquent (fonction non configurée).
 */
export function buildInstallUrl(
  publicBaseUrl: string,
  secret: string,
  nowMs: number,
  tenant: string,
  grant?: string,
): string | null {
  if (!publicBaseUrl || !secret) return null;
  const base = publicBaseUrl.replace(/\/+$/, '');
  const token = issueInstallToken(secret, nowMs, tenant, grant);
  return `${base}/oauth/install?t=${encodeURIComponent(token)}`;
}
