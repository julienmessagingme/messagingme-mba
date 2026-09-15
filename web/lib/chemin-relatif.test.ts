import { describe, it, expect } from 'vitest';
import { lireChemin } from './chemin-relatif';

/** 🔴 LE CAS RÉEL (Julien, 2026-09-15) : l'adresse entière collée dans le champ « Chemin ». */
const BASE = 'https://ai.messagingme.app/api';

describe('un chemin qui recommence par l’adresse du système', () => {
  it('🔴 est reconnu, et ce qu’on propose est EXACTEMENT ce qui suit la base', () => {
    const r = lireChemin(`${BASE}/subscriber/add-tag`, BASE);
    expect(r.probleme).toBe('base-recopiee');
    expect(r.propose).toBe('/subscriber/add-tag');
  });

  it('⚠️ une base avec une barre finale donne le même résultat', () => {
    // Le client ne choisit pas comment il a saisi sa base, et les deux formes existent en production.
    expect(lireChemin(`${BASE}/subscriber/add-tag`, `${BASE}/`).propose).toBe('/subscriber/add-tag');
  });

  it('⚠️ l’adresse collée SANS rien derrière propose la racine, pas une chaîne vide', () => {
    // Un chemin vide serait refusé par le serveur (« chemin vide ») : proposer ça remplacerait une erreur
    // par une autre.
    expect(lireChemin(BASE, BASE).propose).toBe('/');
  });

  it('⚠️ les paramètres d’URL collés avec l’adresse survivent', () => {
    expect(lireChemin(`${BASE}?a=1`, BASE).propose).toBe('/?a=1');
  });
});

describe('un chemin qui porte une AUTRE adresse', () => {
  it('🔴 est signalé, mais RIEN n’est proposé : il n’y a rien à déduire', () => {
    // Proposer quoi que ce soit ici serait deviner. Le refus est la bonne réponse, il faut juste le dire tôt.
    const r = lireChemin('https://autre.test/x', BASE);
    expect(r.probleme).toBe('adresse-absolue');
    expect(r.propose).toBeNull();
  });

  it('🔴 `//hote` compte comme une adresse, exactement comme côté serveur', () => {
    // C'est le cas que le serveur refuse explicitement : rattaché en silence, `//evil.test/x` deviendrait un
    // segment de chemin que personne n'a voulu.
    expect(lireChemin('//evil.test/x', BASE).probleme).toBe('adresse-absolue');
  });
});

describe('ce qui ne pose aucun problème', () => {
  it('un vrai chemin relatif passe, avec ou sans barre de tête', () => {
    expect(lireChemin('/subscriber/add-tag', BASE)).toEqual({ probleme: null, propose: null });
    expect(lireChemin('subscriber/add-tag', BASE)).toEqual({ probleme: null, propose: null });
  });

  it('un chemin à variables passe : la forme `{ref}` n’est pas une adresse', () => {
    expect(lireChemin('/commandes/{ref}', BASE).probleme).toBeNull();
  });

  it('⚠️ un système SANS adresse ne fait rien planter', () => {
    // Un écran qui lèverait parce qu'un système n'a pas encore d'adresse serait pire que le problème.
    expect(lireChemin('/x', '')).toEqual({ probleme: null, propose: null });
    expect(lireChemin('https://autre.test/x', '').probleme).toBe('adresse-absolue');
  });

  it('⚠️ un chemin vide ne signale rien : il est vide, pas fautif', () => {
    expect(lireChemin('   ', BASE)).toEqual({ probleme: null, propose: null });
  });
});
