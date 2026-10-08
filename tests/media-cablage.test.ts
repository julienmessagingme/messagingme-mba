import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

/**
 * LA LECTURE D'UNE PIÈCE JOINTE N'EST PAS CONDITIONNÉE À LA TRANSCRIPTION (revue finale du 2026-09-19).
 *
 * 🔴 LE DÉFAUT ÉTAIT UN EMPLACEMENT DANS LE CÂBLAGE, pas une ligne de logique : `lireMediaMessage` vivait
 * dans le bloc `...(config.AI_GATEWAY_API_KEY && config.TRANSCRIPTION_MODELE ? { ... } : {})` de
 * `src/index.ts`, donc une instance sans modèle de transcription répondait 503 sur chaque photo. Aucun test de
 * fonction ne voit ça : la fonction est juste, c'est sa place qui était fausse.
 *
 * ⚠️ LE COMPILATEUR, PAS UNE RECHERCHE DE TEXTE. La première version cherchait la fin du bloc au premier
 * `} : {}),` suivant, et ce motif apparaît AUSSI dans un conditionnel imbriqué à l'intérieur du bloc : le
 * test restait vert avec le câblage remis dedans, ce que sa propre mutation a montré. Ici on lit l'arbre
 * syntaxique : la propriété ne doit avoir AUCUN ancêtre conditionnel dont la condition nomme la transcription.
 */
describe('le câblage de la lecture des pièces jointes', () => {
  const chemin = resolve(__dirname, '../src/index.ts');
  const fichier = ts.createSourceFile(chemin, readFileSync(chemin, 'utf8'), ts.ScriptTarget.Latest, true);

  /**
   * Les DÉFINITIONS de `lireMediaMessage` dans le câblage : une propriété qui porte une valeur (`lireMediaMessage: ...`)
   * ou une constante (`const lireMediaMessage = ...`). Depuis le lot 13, l'Inbox et l'API partagent UNE constante, que
   * leurs deux blocs reprennent en raccourci (`lireMediaMessage,`) : un raccourci n'est pas une définition.
   */
  function proprietes(): Array<ts.PropertyAssignment | ts.VariableDeclaration> {
    const trouvees: Array<ts.PropertyAssignment | ts.VariableDeclaration> = [];
    const visiter = (n: ts.Node): void => {
      if ((ts.isPropertyAssignment(n) || ts.isVariableDeclaration(n)) && n.name.getText(fichier) === 'lireMediaMessage') trouvees.push(n);
      ts.forEachChild(n, visiter);
    };
    visiter(fichier);
    return trouvees;
  }

  /** Les raccourcis `lireMediaMessage,` : chaque bloc qui la reçoit reprend la définition unique. */
  function raccourcis(): ts.ShorthandPropertyAssignment[] {
    const trouves: ts.ShorthandPropertyAssignment[] = [];
    const visiter = (n: ts.Node): void => {
      if (ts.isShorthandPropertyAssignment(n) && n.name.getText(fichier) === 'lireMediaMessage') trouves.push(n);
      ts.forEachChild(n, visiter);
    };
    visiter(fichier);
    return trouves;
  }

  /** Cette propriété est-elle sous un conditionnel dont la condition parle de la transcription ? */
  function sousLaTranscription(n: ts.Node): boolean {
    for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
      if (ts.isConditionalExpression(p) && p.condition.getText(fichier).includes('TRANSCRIPTION_MODELE')) return true;
    }
    return false;
  }

  it('🔴 `lireMediaMessage` est câblé une fois, et HORS du bloc de la transcription', () => {
    const trouvees = proprietes();
    expect(trouvees, 'lireMediaMessage n est plus câblé, ou l est deux fois').toHaveLength(1);
    expect(sousLaTranscription(trouvees[0]!), 'lireMediaMessage est RENTRÉ dans le bloc de la transcription').toBe(false);
    // Et aucun de ses deux lecteurs (l'Inbox, l'API) ne la reçoit sous la transcription.
    const lecteurs = raccourcis();
    expect(lecteurs).toHaveLength(2);
    for (const r of lecteurs) expect(sousLaTranscription(r)).toBe(false);
  });

  it('🔴 le câblage transmet la CONVERSATION de la route jusqu’à la relecture du message', () => {
    // Une flèche à deux paramètres reste assignable à un contrat qui en déclare trois : un câblage qui
    // avalerait `conversationId` compilerait, et la route ne ferait plus ce que dit son URL. On compte donc
    // les paramètres dans l'arbre. La relecture reçoit le dépôt lui-même : aucune flèche entre les deux ne peut
    // en avaler un.
    const definition = proprietes()[0]!.initializer;
    if (!definition) throw new Error('lireMediaMessage sans valeur');
    const cablage: ts.Expression = definition;
    expect(ts.isArrowFunction(cablage) && cablage.parameters.length).toBe(3);
    expect(ts.isArrowFunction(cablage) && ts.isCallExpression(cablage.body) && cablage.body.arguments.length).toBe(4);
    const trouver = (n: ts.Node, nom: string): ts.PropertyAssignment | undefined => {
      if (ts.isPropertyAssignment(n) && n.name.getText(fichier) === nom) return n;
      return ts.forEachChild(n, (c) => trouver(c, nom));
    };
    const messages = trouver(cablage, 'messages')?.initializer;
    expect(messages && ts.isIdentifier(messages)).toBe(true);
  });

  it('la garde voit bien le bloc de la transcription : `transcrireMessage` y est', () => {
    // Le témoin inverse. Sans lui, un bloc renommé rendrait `sousLaTranscription` toujours faux, et le cas
    // ci-dessus passerait sur n'importe quel câblage.
    const visiter = (n: ts.Node): ts.PropertyAssignment | undefined => {
      if (ts.isPropertyAssignment(n) && n.name.getText(fichier) === 'transcrireMessage') return n;
      return ts.forEachChild(n, visiter);
    };
    const transcrire = visiter(fichier);
    expect(transcrire).toBeDefined();
    expect(sousLaTranscription(transcrire!)).toBe(true);
  });
});
