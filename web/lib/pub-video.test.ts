import { describe, it, expect } from 'vitest';
import { cadrageDe, dureeTropLongue, morceauSuivant, refusVideo, typeVideoDe, TAILLE_VIDEO_MAX } from './pub-video';

/**
 * LE CONTRÔLE D'UNE VIDÉO AVANT L'ENVOI : 100 Mo, 60 secondes, MP4 ou MOV.
 *
 * 🔴 Ce que ces cas défendent : une vidéo qui sera refusée n'est pas envoyée (cent mégaoctets pour rien), et une
 * vidéo dont on ne sait pas lire la durée n'est pas laissée passer, parce que ce contrôle est le seul qui tienne la
 * règle des 60 secondes quand le fichier ne porte pas sa durée au début.
 */

const MP4 = { type: 'video/mp4', name: 'pub.mp4', size: 20 * 1024 * 1024 };

describe('le contrôle avant l’envoi', () => {
  it('une vidéo de 20 Mo et 30 secondes passe', () => {
    expect(refusVideo(MP4, 30)).toBeNull();
  });

  it('🔴 au-delà de 100 Mo : refusée, et exactement 100 Mo passe', () => {
    expect(refusVideo({ ...MP4, size: TAILLE_VIDEO_MAX + 1 }, 30)).toBe('taille');
    expect(refusVideo({ ...MP4, size: TAILLE_VIDEO_MAX }, 30)).toBeNull();
  });

  it('🔴 au-delà de 60 secondes : refusée ; 60,3 s (un « 60 s » de téléphone) passe', () => {
    expect(refusVideo(MP4, 61)).toBe('duree');
    expect(refusVideo(MP4, 60.3)).toBeNull();
    expect(dureeTropLongue(60.6)).toBe(true);
  });

  it('🔴 une durée ILLISIBLE est un refus, pas un feu vert', () => {
    for (const d of [null, Number.NaN, Number.POSITIVE_INFINITY, 0]) {
      expect(refusVideo(MP4, d), String(d)).toBe('duree_illisible');
    }
  });

  it('un fichier qui n’est pas une vidéo MP4 ou MOV est refusé avant tout le reste', () => {
    expect(refusVideo({ type: 'video/webm', name: 'a.webm', size: 10 }, 10)).toBe('type');
    expect(refusVideo({ type: 'image/png', name: 'a.png', size: TAILLE_VIDEO_MAX + 1 }, null)).toBe('type');
  });
});

describe('le type d’une vidéo', () => {
  it('lu sur ce qu’annonce le navigateur', () => {
    expect(typeVideoDe({ type: 'video/mp4', name: 'x' })).toBe('video/mp4');
    expect(typeVideoDe({ type: 'video/quicktime', name: 'x' })).toBe('video/quicktime');
  });

  it('⚠️ à défaut de type annoncé, sur l’extension (un .mov arrive parfois sans type)', () => {
    expect(typeVideoDe({ type: '', name: 'Tournage.MOV' })).toBe('video/quicktime');
    expect(typeVideoDe({ type: '', name: 'a.m4v' })).toBe('video/mp4');
    expect(typeVideoDe({ type: '', name: 'a.avi' })).toBeNull();
  });

  it('🔴 un type annoncé AUTRE ne se rattrape pas par l’extension', () => {
    expect(typeVideoDe({ type: 'text/html', name: 'piege.mp4' })).toBeNull();
  });
});

describe('le conseil de cadrage (jamais un refus)', () => {
  it('9:16 est vertical, 4:5 est le fil, le reste est autre', () => {
    expect(cadrageDe(1080, 1920)).toBe('vertical');
    expect(cadrageDe(1080, 1918)).toBe('vertical');
    expect(cadrageDe(1080, 1350)).toBe('fil');
    expect(cadrageDe(1920, 1080)).toBe('autre');
    expect(cadrageDe(0, 0)).toBeNull();
  });
});

describe('le morceau suivant', () => {
  it('rend ce que Meta demande', () => {
    expect(morceauSuivant(null, { debut: 0, fin: 100 }, 300)).toEqual({ debut: 0, fin: 100 });
    expect(morceauSuivant({ debut: 0, fin: 100 }, { debut: 100, fin: 300 }, 300)).toEqual({ debut: 100, fin: 300 });
  });

  it('des décalages égaux : tout est reçu', () => {
    expect(morceauSuivant({ debut: 100, fin: 300 }, { debut: 300, fin: 300 }, 300)).toBe('fini');
  });

  it('🔴 un Meta qui n’avance plus, ou qui demande au-delà du fichier : on s’arrête au lieu de boucler', () => {
    expect(morceauSuivant({ debut: 100, fin: 200 }, { debut: 100, fin: 200 }, 300)).toBeNull();
    expect(morceauSuivant(null, { debut: 0, fin: 400 }, 300)).toBeNull();
  });

  it('🔴 une réponse sans décalages n’est PAS « tout est reçu » : deux `undefined` égaux ne closent rien', () => {
    const vide = {} as { debut: number; fin: number };
    expect(morceauSuivant({ debut: 0, fin: 100 }, vide, 300)).toBeNull();
    expect(morceauSuivant(null, { debut: Number.NaN, fin: Number.NaN }, 300)).toBeNull();
  });
});
