import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { FastifyReply } from 'fastify';
import { RateLimiter, avertissementBorne, consommerAvecEntetes } from '../src/auth/rate-limit';

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

/**
 * 🔴 UN PLAFOND À 0 VEUT DIRE « DÉSACTIVÉ », ET CE N'ÉTAIT PAS LE CAS.
 *
 * La configuration documente `0` comme le levier d'urgence (`API_KEY_PREFILTRE_MAX`, et la convention de tout
 * le dépôt). Le limiteur, lui, laissait passer le PREMIER appel d'une fenêtre puis refusait tous les suivants :
 * le levier qui devait libérer l'API la coupait. Relevé par le contre-audit du 2026-09-14, corrigé ici, dans le
 * limiteur lui-même, parce que quatre réglages de la configuration y aboutissent.
 */
describe('limiteur : un plafond à 0 le désactive', () => {
  const horloge = () => 1_000;

  it('🔴 à 0, tout passe, et pas seulement le premier appel', () => {
    const l = new RateLimiter(0, 60_000, horloge);
    for (let i = 0; i < 50; i += 1) expect(l.take('meme-cle'), `appel ${i + 1}`).toBe(true);
    for (let i = 0; i < 50; i += 1) expect(l.take(`cle-${i}`)).toBe(true);
  });

  it('un plafond négatif est traité comme 0, jamais comme un refus', () => {
    const l = new RateLimiter(-1, 60_000, horloge);
    expect(l.take('a')).toBe(true);
    expect(l.take('a')).toBe(true);
  });

  it('🔴 désactivé, il ne pose aucun en-tête de plafond et ne refuse jamais', async () => {
    // Des en-têtes `x-ratelimit-limit: 0` / `remaining: 0` sur un appel ACCEPTÉ diraient à un intégrateur
    // qu'il est à bout de quota alors qu'il n'y en a aucun.
    const entetes: Record<string, string> = {};
    let statut: number | null = null;
    const reply = {
      header(n: string, v: string) { entetes[n] = v; return this; },
      code(c: number) { statut = c; return this; },
      async send() { return this; },
    } as unknown as FastifyReply;
    const l = new RateLimiter(0, 60_000, horloge);
    for (let i = 0; i < 5; i += 1) expect(await consommerAvecEntetes(l, 'k', reply)).toBe(true);
    expect(statut).toBeNull();
    expect(entetes).toEqual({});
  });

  it('un plafond positif garde exactement son comportement', () => {
    const l = new RateLimiter(2, 60_000, horloge);
    expect(l.take('a')).toBe(true);
    expect(l.take('a')).toBe(true);
    expect(l.take('a')).toBe(false);
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

describe('l’avertissement borné d’un budget épuisé', () => {
  it('🔴 il journalise au plus une fois par fenêtre, jamais une ligne par requête', () => {
    let t = 0;
    const lignes: unknown[] = [];
    const avant = console.warn;
    console.warn = (...a: unknown[]) => { lignes.push(a); };
    try {
      const avertir = avertissementBorne('budget épuisé', 60_000, () => t);
      for (let i = 0; i < 100; i += 1) avertir();
      expect(lignes).toHaveLength(1);
      t = 59_999; avertir();
      expect(lignes).toHaveLength(1);
      t = 60_000; avertir();
      expect(lignes).toHaveLength(2);
    } finally {
      console.warn = avant;
    }
  });
});
