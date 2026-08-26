import { describe, expect, it } from 'vitest';
import { rcsOutboundSchema } from '../src/rcs/schema';

// Garde du bump zod. La seule difference de comportement entre les versions candidates est la
// normalisation d URL au parse : zod 4.0 (et le sous-chemin zod/v4 de 3.25.76) reecrit l URL,
// 3.25.76 et 4.1+ la rendent verbatim. Comme la valeur PARSEE est persistee puis relue par
// parseStoredRcsOutbound (qui rend null sur echec), une reecriture rendrait un visuel de campagne
// illisible en silence. Ce test tombe au rouge sur toute version normalisatrice.
describe('garde du bump zod', () => {
  it('rend une URL de media VERBATIM, sans normalisation', () => {
    const url = 'https://CDN.Exemple.FR:443/ete photo.png';
    const r = rcsOutboundSchema.safeParse({
      kind: 'card',
      card: { title: 'Ete', mediaUrl: url },
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data).toMatchObject({ card: { mediaUrl: url } });
  });
});
