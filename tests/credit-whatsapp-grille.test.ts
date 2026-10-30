import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { MARCHES_META, marcheDuNom, marcheDuPays } from '../src/credit-whatsapp/marches-meta';
import { CATEGORIES_META, grillePerimee, normaliserCategorie, palierDeTier, prixMessage, type GrilleMeta } from '../src/credit-whatsapp/grille';
import { lireGrilleCsv } from '../src/credit-whatsapp/grille-csv';

/**
 * La grille de Meta et le prix d'un message (plan du Crédit WhatsApp, tâche 2). Le fichier ci-dessous a la FORME supposée
 * du fichier « EUR list rates » de Meta ; ses valeurs sont fictives.
 */
const CSV = [
  'Exemple de forme, valeurs fictives',
  'Market,Currency,Marketing,Utility,Authentication,Authentication-International,Service',
  'France,EUR,0.0712,0.0248,0.0248,,0.0248',
  'Germany,EUR,0.1131,0.0456,0.0636,,0.0456',
  '"Rest of Central & Eastern Europe",EUR,0.0797,0.0391,0.0391,,0.0391',
  'Rest of Western Europe,EUR,0.0545,0.0283,0.0283,,0.0283',
  'North America,EUR,0.0230,0.0035,0.0125,,0.0035',
  'India,EUR,0.0102,0.0013,0.0013,0.0258,0.0013',
  'United Kingdom,EUR,0.0488,0.0204,0.0328,,0.0204',
  'Other,EUR,0.0558,0.0071,0.0071,,0.0071',
].join('\n');

function grille(): GrilleMeta {
  const l = lireGrilleCsv(CSV);
  if (!l.ok) throw new Error(l.erreur);
  return { id: 'g1', enVigueurLe: '2026-10-01', tarifs: l.tarifs };
}

describe('les marchés de Meta', () => {
  it('reprennent la page de Meta : 39 pays nommés, huit régions, aucun pays dans deux marchés', () => {
    const nommes = MARCHES_META.filter((m) => m.pays.length === 1 && m.cle === m.pays[0]);
    expect(nommes).toHaveLength(39);
    const taille = (cle: string): number => MARCHES_META.find((m) => m.cle === cle)!.pays.length;
    expect([taille('north_america'), taille('rest_of_africa'), taille('rest_of_asia_pacific'), taille('rest_of_central_eastern_europe'),
      taille('rest_of_western_europe'), taille('rest_of_latin_america'), taille('rest_of_middle_east'), taille('other')])
      .toEqual([2, 40, 16, 16, 9, 15, 4, 0]);
    const tous = MARCHES_META.flatMap((m) => [...m.pays, ...(m.memeIndicatif ?? [])]);
    expect(new Set(tous).size).toBe(tous.length);
  });

  it('rangent un pays par son indicatif : Guernesey au Royaume-Uni, la Réunion dans Other', () => {
    expect(marcheDuPays('FR')).toBe('FR');
    expect(marcheDuPays('fr')).toBe('FR');
    expect(marcheDuPays('GG')).toBe('GB');
    expect(marcheDuPays('BE')).toBe('rest_of_western_europe');
    expect(marcheDuPays('DO')).toBe('rest_of_latin_america');
    expect(marcheDuPays('RE')).toBe('other');
    expect(marcheDuPays(null)).toBe('other');
  });

  it('se retrouvent par le nom du fichier, « & » ou « and »', () => {
    expect(marcheDuNom('Rest of Central and Eastern Europe')).toBe('rest_of_central_eastern_europe');
    expect(marcheDuNom('  united KINGDOM ')).toBe('GB');
    expect(marcheDuNom('Atlantis')).toBeNull();
  });
});

describe('la catégorie et le palier', () => {
  it('🔴 la base accepte exactement les catégories du code (provisions et tarifs, migration 0264)', () => {
    const sql = readFileSync(new URL('../db/migrations/0264_credit_whatsapp.sql', import.meta.url), 'utf8');
    const listes = [...sql.matchAll(/categorie\s+text not null check \(categorie in \(([^)]*)\)\)/g)].map((m) => [...m[1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]));
    expect(listes).toHaveLength(2);
    for (const l of listes) expect(l).toEqual([...CATEGORIES_META]);
  });

  it('normalise ce que Meta écrit', () => {
    expect(normaliserCategorie('MARKETING_LITE')).toBe('marketing');
    expect(normaliserCategorie('Authentication-International')).toBe('authentication_international');
    expect(normaliserCategorie('service')).toBe('service');
    expect(normaliserCategorie('referral_conversion')).toBeNull();
    expect(normaliserCategorie(null)).toBeNull();
  });

  it('lit le seuil bas d’un palier de pricing_analytics', () => {
    expect(palierDeTier('25000001:50000000')).toBe(25000001);
    expect(palierDeTier('0:250000')).toBe(0);
    expect(palierDeTier('illisible')).toBe(0);
    expect(palierDeTier(null)).toBe(0);
  });
});

describe('le prix d’un message, commission comprise, en micro-euros', () => {
  it('France : le tarif du fichier fois 1,05', () => {
    expect(prixMessage(grille(), 'FR', 'marketing', 5)).toBe(74760);
    expect(prixMessage(grille(), 'FR', 'utility', 5)).toBe(26040);
    expect(prixMessage(grille(), 'FR', 'service', 0)).toBe(24800);
  });

  it('🔴 jamais moins que ce que Meta peut facturer : destinataire sans pays et catégorie inconnue au plus cher', () => {
    expect(prixMessage(grille(), null, 'marketing', 5)).toBe(118755);
    expect(prixMessage(grille(), 'FR', null, 5)).toBe(74760);
    expect(prixMessage(grille(), 'IN', 'authentication', 5)).toBe(27090);
  });

  it('un marché absent du fichier retombe sur Other', () => {
    expect(prixMessage(grille(), 'RE', 'marketing', 5)).toBe(58590);
    expect(prixMessage(grille(), 'BR', 'utility', 0)).toBe(7100);
  });

  it('un palier de volume ne vaut qu’au-delà de son seuil', () => {
    const g = grille();
    const avecPalier: GrilleMeta = { ...g, tarifs: [...g.tarifs, { marche: 'FR', categorie: 'utility', palier: 250001, prixMicroEur: 20000 }] };
    expect(prixMessage(avecPalier, 'FR', 'utility', 5, 300000)).toBe(21000);
    expect(prixMessage(avecPalier, 'FR', 'utility', 5, 100)).toBe(26040);
  });

  it('sans aucun tarif pour la catégorie : null, jamais gratuit', () => {
    expect(prixMessage({ id: 'g', enVigueurLe: '2026-10-01', tarifs: [] }, 'FR', 'marketing', 5)).toBeNull();
  });
});

describe('la grille périmée', () => {
  it('est entrée en vigueur avant le trimestre en cours', () => {
    expect(grillePerimee('2026-07-01', new Date('2026-10-30T12:00:00Z'))).toBe(true);
    expect(grillePerimee('2026-10-01', new Date('2026-10-30T12:00:00Z'))).toBe(false);
  });
});

describe('la lecture du fichier de Meta', () => {
  it('lit chaque case renseignée, l’authentification internationale seulement où elle existe', () => {
    const l = lireGrilleCsv(CSV);
    expect(l.ok).toBe(true);
    if (!l.ok) return;
    expect(l.tarifs).toHaveLength(8 * 4 + 1);
    expect(l.tarifs.find((t) => t.marche === 'FR' && t.categorie === 'marketing')?.prixMicroEur).toBe(71200);
    expect(l.tarifs.filter((t) => t.categorie === 'authentication_international').map((t) => t.marche)).toEqual(['IN']);
  });

  it('accepte le point-virgule, la virgule décimale et le symbole de l’euro', () => {
    const variante = CSV.replace(/,/g, ';').replace('0.0712', '"0,0712 €"');
    const l = lireGrilleCsv(variante);
    expect(l.ok && l.tarifs.find((t) => t.marche === 'FR' && t.categorie === 'marketing')?.prixMicroEur).toBe(71200);
  });

  it('🔴 refuse au lieu de deviner, et nomme la ligne', () => {
    expect(lireGrilleCsv(CSV.replace('Germany', 'Atlantis'))).toEqual({ ok: false, erreur: 'ligne 4 : marché inconnu « Atlantis » (la liste des marchés de Meta a changé ?)' });
    expect(lireGrilleCsv(CSV.replace('France,EUR', 'France,USD'))).toMatchObject({ ok: false, erreur: expect.stringContaining('ligne 3 : devise « USD »') });
    expect(lireGrilleCsv(CSV.replace('0.1131', 'gratuit'))).toMatchObject({ ok: false, erreur: expect.stringContaining('prix illisible « gratuit »') });
    expect(lireGrilleCsv(CSV.replace('France,EUR,0.0712,0.0248,0.0248,,0.0248\n', ''))).toEqual({ ok: false, erreur: 'tarif absent : FR, marketing' });
    expect(lireGrilleCsv('a,b\n1,2')).toMatchObject({ ok: false, erreur: expect.stringContaining('« Market » introuvable') });
    expect(lireGrilleCsv(CSV.replace(',Service', ',Divers'))).toMatchObject({ ok: false, erreur: 'colonne(s) absente(s) : service' });
    expect(lireGrilleCsv(`${CSV}\nFrance,EUR,1,1,1,,1`)).toMatchObject({ ok: false, erreur: expect.stringContaining('en double') });
  });
});
