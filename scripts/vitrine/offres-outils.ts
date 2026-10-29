// scripts/vitrine/offres-outils.ts
// L'offre qu'ouvre un outil MCP, pour les étiquettes de la vitrine (plan `docs/superpowers/plans/2026-10-28-vitrine-cas-mcp.md`,
// point 5) : lue dans la `fonction` de l'outil (`src/mcp/`) et dans `DROITS`, jamais écrite à la main. Un outil qui change
// d'offre change d'étiquette à la génération suivante, et `tests/vitrine-cas.test.ts` refuse une page restée en arrière.
// 🔴 L'étiquette dit la PLUS PETITE offre qui l'ouvre : « Pro » veut dire « Pro et au-delà ».
import { OUTILS } from '../../src/mcp/outils';
import { DROITS, type Fonction, type Offre } from '../../src/offres/offres';
import type { NomOutilMcp } from '../../web/lib/partage/catalogue-mcp';
import type { Langue } from './cas-textes';

/** Les offres de la plus petite à la plus grande : chacune ouvre au moins ce que la précédente ouvre. */
const ORDRE: readonly Offre[] = ['base', 'pro', 'business', 'entreprise'];

export const NOMS_OFFRES: Readonly<Record<Langue, Readonly<Record<Offre, string>>>> = {
  fr: { base: 'Free', pro: 'Pro', business: 'Business', entreprise: 'Entreprise' },
  en: { base: 'Free', pro: 'Pro', business: 'Business', entreprise: 'Enterprise' },
};

/** La plus petite offre qui ouvre cette fonction ; `null` (ouvert à toutes) = la Free. */
export function offreDeLaFonction(fonction: Fonction | null): Offre {
  if (fonction === null) return 'base';
  const offre = ORDRE.find((o) => DROITS[o].fonctions.has(fonction));
  if (!offre) throw new Error(`offres-outils : aucune offre n'ouvre ${fonction}`);
  return offre;
}

export function offreDeLOutil(nom: NomOutilMcp): Offre {
  const outil = OUTILS.find((o) => o.nom === nom);
  if (!outil) throw new Error(`offres-outils : ${nom} n'est pas au catalogue du serveur MCP`);
  return offreDeLaFonction(outil.fonction);
}

/**
 * L'offre d'une carte : la plus haute de ses outils, et de la fonction de la console qui la porte quand il y en a une
 * (l'Inbox, les publicités). Une carte sans outil ni fonction n'a rien d'où tirer son offre : refusée.
 */
export function offreDeLaCarte(c: { readonly outils: readonly NomOutilMcp[]; readonly fonction?: Fonction }): Offre {
  const offres = [...c.outils.map(offreDeLOutil), ...(c.fonction ? [offreDeLaFonction(c.fonction)] : [])];
  if (offres.length === 0) throw new Error('offres-outils : une carte sans outil ni fonction');
  return ORDRE[Math.max(...offres.map((o) => ORDRE.indexOf(o)))]!;
}

/** L'étiquette d'une offre, la même sur toutes les pages (`.bt-offre` dans `site.css`, mise en avant hors de la Free). */
export const etiquetteDOffre = (offre: Offre, langue: Langue): string =>
  `<span class="bt-offre" data-etiquette="${offre}">${langue === 'fr' ? `Offre ${NOMS_OFFRES.fr[offre]}` : `${NOMS_OFFRES.en[offre]} plan`}</span>`;
