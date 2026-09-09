import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { BASE_QUEUES } from '../src/queue/names';

/**
 * L'HYGIÈNE DU MANUEL TECHNIQUE, tenue par un test plutôt que par la vigilance (2026-09-09).
 *
 * 🔴 CE QUE CES CAS FERMENT, et ce n'est pas de la cosmétique. L'audit du 2026-09-08 a mesuré cinq
 * affirmations vérifiablement FAUSSES dans la partie « courante » de `documentation.md` : l'hébergement du
 * front, le compteur de migrations, la liste des rôles, la rétention des webhooks, et le nombre de files.
 * Aucune n'était une faute d'inattention isolée : toutes étaient des faits DÉRIVABLES DU CODE, recopiés à la
 * main dans de la prose, et devenus faux au premier changement.
 *
 * Le remède n'est pas d'y faire attention. C'est de rendre la dérive MÉCANIQUEMENT visible, et de le faire
 * sur les trois formes qui ont réellement coûté :
 *   1. un compteur recopié (le nombre de files a été faux dans le manuel ET dans un commentaire du code) ;
 *   2. un lien mort (un manuel qui renvoie vers un fichier disparu se lit comme une erreur du lecteur) ;
 *   3. un titre DATÉ dans le manuel, qui le transforme lentement en archive. C'est exactement la dérive qui
 *      a fait passer 61,6 % du fichier en journal, et le fichier l'avait lui-même diagnostiquée pour `wip.md`
 *      (« un point d'entrée qui devient une archive cesse d'être un point d'entrée ») sans se l'appliquer.
 *
 * ⚠️ Ces contrôles portent sur le MANUEL, jamais sur l'archive : `docs/JOURNAL-TECHNIQUE.md` est faite de
 * récits datés et de chiffres d'époque, c'est sa raison d'être.
 */

const RACINE = resolve(__dirname, '..');
const MANUEL = 'documentation.md';
const lire = (f: string): string => readFileSync(join(RACINE, f), 'utf8');

/**
 * Les fichiers de doc dont les liens doivent résoudre. `README.md` en tête : c'est le PORTAIL, il n'est fait
 * que de liens, et un portail qui renvoie dans le vide est pire qu'un portail absent. Le journal en fait
 * partie lui aussi, puisqu'il pointe vers le manuel.
 */
const DOCS = ['README.md', MANUEL, 'CLAUDE.md', 'features.md', 'docs/JOURNAL-TECHNIQUE.md'];

describe('le manuel ne recopie aucun compteur calculable', () => {
  it('🔴 le nombre de files n’est écrit NULLE PART en chiffres', () => {
    // Le cas vécu : le manuel annonçait « sept files » et « quatorze avec les DLQ » quand il y en avait huit
    // et seize, et le commentaire de `ALL_QUEUES` répétait « 14 ». Un lecteur qui dimensionne sa supervision
    // sur ce chiffre surveille deux files de moins qu'il ne croit.
    const base = BASE_QUEUES.length;
    const avecDlq = base * 2;
    const texte = lire(MANUEL);
    const chiffres = new Map([
      [base, ['sept', 'huit', 'neuf', 'dix']],
      [avecDlq, ['quatorze', 'seize', 'dix-huit', 'vingt']],
    ]);
    for (const [n, mots] of chiffres) {
      // On cherche le nombre COLLÉ au mot « file », en chiffres comme en lettres : c'est la forme qui a dérivé.
      const motifs = [new RegExp(`\\b${n}\\s+files?\\b`, 'i'), ...mots.map((m) => new RegExp(`\\b${m}\\s+files?\\b`, 'i'))];
      for (const motif of motifs) {
        expect(motif.test(texte), `« ${motif.source} » est un compteur recopié : dériver de BASE_QUEUES`).toBe(false);
      }
    }
  });

  it('🔴 aucun numéro de migration n’est annoncé comme « la dernière »', () => {
    // Ce compteur a dérivé dans QUATRE documents. Le manuel renvoie vers CLAUDE.md et vers la base, il ne
    // porte pas le chiffre : le porter, c'est promettre de le tenir à jour à chaque migration.
    const texte = lire(MANUEL);
    const motifs = [/derni[èe]re migration\s*(du repo)?\s*:?\s*\*{0,2}0\d{3}/i, /prochaine libre\s*:?\s*\*{0,2}0\d{3}/i];
    for (const motif of motifs) {
      expect(motif.test(texte), `« ${motif.source} » : le compteur vit dans CLAUDE.md, jamais ici`).toBe(false);
    }
  });
});

describe('le manuel reste un MANUEL, pas une archive', () => {
  it('🔴 aucun titre daté ni marqueur d’étape', () => {
    // La dérive qui a fait passer 61,6 % du fichier en journal, une section à la fois. Ces contenus vont au
    // journal, au WIP ou au backlog ; ce qui reste ici est l'invariant, sans sa date de découverte.
    const interdits = ['DÉPLOYÉ', 'DEPLOYE', 'LIVRÉ', 'PROCHAINE ÉTAPE', 'EN ATTENTE', 'RESTE À FAIRE'];
    const titres = lire(MANUEL).split('\n').filter((l) => /^#{1,4}\s/.test(l));
    for (const titre of titres) {
      for (const mot of interdits) {
        expect(titre.toUpperCase().includes(mot), `titre « ${titre.trim()} » : ce contenu va au journal`).toBe(false);
      }
    }
  });

  it('la table des matières couvre toutes les sections de premier niveau', () => {
    // Une table des matières incomplète est pire que pas de table : elle laisse croire qu'on a tout vu.
    const texte = lire(MANUEL);
    const sections = [...texte.matchAll(/^## (\d+)\. (.+)$/gm)].map((m) => m[1]);
    expect(sections.length).toBeGreaterThan(5);
    for (const n of sections) {
      expect(new RegExp(`^${n}\\. \\[`, 'm').test(texte), `la section ${n} manque à la table des matières`).toBe(true);
    }
  });
});

describe('les liens locaux résolvent', () => {
  it('🔴 aucun lien Markdown ne pointe vers un fichier absent', () => {
    // Un manuel qui renvoie vers un fichier disparu se lit comme une erreur du LECTEUR, pas de l'auteur.
    const morts: string[] = [];
    for (const doc of DOCS) {
      /**
       * 🔴 L'ARCHIVE PORTE DEUX CONVENTIONS DE CHEMIN, et il faut les accepter toutes les deux.
       *
       * Son CORPS a été déplacé VERBATIM depuis `documentation.md`, qui vivait à la racine : ses liens
       * partent donc de la racine. Son EN-TÊTE, écrit après le déplacement, vit bien dans `docs/` et pointe
       * en `../`. Un lien est vivant s'il résout depuis l'une OU l'autre ; il n'est mort que s'il ne résout
       * de nulle part.
       *
       * Les deux tentatives précédentes ont échoué chacune d'un côté, et c'est le test qui l'a montré :
       * résoudre depuis `docs/` seul déclarait morts deux plans parfaitement présents à la racine, résoudre
       * depuis la racine seule déclarait morts les liens de l'en-tête.
       */
      const bases = doc.startsWith('docs/')
        ? [RACINE, dirname(join(RACINE, doc))]
        : [dirname(join(RACINE, doc))];
      for (const m of lire(doc).matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)) {
        const cible = m[1]!;
        // Seuls les chemins RELATIFS sont vérifiables : une URL externe n'est pas de notre ressort.
        if (/^(https?:|mailto:)/.test(cible)) continue;
        if (!bases.some((b) => existsSync(resolve(b, cible)))) morts.push(`${doc} -> ${cible}`);
      }
    }
    expect(morts, `liens morts :\n${morts.join('\n')}`).toEqual([]);
  });
});
