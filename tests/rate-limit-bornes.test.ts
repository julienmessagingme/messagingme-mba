import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { RateLimiter } from '../src/auth/rate-limit';

/**
 * LES DEUX BORNES DES LIMITEURS D'AUTHENTIFICATION (audit de surface publique du 2026-09-03).
 *
 * 🔴 Un limiteur de débit garde une table EN MÉMOIRE, indexée par une clé que l'APPELANT choisit. Deux façons
 * de la faire déborder, et les six limiteurs d'`auth/routes.ts` étaient exposés aux deux : le NOMBRE de clés
 * (rien ne le plafonnait, et `prune()` ne retire que les entrées EXPIRÉES, donc rien sous flot soutenu) et la
 * TAILLE d'une clé (`/auth/google` passait le jeton Google entier, environ un kilo-octet par tentative).
 *
 * L'ironie du premier défaut : le module `rate-limit.ts` prescrit lui-même ce plafond « dès que la clé est
 * choisie par l'appelant », et aucun des six ne le posait.
 */
describe('limiteur : le plafond de clés', () => {
  const horloge = () => 1_000;

  it('🔴 table pleine : une clé NEUVE est refusée', () => {
    const l = new RateLimiter(10, 60_000, horloge, 3);
    expect(l.take('a')).toBe(true);
    expect(l.take('b')).toBe(true);
    expect(l.take('c')).toBe(true);
    // La quatrième clé distincte n'entre pas : on échange une fuite de mémoire contre un refus, qui est le
    // bon comportement sous attaque.
    expect(l.take('d')).toBe(false);
  });

  it('🔴 mais les clés DÉJÀ CONNUES continuent d’être servies', () => {
    // La moitié qui compte : sous attaque, les utilisateurs en cours ne doivent pas être pris en otage par
    // le robot qui remplit la table.
    const l = new RateLimiter(10, 60_000, horloge, 2);
    expect(l.take('julien')).toBe(true);
    expect(l.take('autre')).toBe(true);
    expect(l.take('robot')).toBe(false); // table pleine
    expect(l.take('julien')).toBe(true); // lui passe toujours
  });

  it('sans plafond, le comportement d’origine est conservé', () => {
    // La valeur par défaut est 0, donc les appelants qui ne le posent pas ne changent pas de comportement.
    const l = new RateLimiter(10, 60_000, horloge);
    for (let i = 0; i < 50; i += 1) expect(l.take(`k${i}`)).toBe(true);
  });
});

describe('limiteurs d’authentification : le câblage', () => {
  const source = readFileSync(new URL('../src/auth/routes.ts', import.meta.url), 'utf8');
  const sansCommentaires = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('🔴 les SIX limiteurs portent le plafond de clés, sans exception', () => {
    // Ancré sur la construction entière : un `toMatch` sur le seul nom de la constante passerait aussi si
    // elle n'était posée que sur un limiteur sur six.
    const constructions = sansCommentaires.match(/new RateLimiter\([^)]*\)/g) ?? [];
    expect(constructions.length, 'six limiteurs sont attendus dans ce fichier').toBe(6);
    const sansPlafond = constructions.filter((c) => !c.includes('MAX_CLES'));
    expect(sansPlafond, `ces limiteurs n’ont pas de plafond de clés : ${sansPlafond.join(' | ')}`).toEqual([]);
  });

  it('🔴 un discriminant trop long est remplacé par son empreinte', () => {
    // Le cas de `/auth/google`, qui passait le jeton entier. L'empreinte discrimine aussi bien et occupe
    // 64 caractères quoi qu'on lui donne.
    expect(sansCommentaires, 'rateKey doit borner la taille du discriminant')
      .toMatch(/createHash\('sha256'\)\.update\(discriminant\)\.digest\('hex'\)/);
    expect(sansCommentaires, 'la borne doit être une constante nommée, pas un nombre perdu dans le code')
      .toMatch(/discriminant\.length <= MAX_DISCRIMINANT/);
  });
});
