import { CARTE_CONSOLE } from './carte-console';

/**
 * La carte de la console : les écrans où le bot d'aide peut emmener quelqu'un.
 *
 * C'est la garde anti-hallucination, structurelle : le modèle ne choisit jamais une adresse, il choisit une
 * clé dans cette liste fermée, et `resoudre` la vérifie. Une consigne de prompt serait un souhait ; ceci est
 * une garantie. La liste est émise depuis la barre de navigation (`npm run aide:carte`), jamais écrite à la main.
 */

/** Un écran de la console, tel que le bot d'aide peut y emmener quelqu'un. */
export interface EcranAide {
  /** La clé de nav, stable, et la seule chose que le modèle a le droit de nommer. */
  cle: string;
  href: string;
  /** Le libellé affiché dans la barre, en français puis en anglais. */
  fr: string;
  en: string;
  /** Qui peut ouvrir cet écran : `tous` (l'Inbox), `encadrement` (admin + manager), `admin`. */
  acces: 'tous' | 'encadrement' | 'admin';
  /** Les groupes qui mènent à l'écran, pour dire « AI Agent > MBA » plutôt que le seul nom de la page. */
  chemin: string[];
}

export function chargerCarte(): EcranAide[] {
  return CARTE_CONSOLE;
}

/**
 * Les écrans que cette personne a le droit d'atteindre. Tout rôle inconnu est traité comme un agent : un rôle
 * ajouté plus tard, mal orthographié ou vide doit voir moins, jamais plus.
 */
export function carteVisiblePar(role: string): EcranAide[] {
  if (role === 'admin') return chargerCarte();
  if (role === 'manager') return chargerCarte().filter((e) => e.acces !== 'admin');
  return chargerCarte().filter((e) => e.acces === 'tous');
}

/**
 * Résout les clés rendues par le modèle en écrans réels :
 *  - une clé inconnue est jetée, jamais rapprochée d'une clé voisine : un lien approximatif est pire qu'aucun ;
 *  - le filtrage par rôle est refait ici : le modèle peut recracher une clé vue ailleurs dans la conversation ;
 *  - l'ordre du modèle est conservé (c'est le pas à pas) et les doublons retirés.
 */
export function resoudre(cles: string[], role: string): EcranAide[] {
  const permis = new Map(carteVisiblePar(role).map((e) => [e.cle, e]));
  const vus = new Set<string>();
  const out: EcranAide[] = [];
  for (const c of cles) {
    const e = permis.get(c);
    if (e && !vus.has(c)) {
      vus.add(c);
      out.push(e);
    }
  }
  return out;
}
