import { describe, it, expect } from 'vitest';
import {
  bornerPourModele, lireEtat, MAX_TOURS_CONSERVES,
} from '../src/agent/setup/entretien-store';
import { MAX_TOURS_HISTORIQUE } from '../src/agent/setup/conversation';

/**
 * 🔴 LE FIL PERDURE : CE QU'ON CONSERVE N'EST PLUS CE QU'ON ENVOIE (2026-09-14).
 *
 * La borne était posée à l'ÉCRITURE (`PgEntretienStore.ecrire` appelait `bornerMessages`), donc les tours
 * anciens n'étaient pas seulement absents du contexte du modèle : ils étaient DÉTRUITS. Sa documentation
 * l'assumait (« un entretien long ne perd rien de ce qui compte, seulement sa transcription ancienne »), ce
 * qui était vrai d'un entretien qui se TERMINE et faux d'un fil qui perdure, où la transcription ancienne
 * est justement ce qu'on vient relire des semaines plus tard.
 */
describe('le fil conserve tout, le prompt reste borné', () => {
  const fil = (n: number) => Array.from({ length: n }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant', content: `tour ${i}`,
  }));

  it('🔴 la relecture ne TRONQUE plus un fil plus long que le contexte', () => {
    // Avant, `etatSchema` plafonnait `messages` à `MAX_TOURS_HISTORIQUE * 2` : un fil conservé au-delà
    // retombait sur l'entretien vierge à la relecture, c'est-à-dire que le client perdait sa conversation.
    const long = fil(MAX_TOURS_HISTORIQUE * 2 + 40);
    const relu = lireEtat({ messages: long, reponses: [], poses: [], bascules: [] });
    expect(relu.messages).toHaveLength(long.length);
    expect(relu.messages[0]?.content).toBe('tour 0');
  });

  it('⚠️ mais ce qui PART au modèle reste borné', () => {
    expect(bornerPourModele(fil(MAX_TOURS_HISTORIQUE * 2 + 40))).toHaveLength(MAX_TOURS_HISTORIQUE * 2);
  });

  it('⚠️ et ce sont les DERNIERS tours qui partent, pas les premiers', () => {
    const borne = bornerPourModele(fil(MAX_TOURS_HISTORIQUE * 2 + 3));
    expect(borne[borne.length - 1]?.content).toBe(`tour ${MAX_TOURS_HISTORIQUE * 2 + 2}`);
  });

  it('⚠️ un plafond de sécurité demeure : un jsonb ne grossit pas sans fin', () => {
    const enorme = fil(MAX_TOURS_CONSERVES + 10);
    // Au-delà, on retombe sur l'entretien vierge plutôt que d'écrire un document sans limite.
    expect(lireEtat({ messages: enorme }).messages).toHaveLength(0);
  });
});
