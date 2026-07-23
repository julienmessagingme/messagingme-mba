import { createHmac, randomBytes } from 'node:crypto';

/**
 * Émission du jeton d'install HubSpot signé, consommé par `/oauth/install?t=` côté mm-hubspot.
 *
 * ⚠️ Le format DOIT rester identique au vérificateur mm-hubspot (`src/oauth/install-token.ts` de mm-hubspot) :
 * `<ts>.<nonce>.<tenant>.<grant>.<hmac>`, HMAC-SHA256 hex sur `<ts>.<nonce>.<tenant>.<grant>`, secret = SERVICE_SECRET
 * partagé (HUBSPOT_SERVICE_SECRET côté mba). C'est ce qui remplace le `?tenant=` en clair : seul mba, qui détient le
 * secret, peut émettre un lien d'install pour un tenant donné, et il ne le fait que sur une route authentifiée admin.
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
 * Construit l'URL complète d'install/re-consentement à ouvrir dans le navigateur. `publicBaseUrl` = origine publique du
 * connecteur (sans slash final requis). Renvoie null si le secret ou l'URL publique manquent (feature non configurée).
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
