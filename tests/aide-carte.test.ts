import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { construireCarte } from '../scripts/carte-console';
import { CARTE_CONSOLE } from '../src/aide/carte-console';
import { chargerCarte, carteVisiblePar, resoudre } from '../src/aide/carte';

/**
 * LA CARTE DE LA CONSOLE, telle que le serveur la lit.
 *
 * 🔴 C'EST LA GARDE ANTI-HALLUCINATION DU BOT D'AIDE, et elle est structurelle. Le modèle ne rend jamais une
 * adresse, il rend une CLÉ, et `resoudre` la cherche dans cette liste fermée. Une clé inventée ne produit
 * donc aucun lien. Une consigne de prompt (« ne cite que des écrans réels ») serait un souhait ; ceci est
 * une garantie, et c'est la doctrine que la migration 0126 a posée en retirant au modèle une décision qu'il
 * ne pouvait pas tenir.
 */
const fr = (f: string) => f;

describe('la carte émise', () => {
  it('🔴 le fichier COMMITÉ correspond à la barre d’aujourd’hui', () => {
    // Le fichier est un ARTEFACT, pas une source. S'il dérive, le bot emmène vers la console d'hier, et rien
    // d'autre ne le signalerait : il resterait cohérent avec lui-même.
    expect(CARTE_CONSOLE, 'carte périmée : lancer `npm run aide:carte` et commiter le résultat')
      .toEqual(construireCarte());
  });

  it('elle couvre les quatre listes, le bloc Developers compris', () => {
    // Le bloc bas est le plus facile à oublier, parce qu'il est rendu à part dans la barre. L'omettre
    // rendrait les écrans Developers invisibles du bot, en silence.
    const cles = new Set(CARTE_CONSOLE.map((e) => e.cle));
    for (const attendue of ['accueil', 'campagnes', 'inbox', 'quanti-messages', 'api-keys']) {
      expect(cles.has(attendue), `la carte ignore « ${attendue} »`).toBe(true);
    }
  });

  it('chaque écran porte ses DEUX libellés', () => {
    // La console est bilingue. Un libellé anglais vide ferait répondre le bot en français à un client
    // anglophone, ou pire, lui nommerait un bouton qu'il ne trouvera pas à l'écran.
    for (const e of CARTE_CONSOLE) {
      expect(e.fr.trim(), `${e.cle} sans libellé français`).not.toBe('');
      expect(e.en.trim(), `${e.cle} sans libellé anglais`).not.toBe('');
    }
  });

  it('le CHEMIN d’un écran imbriqué nomme ses groupes, dans l’ordre', () => {
    // C'est ce qui permet au bot de dire « AI Agent > MBA > MBA, guide » plutôt que « MBA, guide », qui ne
    // se trouve pas dans un menu de quinze entrées.
    const guide = CARTE_CONSOLE.find((e) => e.cle === 'mba-guide');
    expect(guide?.chemin).toEqual(['AI Agent', 'MBA']);
    // Et une entrée de premier niveau n'a aucun groupe, plutôt qu'un tableau avec une chaîne vide.
    expect(CARTE_CONSOLE.find((e) => e.cle === 'accueil')?.chemin).toEqual([]);
  });
});

describe('qui voit quoi', () => {
  it('🔴 la règle d’accès est celle d’`AppShell`, et ce test casse le jour où elle bouge', () => {
    // La carte CALCULE `adminOnly` depuis cette règle au lieu de porter un drapeau par entrée : un drapeau
    // recopié finirait par contredire la vraie règle sans que rien ne le dise. Le prix de ce choix est ce
    // test : la règle vit dans un composant React, donc on la lit dans sa source.
    const shell = readFileSync(new URL('../web/components/AppShell.tsx', import.meta.url), 'utf8');
    expect(shell, "la règle d'accès de la console a changé : mettre `scripts/carte-console.ts` d'accord")
      .toContain("const adminOnly = active !== 'inbox';");
  });

  it('🔴 un agent ne voit QUE l’Inbox', () => {
    const vue = carteVisiblePar('agent');
    expect(vue.map((e) => e.cle)).toEqual(['inbox']);
  });

  it('un admin voit tout', () => {
    // Le miroir, sans quoi le test précédent passerait aussi sur une carte vide.
    expect(carteVisiblePar('admin')).toHaveLength(chargerCarte().length);
    expect(carteVisiblePar('admin').length).toBeGreaterThan(20);
  });

  it('⚠️ un rôle INCONNU voit le moins, jamais le plus', () => {
    // Un rôle ajouté plus tard, ou corrompu, ne doit pas ouvrir la console entière par défaut.
    expect(carteVisiblePar('manager').map((e) => e.cle)).toEqual(['inbox']);
    expect(carteVisiblePar('').map((e) => e.cle)).toEqual(['inbox']);
  });
});

describe('résoudre les clés rendues par le modèle', () => {
  it('🔴 une clé INVENTÉE ne produit aucun écran', () => {
    expect(resoudre(['campagnes', 'ecran-imaginaire'], 'admin').map((e) => e.cle)).toEqual(['campagnes']);
  });

  it('🔴 une clé RÉSERVÉE ne se résout pas pour un agent', () => {
    // Le modèle voit une carte filtrée, mais rien ne l'empêche de recracher une clé vue ailleurs dans la
    // conversation. Le filtrage est donc REFAIT ici, pas seulement à la présentation. Emmener un agent sur
    // un écran d'administrateur le ferait tomber sur un refus, ce qui est pire que de ne pas répondre.
    expect(resoudre(['campagnes'], 'agent')).toEqual([]);
    expect(resoudre(['campagnes'], 'admin')).toHaveLength(1);
  });

  it('⚠️ une clé répétée ne produit qu’UN lien', () => {
    // Le modèle se répète volontiers. Deux fois le même lien dans une réponse d'aide se remarque tout de
    // suite et fait mal paraître le produit.
    expect(resoudre(['campagnes', 'campagnes'], 'admin')).toHaveLength(1);
  });

  it('l’ordre du modèle est CONSERVÉ', () => {
    // Il cite le premier écran en premier parce que c'est là qu'on commence. Trier casserait le pas à pas.
    expect(resoudre(['workflows', 'campagnes'], 'admin').map((e) => e.cle)).toEqual(['workflows', 'campagnes']);
  });

  it('une liste vide rend une liste vide, sans jeter', () => {
    expect(resoudre([], 'admin')).toEqual([]);
  });
});
