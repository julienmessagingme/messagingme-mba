import { CARTE_CONSOLE } from './carte-console';

/**
 * LA CARTE DE LA CONSOLE : les écrans où le bot d'aide peut emmener quelqu'un.
 *
 * 🔴 C'EST LA GARDE ANTI-HALLUCINATION, et elle est STRUCTURELLE. Le pire échec de ce produit n'est pas une
 * réponse imprécise, c'est un bot qui annonce un bouton qui n'existe pas : le client perd alors confiance
 * dans le PRODUIT, pas dans le bot. Le modèle ne choisit donc jamais une adresse, il choisit une CLÉ dans
 * cette liste fermée, et `resoudre` la vérifie. Une consigne de prompt (« ne cite que des écrans réels »)
 * serait un souhait ; ceci est une garantie. C'est la doctrine que la migration 0126 a posée en retirant au
 * modèle une décision qu'il ne pouvait pas tenir.
 *
 * La liste est ÉMISE depuis la barre de navigation (`npm run aide:carte`), jamais écrite à la main.
 */

/** Un écran de la console, tel que le bot d'aide peut y emmener quelqu'un. */
export interface EcranAide {
  /** La clé de nav, stable, et la seule chose que le modèle a le droit de nommer. */
  cle: string;
  href: string;
  /** Le libellé affiché dans la barre, en français puis en anglais. */
  fr: string;
  en: string;
  adminOnly: boolean;
  /** Les groupes qui mènent à l'écran, pour dire « AI Agent > MBA » plutôt que le seul nom de la page. */
  chemin: string[];
}

export function chargerCarte(): EcranAide[] {
  return CARTE_CONSOLE;
}

/**
 * Les écrans que cette personne a le droit d'atteindre.
 *
 * ⚠️ TOUT RÔLE QUI N'EST PAS `admin` EST TRAITÉ COMME UN AGENT, et c'est délibéré : un rôle ajouté plus
 * tard, mal orthographié ou vide doit voir MOINS, jamais plus. C'est la même prudence que la règle
 * d'affichage de la console, qui réserve tout sauf l'Inbox.
 */
export function carteVisiblePar(role: string): EcranAide[] {
  return role === 'admin' ? chargerCarte() : chargerCarte().filter((e) => !e.adminOnly);
}

/**
 * Résout les clés rendues par le modèle en écrans réels.
 *
 * 🔴 C'EST ICI QUE LA GARDE SE FERME, et trois décisions la rendent juste :
 *
 *  - une clé inconnue est JETÉE, jamais devinée ni rapprochée d'une clé voisine. Un lien approximatif est
 *    pire qu'un lien absent : il envoie le client sur un écran qui ne répond pas à sa question, et c'est
 *    nous qui aurons l'air de ne pas connaître notre produit ;
 *  - le filtrage par RÔLE est refait ici, pas seulement à la présentation. Le modèle voit une carte filtrée,
 *    mais rien ne l'empêche de recracher une clé vue ailleurs dans la conversation, et emmener un agent sur
 *    un écran d'administrateur le ferait tomber sur un refus ;
 *  - l'ORDRE du modèle est conservé et les doublons retirés. Il cite le premier écran en premier parce que
 *    c'est là qu'on commence, donc trier casserait le pas à pas ; et il se répète volontiers, or deux fois
 *    le même lien dans une réponse se remarque tout de suite.
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
