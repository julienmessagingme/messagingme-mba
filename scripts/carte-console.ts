import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { arbresNav, type NavEntree } from '../web/lib/nav';
import type { EcranAide } from '../src/aide/carte';

/**
 * ÉMET LA CARTE DE LA CONSOLE pour le serveur, depuis la barre de navigation.
 *
 * 🔴 POURQUOI UN FICHIER ÉMIS PLUTÔT QU'UN IMPORT DIRECT. Le serveur (`src/`) et la console (`web/`) sont
 * deux bundles séparés : le serveur ne peut pas importer `web/lib/nav.ts` à l'exécution. Recopier la carte à
 * la main serait une seconde liste, et une seconde liste dérive. L'émettre garde UNE source, et
 * `tests/aide-carte.test.ts` casse la CI le jour où le fichier commité ne correspond plus à la barre.
 *
 * ⚠️ UN MODULE TypeScript, PAS UN JSON. Le typage vient alors du compilateur, et il n'y a aucune sémantique
 * d'import d'attribut à parier sur `tsx` en production, là où une erreur ne se verrait qu'au démarrage.
 */

/** Le traducteur qui rend le libellé FRANÇAIS. */
const fr = (f: string) => f;
/** Le traducteur qui rend le libellé ANGLAIS. */
const en = (_f: string, e: string) => e;

/**
 * L'accès à un écran, DÉDUIT de la règle unique de `AppShell` (`const adminOnly = active !== 'inbox'`).
 *
 * 🔴 CALCULÉ, JAMAIS RECOPIÉ PAR ENTRÉE. Un drapeau posé sur chaque entrée de la barre serait une seconde
 * expression de la même règle, et elle finirait par la contredire sans que rien ne le dise : une entrée
 * ajoutée sans le drapeau deviendrait visible d'un agent. Le prix de ce choix est un test qui LIT la ligne
 * de `AppShell` et casse le jour où elle change (`tests/aide-carte.test.ts`).
 */
const reserveAuxAdmins = (cle: string): boolean => cle !== 'inbox';

/** Les libellés anglais, par clé, pour les apparier aux entrées françaises. */
function libellesAnglais(): Map<string, string> {
  const out = new Map<string, string>();
  const collecter = (entrees: NavEntree[]): void => {
    for (const e of entrees) {
      out.set(e.key, e.label);
      if (e.children) collecter(e.children);
    }
  };
  for (const liste of Object.values(arbresNav(en))) collecter(liste);
  return out;
}

function aplatir(entrees: NavEntree[], anglais: Map<string, string>, chemin: string[], out: EcranAide[]): void {
  for (const e of entrees) {
    // Une entrée qui porte une adresse est une DESTINATION. Un groupe n'en est pas une : il ne se clique
    // que pour se déplier, et y envoyer quelqu'un ne l'emmènerait nulle part.
    if (e.href) {
      out.push({
        cle: e.key,
        href: e.href,
        fr: e.label,
        en: anglais.get(e.key) ?? e.label,
        adminOnly: reserveAuxAdmins(e.key),
        chemin,
      });
    }
    if (e.children) aplatir(e.children, anglais, [...chemin, e.label], out);
  }
}

/**
 * La carte, telle qu'elle doit être écrite dans `src/aide/carte-console.ts`.
 *
 * Pure et exportée pour que le test la recalcule et la compare au fichier commité, sans lancer de
 * sous-processus.
 */
export function construireCarte(): EcranAide[] {
  const anglais = libellesAnglais();
  const out: EcranAide[] = [];
  for (const liste of Object.values(arbresNav(fr))) aplatir(liste, anglais, [], out);
  // Ordre stable par clé : sans lui, un simple réordonnancement de la barre produirait un diff illisible
  // sur un fichier généré, et le test d'égalité tomberait pour une raison qui n'en est pas une.
  out.sort((a, b) => a.cle.localeCompare(b.cle, 'fr'));
  return out;
}

function rendre(ecrans: EcranAide[]): string {
  const lignes = ecrans.map((e) => `  ${JSON.stringify(e)},`).join('\n');
  return `import type { EcranAide } from './carte';

/**
 * LA CARTE DE LA CONSOLE, ÉMISE. Ne pas éditer à la main : lancer \`npm run aide:carte\`.
 *
 * Sa source est la barre de navigation (\`web/lib/nav.ts\`). \`tests/aide-carte.test.ts\` recalcule cette
 * liste et la compare à ce fichier, donc une carte périmée casse la CI plutôt que d'emmener les clients
 * vers la console d'hier.
 */
export const CARTE_CONSOLE: EcranAide[] = [
${lignes}
];
`;
}

const cible = fileURLToPath(new URL('../src/aide/carte-console.ts', import.meta.url));
// Écrit SEULEMENT quand le script est lancé pour lui-même : le test l'importe pour appeler
// `construireCarte`, et une écriture à l'import réécrirait le fichier qu'il est censé vérifier.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const ecrans = construireCarte();
  writeFileSync(cible, rendre(ecrans), 'utf8');
  // eslint-disable-next-line no-console
  console.log(`carte émise : ${ecrans.length} écrans, dont ${ecrans.filter((e) => !e.adminOnly).length} ouverts aux agents`);
}
