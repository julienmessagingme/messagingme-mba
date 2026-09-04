import { describe, it, expect } from 'vitest';
import { organisationSchema, messageChannelSchema, messageSchema } from '../src/channels-me/types';

/**
 * Les schemas de ce qui vient de Channels Me.
 *
 * Ce que ces tests protegent, et qui ne se voit pas a la lecture :
 *  1. 🔴 Un message sans identifiant est REFUSE. Sans ce refus, une publication reussie serait tracee avec
 *     un `cm_message_id` vide, et le post, qui circule pour toujours, n'aurait plus de lien avec le jeton
 *     qui le declenche.
 *  2. Une cle inconnue est RETIREE, pas refusee : un champ ajoute chez eux ne doit ni casser la console
 *     ni traverser jusqu'a nos ecrans.
 *  3. Un identifiant entier et un identifiant chaine donnent la MEME forme en sortie, parce que la colonne
 *     qui le recoit est un `text` et que deux formes obligeraient chaque lecteur a s'en souvenir.
 */

describe('messageSchema', () => {
  it('🔴 refuse un message sans identifiant', () => {
    expect(messageSchema.safeParse({ text: 'bonjour' }).success).toBe(false);
  });

  it('range un identifiant entier en chaine et retire les cles inconnues', () => {
    const p = messageSchema.safeParse({ id: 4242, text: 'bonjour', champ_ajoute_chez_eux: 'jete' });
    expect(p.success).toBe(true);
    expect(p.success && p.data).toEqual({ id: '4242', text: 'bonjour' });
  });

  it('tolere les champs de statut absents ou nuls', () => {
    const p = messageSchema.safeParse({ id: 'msg_1', text: null, media_url: null, status: null, published_at: null });
    expect(p.success).toBe(true);
    expect(p.success && p.data.id).toBe('msg_1');
  });
});

describe('messageChannelSchema', () => {
  it('lit le compteur de publications et retire le reste', () => {
    const p = messageChannelSchema.safeParse({ id: 'ch_1', name: 'Ma chaine', messages_count: 85, autre: 1 });
    expect(p.success && p.data).toEqual({ id: 'ch_1', name: 'Ma chaine', messages_count: 85 });
  });

  it('refuse un compteur negatif', () => {
    expect(messageChannelSchema.safeParse({ messages_count: -1 }).success).toBe(false);
  });
});

describe('organisationSchema', () => {
  it('accepte un corps partiel : aucun champ n a ete mesure comme obligatoire', () => {
    expect(organisationSchema.safeParse({}).success).toBe(true);
  });

  it('refuse un champ present mais du mauvais type', () => {
    expect(organisationSchema.safeParse({ name: 42 }).success).toBe(false);
  });
});
