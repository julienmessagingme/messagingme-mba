import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lireJetonDeTest } from '../src/workflow/test-token';

/**
 * PARITÉ : ce que le NAVIGATEUR compose, et ce que le SERVEUR sait lire.
 *
 * 🔴 POURQUOI CE TEST VIT À LA RACINE, ET PAS DANS `web/e2e` (correction de la revue finale, 2026-09-16).
 * La première version de cette vérification était une copie de l'expression régulière du serveur, posée dans
 * `web/e2e/workflow-test-node.spec.ts`, avec un commentaire affirmant « si les deux divergent un jour, c'est
 * ICI que ça se verra ». C'était faux dans le seul sens qui compte : `ci-web.yml` ne déclenche ce job que sur
 * `web/**`, donc un commit qui resserre la lecture dans `src/workflow/test-token.ts` ne lançait PAS ce test,
 * et la copie restait large, donc verte. Les tests de parité de la racine, eux, tournent sur tous les pushs et
 * ont le droit de lire des fichiers de `web/` : c'est le motif que ce dépôt utilise déjà pour les mêmes cas.
 *
 * ⚠️ Et ce test importe la VRAIE lecture au lieu d'en recopier la forme. Une copie ne peut pas diverger si
 * elle n'existe pas.
 */

const PAGE = readFileSync(join(process.cwd(), 'web', 'app', 'workflows', 'page.tsx'), 'utf8');

describe('le mot composé par le navigateur est lisible par le serveur', () => {
  it('🔴 le navigateur colle l’identifiant du bloc TEL QUEL, sans transformation', () => {
    // Toute normalisation (retirer les tirets, tronquer, mettre en minuscules) serait un invariant partagé de
    // part et d'autre d'une frontière que ce dépôt interdit de franchir : aucun fichier de `web/` n'importe
    // `src/`, donc elle serait recopiée à la main des deux côtés et finirait par diverger.
    expect(PAGE).toContain('const mot = nodeId ? `${link.token}.${nodeId}` : link.token;');
  });

  it('🔴 les identifiants que le CONSTRUCTEUR produit voyagent tous', () => {
    // `uid()` (`web/components/WorkflowBuilder.tsx`) rend un `crypto.randomUUID()`, ou `id-<base36>-<horodatage>`
    // quand cette fonction n'existe pas (contexte non sécurisé).
    for (const id of ['0f7c9a21-4d3e-4b18-9a55-1c2e3f4a5b6c', 'id-k3f9x2p-1758012345678']) {
      expect(lireJetonDeTest(`test-a7k2m9p3.${id}`), id).toEqual({ jeton: 'test-a7k2m9p3', nodeId: id });
    }
  });

  it('🔴 et ceux que le SCHÉMA permet aussi, parce qu’il ne contraint rien', () => {
    // `parseGraph` (`src/workflow/graph.ts`) accepte n'importe quelle chaîne non vide comme `node.id`. Un
    // identifiant hors d'une classe supposée faisait autrefois rendre `null` à la lecture, donc le message
    // n'était pas CONSOMMÉ et descendait jusqu'à l'agent de Meta, qui répondait au testeur. Le refus doit
    // rester en aval, où il est lisible et tracé.
    for (const id of ['Bloc-Majuscule', 'n:2', 'étape-1', 'a'.repeat(300), 'deux.points']) {
      expect(lireJetonDeTest(`test-a7k2m9p3.${id}`), id).toEqual({ jeton: 'test-a7k2m9p3', nodeId: id });
    }
  });

  it('⚠️ la seule forme qui ne voyage pas est celle qui porte une espace, et elle est DITE', () => {
    // Les espaces sont retirés partout (WhatsApp en ajoute, un copier-coller en laisse). Un identifiant qui en
    // contient arrive donc amputé : il ne correspond à aucun bloc, et `runFrom` le refuse avec sa raison.
    // Ce qu'on garantit ici, c'est que ça reste un REFUS et jamais une fuite : la lecture rend un jeton.
    expect(lireJetonDeTest('test-a7k2m9p3.mon bloc')).toEqual({ jeton: 'test-a7k2m9p3', nodeId: 'monbloc' });
  });
});
