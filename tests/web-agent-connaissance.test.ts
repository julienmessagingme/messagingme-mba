import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  JOURS_AVANT_ALERTE, MAX_CORPS_FICHE, MAX_TITRE_FICHE, joursDepuis, sourcePerimee,
} from '../web/lib/agent-connaissance';
import { MAX_CORPS, MAX_TITRE } from '../src/agent/scrape';

/**
 * La fraîcheur d'une source, et la parité des bornes entre les deux builds.
 *
 * Les deux moitiés du produit ne partagent aucun module : une borne recopiée côté navigateur finit par
 * s'écarter de celle du serveur, et le champ laisse alors passer une saisie que la route refuse en 400,
 * c'est-à-dire une erreur technique pour une faute que l'écran savait déjà.
 */
const MAINTENANT = Date.parse('2026-08-28T12:00:00.000Z');
const ilYA = (jours: number) => new Date(MAINTENANT - jours * 86_400_000).toISOString();

describe('fraîcheur d’une source de connaissance', () => {
  it('compte les jours entiers depuis la lecture', () => {
    expect(joursDepuis(ilYA(0), MAINTENANT)).toBe(0);
    expect(joursDepuis(ilYA(1), MAINTENANT)).toBe(1);
    expect(joursDepuis(ilYA(200), MAINTENANT)).toBe(200);
  });

  it('ne fabrique rien à partir de rien', () => {
    // Une fiche écrite à la main n'a pas de date : il n'y a rien eu à relire, donc rien à signaler.
    expect(joursDepuis(null, MAINTENANT)).toBeNull();
    expect(joursDepuis('pas une date', MAINTENANT)).toBeNull();
    expect(sourcePerimee(null, MAINTENANT)).toBe(false);
    expect(sourcePerimee('pas une date', MAINTENANT)).toBe(false);
  });

  it('une horloge en avance ne rend pas un âge négatif', () => {
    expect(joursDepuis(new Date(MAINTENANT + 86_400_000).toISOString(), MAINTENANT)).toBe(0);
  });

  it('🔴 l’alerte tombe au seuil, pas avant', () => {
    expect(sourcePerimee(ilYA(JOURS_AVANT_ALERTE - 1), MAINTENANT)).toBe(false);
    expect(sourcePerimee(ilYA(JOURS_AVANT_ALERTE), MAINTENANT)).toBe(true);
    expect(sourcePerimee(ilYA(JOURS_AVANT_ALERTE + 400), MAINTENANT)).toBe(true);
  });
});

describe('parité des bornes de fiche, navigateur contre serveur', () => {
  it('le corps est borné à la même valeur des deux côtés', () => {
    expect(MAX_CORPS_FICHE).toBe(MAX_CORPS);
  });

  it('le titre est borné à la même valeur des deux côtés', () => {
    expect(MAX_TITRE_FICHE).toBe(MAX_TITRE);
  });

  it('🔴 le schéma de la route DÉRIVE des deux plafonds, il ne les recopie pas', () => {
    // C'est le vrai verrou : tant que la route importe les constantes, un changement de plafond se propage
    // tout seul. Le jour où quelqu'un remet un littéral, ce test le voit, alors que les deux assertions
    // ci-dessus resteraient vertes jusqu'à ce que les valeurs divergent pour de bon.
    const source = readFileSync(new URL('../src/http/agent-knowledge.ts', import.meta.url), 'utf8');
    expect(source).toContain('const TITRE = z.string().trim().min(1).max(MAX_TITRE)');
    expect(source).toContain('const CORPS = z.string().trim().min(1).max(MAX_CORPS)');
  });
});
