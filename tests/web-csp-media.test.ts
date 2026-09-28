import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * LA CSP DE LA CONSOLE AUTORISE L'APERÇU D'UNE VIDÉO CHOISIE (`web/next.config.mjs`).
 *
 * 🔴 Le formulaire des publicités montre la vidéo choisie par une adresse locale `blob:`. Sans `media-src`, la
 * directive retombe sur `default-src 'self'`, qui ne couvre pas `blob:` : la politique en Report-Only le signale à
 * chaque vidéo, et le jour où elle bloquera, l'aperçu disparaîtra sans erreur visible. Le test lit la politique
 * RÉELLEMENT servie (la fonction `headers()` de la configuration), pas le texte du fichier.
 */
async function politique(): Promise<Map<string, string[]>> {
  const mod = (await import(pathToFileURL(join(process.cwd(), 'web', 'next.config.mjs')).href)) as {
    default: { headers: () => Promise<Array<{ headers: Array<{ key: string; value: string }> }>> };
  };
  const regles = await mod.default.headers();
  const csp = regles.flatMap((r) => r.headers).find((h) => h.key === 'Content-Security-Policy-Report-Only')?.value ?? '';
  return new Map(csp.split(';').map((d) => d.trim().split(/\s+/)).filter((m) => m[0]).map(([nom, ...v]) => [nom ?? '', v]));
}

describe('la CSP de la console', () => {
  it('🔴 `media-src` autorise `blob:` (l’aperçu de la vidéo choisie) et la même origine, rien d’autre', async () => {
    const p = await politique();
    expect(p.get('media-src')).toEqual(["'self'", 'blob:']);
  });

  it('garde de la garde : la politique est bien lue (sans quoi l’absence de `media-src` passerait inaperçue)', async () => {
    const p = await politique();
    expect(p.get('default-src')).toEqual(["'self'"]);
    expect(p.get('img-src')).toContain('blob:');
  });
});
