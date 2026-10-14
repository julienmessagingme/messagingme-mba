import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * LA CSP DE LA CONSOLE ENVOIE SES RAPPORTS AU COLLECTEUR DE L'API (`web/next.config.mjs`, lot 6 B3). Sans la variable
 * `NEXT_PUBLIC_API_URL` (la console du VPS), l'adresse est le chemin que nginx route vers l'API, préfixe retiré ; sur
 * Vercel, `scripts/verifier-base-api.mjs` vérifie la valeur de production au caractère près. Le test lit la politique
 * RÉELLEMENT servie (la fonction `headers()` de la configuration), pas le texte du fichier.
 */
async function politique(): Promise<string> {
  const mod = (await import(pathToFileURL(join(process.cwd(), 'web', 'next.config.mjs')).href)) as {
    default: { headers: () => Promise<Array<{ headers: Array<{ key: string; value: string }> }>> };
  };
  const regles = await mod.default.headers();
  return regles.flatMap((r) => r.headers).find((h) => h.key === 'Content-Security-Policy-Report-Only')?.value ?? '';
}

describe('les rapports de la CSP de la console', () => {
  it('🔴 sans adresse d’API absolue, ils partent vers `/api/backend/csp-rapports`, routé vers l’API', async () => {
    expect(process.env.NEXT_PUBLIC_API_URL ?? '').toBe('');
    const directives = (await politique()).split(';').map((d) => d.trim());
    expect(directives).toContain('report-uri /api/backend/csp-rapports');
  });
});
