import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { horodatageIso } from '../src/lib/horodatage-iso';
import { corpsRejeu, requeteJournal } from '../src/api/contrat-public';

// 🔴 zod 4.6 exige les secondes d'un horodatage ISO, que 4.4 laissait facultatives (mesuré le 2026-10-24, à la montée
// de version pour GHSA-mrhx-c7xc-m3w5) : sans l'aide partagée, une date écrite à la minute par un intégrateur ou par un
// modèle était refusée du jour au lendemain, et aucun test ne le disait.
const ACCEPTEES = [
  '2026-10-25T09:00Z',
  '2026-10-25T09:00+02:00',
  '2026-10-25T09:00:00Z',
  '2026-10-25T09:00:00.123Z',
  '2026-10-25T09:00:00+02:00',
  '2026-10-25T09:00:00.123456+02:00',
];
const REFUSEES = ['2026-10-25', '2026-10-25T09Z', '2026-10-25T9:00Z', 'demain', ''];

describe('horodatageIso : le domaine de zod 4.4, secondes facultatives', () => {
  it('🔴 accepte une heure à la minute, avec Z ou avec un décalage, et rend la valeur TELLE QUELLE', () => {
    for (const d of ACCEPTEES) expect(horodatageIso().safeParse(d)).toEqual({ success: true, data: d });
  });

  it('refuse ce qui n’est pas un horodatage complet, avec un message en français', () => {
    for (const d of REFUSEES) {
      const r = horodatageIso().safeParse(d);
      expect(r.success).toBe(false);
      expect(r.error?.issues[0]?.message).toContain('date ISO 8601 attendue');
    }
  });

  it('🔴 les entrées de l’API publique l’appliquent : la pagination du journal et le rejeu des échecs', () => {
    expect(requeteJournal.safeParse({ before: '2026-10-25T09:00Z' }).success).toBe(true);
    expect(corpsRejeu.safeParse({ since: '2026-10-25T09:00+02:00' }).success).toBe(true);
    expect(corpsRejeu.safeParse({ since: '2026-10-25' }).success).toBe(false);
  });

  it('🔴 aucune date reçue n’est validée hors de l’aide partagée (un `.datetime(` nu reprendrait le domaine de zod)', () => {
    const fautifs: string[] = [];
    const parcourir = (dossier: string): void => {
      for (const nom of readdirSync(dossier)) {
        const chemin = join(dossier, nom);
        if (statSync(chemin).isDirectory()) parcourir(chemin);
        else if (chemin.endsWith('.ts') && !chemin.endsWith(join('lib', 'horodatage-iso.ts')) && /\.datetime\(|z\.iso\.datetime/.test(readFileSync(chemin, 'utf8'))) fautifs.push(chemin);
      }
    };
    parcourir(join(__dirname, '..', 'src'));
    expect(fautifs).toEqual([]);
  });
});
