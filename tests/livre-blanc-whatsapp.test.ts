import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 🔴 LE QR ET LE LIEN DE LA DERNIÈRE PAGE DU LIVRE BLANC (`docs/livre-blanc/whatsapp-education/`) MÈNENT À
 * `app.messagingme.fr/whatsapp/`. Un PDF qui circule ne se rappelle pas : cette redirection ne se retire jamais (une
 * 404 au scan, vécu le 2026-10-28 avant qu'elle n'existe). Elle reste NON permanente, pour que le numéro derrière
 * puisse changer sans que les navigateurs aient gardé l'ancien.
 */
const RACINE = join(__dirname, '..');
const vercel = JSON.parse(readFileSync(join(RACINE, 'site/vercel.json'), 'utf8')) as {
  redirects: Array<{ source: string; destination: string; permanent?: boolean }>;
};

describe('l’adresse WhatsApp imprimée dans le livre blanc', () => {
  it.each(['/whatsapp', '/whatsapp/'])('%s redirige vers wa.me, et pas pour toujours', (source) => {
    const r = vercel.redirects.find((x) => x.source === source);
    expect(r, `redirection ${source} absente de site/vercel.json`).toBeDefined();
    expect(r!.destination).toMatch(/^https:\/\/wa\.me\/\d{8,15}(\?|$)/);
    expect(r!.permanent).toBe(false);
  });

  it('le livre blanc imprime bien cette adresse', () => {
    const html = readFileSync(join(RACINE, 'docs/livre-blanc/whatsapp-education/livre-blanc.html'), 'utf8');
    expect(html).toContain('app.messagingme.fr/whatsapp');
  });
});
