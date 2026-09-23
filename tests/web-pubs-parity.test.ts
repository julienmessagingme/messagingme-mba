import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TAILLE_VISUEL_PUB_MAX, TYPES_VISUEL_PUB } from '../src/meta/pubs-creation';
import { TAILLE_VISUEL_MAX, TYPES_VISUEL, enPauseChezMeta } from '../web/lib/api-pubs';
import { ISSUES_NON_PRISES_EN_CHARGE } from '../src/pubs/entonnoir';

/**
 * LES BORNES DU VISUEL D'UNE PUBLICITÉ, DES DEUX CÔTÉS.
 *
 * L'écran refuse AVANT de téléverser (attendre cinq mégaoctets pour se faire dire non est une mauvaise
 * expérience, et la limite de corps de la route couperait de toute façon), le serveur refuse en dernier
 * ressort. Deux chiffres qui divergent donnent le pire des deux : un écran qui promet ce que le serveur
 * refuse, avec un 400 que personne ne relie à la promesse. Même patron que les autres tests de parité du
 * dépôt.
 *
 * 🔴 C'EST L'ÉCART QUI PORTE L'INVARIANT, PAS CHAQUE CONSTANTE. Prise seule, chacune est plausible : cinq
 * mégaoctets ici, six là, personne ne sursaute en relisant l'un des deux fichiers. Ce genre d'invariant
 * n'est visible dans aucun des deux, et ne tient donc que dans un test.
 */
describe('parité des bornes du visuel publicitaire', () => {
  it('l’écran et le serveur annoncent le MÊME poids maximum', () => {
    expect(TAILLE_VISUEL_MAX).toBe(TAILLE_VISUEL_PUB_MAX);
  });

  it('l’écran et le serveur acceptent les MÊMES types', () => {
    expect([...TYPES_VISUEL]).toEqual([...TYPES_VISUEL_PUB]);
  });

  it('🔴 ni SVG ni GIF, des deux côtés : ce fichier part chez un tiers sous l’identité du client', () => {
    // Un SVG est un document exécutable. Le laisser entrer par le côté où la garde est la plus faible
    // suffirait : c'est le serveur qui décide, et l'écran ne doit pas lui promettre autre chose.
    for (const liste of [[...TYPES_VISUEL], [...TYPES_VISUEL_PUB]]) {
      expect(liste).not.toContain('image/svg+xml');
      expect(liste).not.toContain('image/gif');
    }
  });
});

/**
 * LE LIBELLÉ DU BOUTON D'UNE PUBLICITÉ QUI DÉPENSE.
 *
 * 🔴 `null` VEUT DIRE « PAS ENCORE RELU CHEZ META », ET IL NE DOIT PAS DIRE « EN PAUSE ». Le statut
 * n'arrive qu'au balayage suivant, jusqu'à quinze minutes après la publication : pendant cette fenêtre,
 * une publicité qui paie des impressions affichait « Relancer », c'est-à-dire exactement l'inverse de son
 * état. C'est la même famille que le reste de cet écran, où « non disponible » n'est jamais « 0 ».
 */
describe('à l’arrêt chez Meta, ou seulement pas encore relue', () => {
  it('🔴 un statut JAMAIS LU ne vaut pas « en pause »', () => {
    expect(enPauseChezMeta(null)).toBe(false);
  });

  it('« ACTIVE » diffuse, donc le geste offert est la mise en pause', () => {
    expect(enPauseChezMeta('ACTIVE')).toBe(false);
  });

  it('les trois formes de pause de Meta sont bien des pauses', () => {
    for (const s of ['PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED']) expect(enPauseChezMeta(s)).toBe(true);
  });

  it('🔴 LA DÉCISION VIT DANS LA FONCTION, PAS DANS UN `if` DU COMPOSANT', () => {
    // Sans ce sens-là, la comparaison peut revenir se poser en ligne dans l'écran, et ce fichier
    // continuerait de tester une fonction que plus personne n'appelle.
    const source = readFileSync(join(process.cwd(), 'web/components/PubsListe.tsx'), 'utf8');
    expect(source).toContain('enPauseChezMeta(pub.statutMeta)');
    expect(source).not.toContain("statutMeta !== 'ACTIVE'");
  });
});

/**
 * CHAQUE ISSUE QUE LE SERVEUR COMPTE « NON PRISE EN CHARGE » EST NOMMÉE À L'ÉCRAN, DANS LES DEUX LANGUES.
 *
 * 🔴 CE TEST LIT LE FICHIER DE L'ÉCRAN, ET IL A ÉTÉ ÉCRIT PARCE QU'IL NE LE LISAIT PAS. Sa version
 * précédente comparait `ISSUES_NON_PRISES_EN_CHARGE` à une copie de la même liste : elle affirmait « les
 * trois issues que l'écran énumère » sans ouvrir l'écran une seule fois. Quand une QUATRIÈME issue est
 * arrivée (`sans_scenario`), elle est restée verte pendant que la légende continuait d'en annoncer trois.
 *
 * ⚠️ IL PINCE UNE ORTHOGRAPHE, ET C'EST ASSUMÉ. Ce qu'il protège n'est pas un comportement (le calcul vit
 * côté serveur) mais une PROMESSE : le client lit ce chiffre pour décider s'il y a quelque chose à
 * RÉPARER. Une cause comptée et non nommée l'envoie chercher le défaut parmi celles qui sont écrites,
 * c'est-à-dire au mauvais endroit. `sans_scenario` est précisément la seule des quatre qui se répare.
 */
describe('ce que l’écran annonce sur les prospects non pris en charge', () => {
  /** Le fragment que la légende doit porter pour chaque issue, en français et en anglais. */
  const NOMMEES: Record<string, { fr: string; en: string }> = {
    reprise_refusee: { fr: 'reprise refusée', en: 'handover refused' },
    desabonne: { fr: 'désabonnés', en: 'unsubscribed' },
    bloque: { fr: 'bloqués', en: 'blocked' },
    sans_scenario: { fr: 'sans scénario', en: 'no scenario' },
  };

  /**
   * La LÉGENDE seule, pas le fichier entier : un mot présent ailleurs dans le composant ferait passer le
   * test sans que le client lise quoi que ce soit.
   */
  const legende = (): string => {
    const source = readFileSync(join(process.cwd(), 'web/components/PubsListe.tsx'), 'utf8');
    const bloc = /data-testid=\{`pub-non-pris-\$\{id\}`\}>([\s\S]*?)<\/p>/.exec(source);
    expect(bloc, 'la légende des prospects non pris en charge est introuvable dans l’écran').not.toBeNull();
    return bloc?.[1] ?? '';
  };

  it('🔴 la table de ce test couvre EXACTEMENT les issues du serveur', () => {
    // Le sens qui compte est celui-ci : une CINQUIÈME issue ajoutée au serveur fait tomber ce test tant
    // que personne ne l'a nommée à l'écran. Sans lui, la boucle ci-dessous ne vérifierait que les issues
    // que quelqu'un a pensé à écrire ici.
    expect(Object.keys(NOMMEES).sort()).toEqual([...ISSUES_NON_PRISES_EN_CHARGE].sort());
  });

  for (const [issue, mots] of Object.entries(NOMMEES)) {
    it(`l’écran nomme « ${issue} », en français et en anglais`, () => {
      const texte = legende();
      expect(texte).toContain(mots.fr);
      expect(texte).toContain(mots.en);
    });
  }
});
