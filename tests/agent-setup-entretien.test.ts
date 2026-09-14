import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  auteurDuTour, bornerPourModele, lireEtat, MAX_TOURS_CONSERVES,
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

/**
 * 🔴 CE QUE LA REVUE DU LOT A A TROUVÉ, ET QUI ANNULAIT LA TÂCHE ENTIÈRE.
 *
 * La route construisait l'état ÉCRIT à partir du fil BORNÉ (`historique`), pas du fil complet : la
 * troncature était donc seulement DÉPLACÉE de l'écriture vers la construction du prompt, jamais supprimée.
 * La base recevait un fil amputé à chaque tour, et « le fil perdure » était faux.
 *
 * ⚠️ NI LE COMPILATEUR NI UN TEST NE POUVAIENT LE VOIR : les deux tableaux ont exactement le même type, et
 * un test qui monte un faux store voit ce que le faux lui rend. Seule une relecture qui SUIT la donnée l'a vu.
 */
describe('le fil ÉCRIT n’est pas le fil ENVOYÉ', () => {
  it('🔴 la route écrit le fil COMPLET, pas sa version bornée', () => {
    const src = readFileSync(resolve(__dirname, '../src/http/agent-setup.ts'), 'utf8');
    // Le fil complet part de `avant.messages`, jamais de `bornerPourModele(...)`.
    expect(src).toContain('const filComplet: TourEntretien[] = [...avant.messages');
    // Et c'est LUI que l'état écrit reprend.
    expect(src).toContain('messages: [...filComplet');
    // ⚠️ La garde qui compte : l'état écrit ne doit JAMAIS repartir de `historique`.
    expect(src).not.toContain('messages: [...historique');
  });

  it('🔴 l’écran ne reçoit pas le fil entier : une réponse HTTP ne grossit pas sans fin', () => {
    const src = readFileSync(resolve(__dirname, '../src/http/agent-setup.ts'), 'utf8');
    expect(src).toContain('MAX_MESSAGES_AFFICHES');
    // Le total part avec, sinon l'écran laisserait croire que le reste n'existe plus.
    expect(src).toContain('total: entretien.messages.length');
  });

  it('🔴 l’auteur de chaque message est CONSERVÉ, pas seulement déclaré', () => {
    const store = readFileSync(resolve(__dirname, '../src/agent/setup/entretien-store.pg.ts'), 'utf8');
    // Une colonne ajoutée que personne n'écrit ni ne lit est une capacité câblée sur zéro consommateur.
    expect(store).toContain('auteurs = excluded.auteurs');
    expect(store).toMatch(/select messages, reponses, poses, bascules, auteurs/);
  });

  it('⚠️ un fil d’avant la migration se relit sans auteurs, et n’en invente pas', () => {
    const relu = lireEtat({ messages: [{ role: 'user', content: 'x' }], reponses: [], poses: [], bascules: [] });
    expect(relu.auteurs).toEqual([]);
    expect(auteurDuTour(relu, 0)).toBeNull();
  });
});
