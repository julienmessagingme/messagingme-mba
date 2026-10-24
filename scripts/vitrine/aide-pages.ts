// scripts/vitrine/aide-pages.ts
// Le REGISTRE du centre d'aide de la vitrine (plan docs/superpowers/plans/2026-10-20-centre-d-aide.md, tâche 5) : les
// fiches publiques de `docs/aide/fiches/`, leur version anglaise (`docs/aide/fiches/en/`) et leurs adresses. Le
// générateur (`aide.ts`) écrit les pages ; `anglais.ts` en lit les jumelles. Ce fichier n'importe ni l'un ni l'autre :
// `anglais.ts` le lit à l'import, et une boucle d'imports le laisserait à moitié chargé.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { champDeFiche, lireFicheDuDepot, publicationDe, RUBRIQUES, type PublicationFiche, type Rubrique } from '../../src/aide/fiches';
import { PAGES_CLAUDE } from './aide-claude-textes';

export type Langue = 'fr' | 'en';

const DOSSIER = fileURLToPath(new URL('../../docs/aide/fiches/', import.meta.url));

/** L'accueil du centre d'aide, par langue. */
export const ACCUEIL_AIDE: Readonly<Record<Langue, string>> = { fr: '/aide/', en: '/en/help/' };

/** Le nom de chaque rubrique, dans l'ordre du menu (`RUBRIQUES`). */
export const NOMS_RUBRIQUES: Readonly<Record<Rubrique, Readonly<Record<Langue, string>>>> = {
  demarrer: { fr: 'Démarrer', en: 'Get started' },
  'parler-aux-clients': { fr: 'Parler aux clients', en: 'Talk to customers' },
};

export interface VersionPage {
  adresse: string;
  titre: string;
  corps: string;
  /** Le libellé du bouton de la console (`bouton_console` de l'en-tête), à la place de « Ouvrir « <écran> » ». */
  boutonConsole: string | null;
  /** Le libellé du bouton vers le plugin d'une fiche `claude_code: oui` (`bouton_claude`), à la place du libellé commun. */
  boutonClaude: string | null;
}

/** Une page du centre d'aide : sa fiche, sa publication, et ses deux langues. */
export interface PageAide {
  cle: string;
  ecran: string | null;
  /** L'ancre de l'écran où mène le bouton de la console (`ancre_console`), une carte de Paramètres par exemple. */
  ancreConsole: string | null;
  publication: PublicationFiche;
  fr: VersionPage;
  en: VersionPage;
}

/** Les pages du centre, dans l'ordre du menu : rubrique, puis rang. */
export function pagesDuCentre(dossier: string = DOSSIER): PageAide[] {
  return readdirSync(dossier)
    .filter((n) => n.endsWith('.md'))
    .flatMap((nom): PageAide[] => {
      const texte = readFileSync(join(dossier, nom), 'utf8');
      const publication = publicationDe(texte);
      if (publication === null) return [];
      const fr = lireFicheDuDepot(nom, texte);
      // Un message qui dit quoi faire, plutôt qu'un ENOENT à l'import des tests de la vitrine (relecture du lot 3).
      if (!existsSync(join(dossier, 'en', nom))) {
        throw new Error(`docs/aide/fiches/en/${nom} manquante : une fiche publique a sa version anglaise (la traduire, avec slug et traduit_de)`);
      }
      const texteEn = readFileSync(join(dossier, 'en', nom), 'utf8');
      const en = lireFicheDuDepot(nom, texteEn);
      const slug = champDeFiche(texteEn, 'slug');
      if (slug === null) throw new Error(`docs/aide/fiches/en/${nom} : sans slug`);
      const ancreConsole = champDeFiche(texte, 'ancre_console');
      if (ancreConsole !== null && !/^[a-z0-9-]+$/.test(ancreConsole)) throw new Error(`${nom} : ancre_console « ${ancreConsole} »`);
      return [{
        cle: fr.cle,
        ecran: fr.ecran,
        ancreConsole,
        publication,
        fr: {
          adresse: `${ACCUEIL_AIDE.fr}${fr.cle}/`, titre: fr.titre, corps: fr.corps,
          boutonConsole: champDeFiche(texte, 'bouton_console'), boutonClaude: champDeFiche(texte, 'bouton_claude'),
        },
        en: {
          adresse: `${ACCUEIL_AIDE.en}${slug}/`, titre: en.titre, corps: en.corps,
          boutonConsole: champDeFiche(texteEn, 'bouton_console'), boutonClaude: champDeFiche(texteEn, 'bouton_claude'),
        },
      }];
    })
    .sort((a, b) => RUBRIQUES.indexOf(a.publication.rubrique) - RUBRIQUES.indexOf(b.publication.rubrique)
      || a.publication.rang - b.publication.rang);
}

/**
 * Chaque page française du centre et sa jumelle anglaise, l'accueil compris, plus les pages « Depuis Claude Code » de
 * la doc développeurs (lu par `anglais.ts`).
 */
export function jumellesAide(): Record<string, string> {
  return Object.fromEntries([
    [ACCUEIL_AIDE.fr, ACCUEIL_AIDE.en],
    ...pagesDuCentre().map((p) => [p.fr.adresse, p.en.adresse]),
    ...PAGES_CLAUDE.map((p) => [p.adresse.fr, p.adresse.en]),
  ]);
}

/** Les pages françaises « Depuis Claude Code » : générées ici, donc hors de la traduction par dictionnaires. */
export const ADRESSES_CLAUDE_FR: ReadonlySet<string> = new Set(PAGES_CLAUDE.map((p) => p.adresse.fr));
