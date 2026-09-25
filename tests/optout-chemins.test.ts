import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * L'INVENTAIRE DES CHEMINS PAR LESQUELS UN MESSAGE PEUT SORTIR.
 *
 * 🔴 CE FICHIER NE PRODUIT AUCUNE FONCTIONNALITÉ, IL PRODUIT UNE LISTE, ET C'EST LA PIÈCE LA PLUS
 * IMPORTANTE DU CHANTIER. Mesuré le 2026-09-13 : `optInAllows` n'était appelée QUE dans
 * `src/campaign/build.ts` et `src/api/sends-build.ts`. Un scénario, une automation ou un agent IA
 * atteignaient donc quelqu'un qui avait écrit STOP. La question n'est pas « le test passe-t-il ? », c'est
 * « a-t-on trouvé TOUS les chemins ? », et une liste écrite à la main dérive dès qu'on en ajoute un.
 *
 * 🔴 LA LISTE EST DONC DÉRIVÉE DU CODE, pas recopiée : on cherche les appels RÉELS aux méthodes d'envoi, et
 * tout fichier qui en porte doit être CLASSÉ ici. Un chemin neuf non classé rend ce test rouge, ce qui est
 * le seul moment où quelqu'un se posera la question.
 *
 * Décision de Julien du 2026-09-13 : **tout sauf la réponse manuelle d'un opérateur.** La raison de
 * l'exception est celle qui la rend juste, et elle doit survivre à ce fichier : sans elle, un opérateur ne
 * pourrait même plus accuser réception d'un opt-out, ni répondre à une réclamation posée juste après.
 * Bloquer l'humain qui traite la demande de la personne, au nom de cette même demande, serait absurde.
 * La machine se tait ; la personne peut encore répondre à la personne.
 */

/**
 * LES MÉTHODES QUI FONT VRAIMENT PARTIR UN MESSAGE, DÉRIVÉES DU CLIENT META LUI-MÊME.
 *
 * 🔴 ÉCRITE À LA MAIN, CETTE LISTE ÉTAIT DÉJÀ INCOMPLÈTE (relevé en revue le 2026-09-13) : elle citait six
 * méthodes quand le client en expose huit, et il manquait `sendCtaUrl`, `sendList`, `sendImage` et
 * `sendFlowMessage`. Le test passait quand même, parce que les fichiers concernés appelaient AUSSI
 * `sendText` ou `sendTemplate` : un fichier NEUF qui n'aurait employé que les quatre manquantes aurait
 * échappé au balayage, sans jamais faire rougir l'inventaire qui prétend rendre cela impossible.
 *
 * La liste se lit donc dans `src/meta/client.ts`. Ajouter une méthode d'envoi au client élargit
 * automatiquement le balayage, ce qui est exactement ce qu'on veut : c'est le client qui définit ce que
 * « envoyer » veut dire, pas ce fichier. `sendTo` s'y ajoute à la main, c'est le sender de canal (RCS),
 * qui n'est pas une méthode du client Meta.
 */
function methodesDEnvoi(): RegExp {
  const client = readFileSync(new URL('../src/meta/client.ts', import.meta.url), 'utf8');
  const noms = [...client.matchAll(/^\s*async (send[A-Za-z]+)\s*\(/gm)].map((m) => m[1]!);
  if (noms.length < 5) throw new Error('aucune méthode d’envoi lue dans le client Meta : le balayage ne garde plus rien');
  return new RegExp(`\\.(${[...new Set([...noms, 'sendTo'])].join('|')})\\s*\\(`);
}
const METHODES = methodesDEnvoi();

/** Ce que devient un chemin : bloqué par un opt-out, ou exempté avec sa raison. */
type Verdict = 'bloque' | 'exempte' | 'delegue' | 'a_trancher';

/**
 * LA CLASSIFICATION, chemin par chemin.
 *
 * ⚠️ `delegue` n'est PAS une exemption : c'est un fichier qui passe la main à un autre, lequel porte la
 * garde. Le distinguer évite qu'on aille poser une seconde garde là où elle serait redondante, et surtout
 * qu'on prenne une délégation pour une décision.
 */
const CLASSEMENT: Record<string, { verdict: Verdict; pourquoi: string }> = {
  'src/campaign/engine.ts': {
    verdict: 'bloque',
    pourquoi: 'Deux moments, deux questions. À la CONSTRUCTION de la liste (`src/campaign/build.ts`, '
      + '`optInAllows`), qui peut recevoir cette campagne. Au moment d’ENVOYER, la réclamation du destinataire '
      + '(`PgRecipientStore.claim`) relit la fiche : un STOP ou un blocage posés depuis rendent un écart, que le '
      + 'moteur marque `skipped` avec son motif (`MOTIF_ECART_A_L_ENVOI`). 🔴 CE CHEMIN ÉTAIT CLASSÉ « délégué » '
      + 'avec l’argument qu’une liste purgée suffisait, et c’était faux dès qu’un envoi s’étale (débit bas, pause, '
      + 'heures ouvrées) : quelqu’un qui disait STOP entre-temps recevait quand même le message. Relevé par la '
      + 'revue finale de l’API publique, le 2026-09-25.',
  },
  'src/campaign/sender.ts': {
    verdict: 'delegue',
    pourquoi: 'Sender de canal RCS : il envoie ce que le moteur lui donne, à qui le moteur lui dit, et le moteur '
      + 'porte la garde (construction de la liste, puis réclamation au moment d’envoyer).',
  },
  'src/workflow/executor.ts': {
    verdict: 'delegue',
    pourquoi: 'L’exécuteur n’appelle jamais Meta : il appelle ses dépendances, que `src/workflow/wiring.ts` '
      + 'fournit. C’est là que la garde est posée, une fois, pour le scénario, l’automation et l’agent IA.',
  },
  'src/workflow/wiring.ts': {
    verdict: 'bloque',
    pourquoi: '🔴 LE POINT DE PASSAGE DES ENVOIS D’UN PARCOURS (scénario, automation) : la garde est posée '
      + 'une fois dans `WorkflowExecutor.apply`, là où trois gardes auraient divergé. '
      + '⚠️ CETTE RAISON A DIT « ET AGENT IA », ET C’ÉTAIT FAUX : la réponse d’un agent part par '
      + '`envoyerTexteAgent`, qui appelle `client.sendText` DIRECTEMENT, sans passer par l’exécuteur. '
      + 'L’agent a donc sa propre garde, au rang de ses plafonds, dans `src/agent/run-turn.ts`. '
      + '🔴 LA LEÇON EST SUR CE TEST LUI-MÊME : un inventaire prouve que la LISTE est complète, jamais que '
      + 'les VERDICTS sont justes. Celui-ci a été écrit par la même main que la garde, dans la même heure, '
      + 'depuis la même croyance. Un verdict se MESURE en suivant l’appel, il ne se déduit pas d’un voisinage.',
  },
  'src/index.ts': {
    verdict: 'bloque',
    pourquoi: 'TROIS ENVOIS DE NATURES DIFFÉRENTES DANS LE MÊME FICHIER, tranchés par Julien le 2026-09-13. '
      + '(1) La réponse manuelle de l’Inbox : EXEMPTÉE, sans quoi un opérateur ne pourrait même plus accuser '
      + 'réception d’un opt-out. (2) L’envoi d’un MODÈLE depuis l’Inbox : un modèle n’est pas une réponse, il '
      + 'ROUVRE une conversation fermée, donc le MARKETING est refusé et le SERVICE passe, sur la catégorie '
      + 'lue chez Meta et jamais dans le corps de la requête. (3) La réponse d’un agent tiers par MCP : '
      + 'BLOQUÉE, c’est une machine. La garde vit dans `src/inbox/repondre.ts`, visant la seule origine '
      + '`mcp` : c’est l’asymétrie de câblage qui fait l’exemption de l’opérateur.',
  },
};

/** Parcourt `src/` et rend les fichiers qui portent un appel d'envoi réel. */
function cheminsDEnvoi(): string[] {
  const racine = new URL('../src', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const trouves: string[] = [];
  const visiter = (dossier: string): void => {
    for (const nom of readdirSync(dossier)) {
      const complet = join(dossier, nom);
      if (statSync(complet).isDirectory()) { visiter(complet); continue; }
      if (!nom.endsWith('.ts')) continue;
      // ⚠️ `src/meta/` est le CLIENT lui-même : il définit ces méthodes, il ne les appelle pas sur
      // quelqu'un d'autre. L'y chercher classerait la porte de sortie comme un chemin de plus.
      const rel = relative(racine, complet).split('\\').join('/');
      if (rel.startsWith('meta/')) continue;
      if (METHODES.test(readFileSync(complet, 'utf8'))) trouves.push(`src/${rel}`);
    }
  };
  visiter(racine);
  return trouves.sort();
}

describe('les chemins d’envoi sont tous classés', () => {
  it('🔴 tout chemin d’envoi est CLASSÉ : bloqué par un opt-out, ou explicitement exempté', () => {
    const chemins = cheminsDEnvoi();
    // Garde-fou du garde-fou : si le balayage ne trouve plus rien, ce test ne garde plus rien non plus.
    expect(chemins.length, 'aucun chemin d’envoi trouvé : le balayage ne garde plus rien').toBeGreaterThan(3);
    const nonClasses = chemins.filter((c) => !(c in CLASSEMENT));
    expect(nonClasses, `chemin(s) d’envoi NON CLASSÉ(S) : ${nonClasses.join(', ')}. `
      + 'Un message peut en partir : dire s’il doit respecter un opt-out, et pourquoi.').toEqual([]);
  });

  it('⚠️ et la classification ne décrit aucun chemin DISPARU', () => {
    // L'autre sens : une entrée qui ne correspond plus à rien laisse croire qu'un chemin est gardé alors
    // qu'il n'existe plus, et masque le fait que son remplaçant, lui, ne l'est pas.
    const chemins = new Set(cheminsDEnvoi());
    const fantomes = Object.keys(CLASSEMENT).filter((c) => !chemins.has(c));
    expect(fantomes, `entrée(s) de classification sans chemin réel : ${fantomes.join(', ')}`).toEqual([]);
  });

  it('chaque classement porte une RAISON, pas seulement un verdict', () => {
    // Un verdict sans raison est un avis ; c'est la raison qui permet de le contester dans six mois.
    for (const [chemin, c] of Object.entries(CLASSEMENT)) {
      expect(c.pourquoi.length, `« ${chemin} » est classé sans raison lisible`).toBeGreaterThan(60);
    }
  });

  /**
   * 🔴 CE QUI EXISTAIT AVANT CE CHANTIER, ET QUI DOIT RESTER. Les deux appels d'origine d'`optInAllows`
   * sont la référence : les perdre en ajoutant les autres serait le pire des résultats.
   */
  it('🔴 la campagne et l’API publique appellent TOUJOURS `optInAllows`', () => {
    for (const f of ['../src/campaign/build.ts', '../src/api/sends-build.ts']) {
      const src = readFileSync(new URL(f, import.meta.url), 'utf8');
      expect(src, `${f} n’appelle plus optInAllows`).toMatch(/optInAllows\s*\(/);
    }
  });

  /**
   * 🔴 LE VERDICT `bloque` DU MOTEUR DE CAMPAGNE TIENT À LA RÉCLAMATION, et une réclamation qui cesserait de lire
   * la fiche le rendrait faux sans qu'aucun inventaire ne rougisse. Son SQL est tenu en intégration
   * (`PgRecipientStore.claim`), le traitement de l'écart par `tests/campaign-engine.test.ts` ; ce cas tient le
   * lien entre les deux, sur les fichiers réels.
   */
  it('🔴 la réclamation d’un destinataire relit le STOP et le blocage, et le moteur écarte ce qu’elle signale', () => {
    const store = readFileSync(new URL('../src/campaign/store.pg.ts', import.meta.url), 'utf8');
    const claim = store.slice(store.indexOf('async claim(id: string)'), store.indexOf('async reclaimStale('));
    expect(claim).toMatch(/opt_in_status = 'opted_out' then 'desabonne'/);
    expect(claim).toMatch(/blocked_at is not null then 'bloque'/);
    const moteur = readFileSync(new URL('../src/campaign/engine.ts', import.meta.url), 'utf8');
    // Les deux sites de réclamation du moteur traitent l'écart, et aucun ne réduit la réservation à un booléen.
    expect(moteur.match(/MOTIF_ECART_A_L_ENVOI\[reserve\.ecart\]/g)).toHaveLength(2);
    expect(moteur).not.toMatch(/!\(await deps\.recipients\.claim\(/);
  });
});
