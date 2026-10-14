import { describe, it, expect } from 'vitest';
import { imageDessinable } from './image-dessinable';

describe('imageDessinable', () => {
  it('rend une adresse https, sans ses espaces, quelle que soit la casse du protocole', () => {
    expect(imageDessinable(' https://cdn.exemple.fr/a.jpg ')).toBe('https://cdn.exemple.fr/a.jpg');
    expect(imageDessinable('HTTPS://cdn.exemple.fr/a.jpg')).toBe('HTTPS://cdn.exemple.fr/a.jpg');
  });

  it('refuse ce que la CSP de la console ne laisserait pas charger', () => {
    for (const url of ['http://cdn.exemple.fr/a.jpg', '/m/a.jpg', 'cdn.exemple.fr/a.jpg', '', '   ']) {
      expect(imageDessinable(url), url).toBeNull();
    }
  });
});
