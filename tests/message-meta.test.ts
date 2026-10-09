import { describe, it, expect } from 'vitest';
import {
  apercuDuMessage, BORNES_META, corpsPourMeta, schemaContenuMeta, schemaMessageMeta, TYPES_MESSAGE_META,
} from '../src/api/message-meta';
import { messageDeForme } from '../src/api/forme';

/**
 * L'ENVOI AU FORMAT DE META (lot 13, domaine 2) : le corps de Meta tel quel, pour les types courants (décision de Julien
 * du 2026-10-09). Ce qui passe part TEL QUEL chez Meta : ce qui doit être refusé l'est ici, avec le champ fautif.
 */
const IMG = 'https://exemple.fr/colis.jpg';
const valide = (b: unknown) => schemaMessageMeta.safeParse(b).success;
const corps = (o: Record<string, unknown>) => ({ messaging_product: 'whatsapp', to: '33612345678', ...o });

const EXEMPLES: Record<string, Record<string, unknown>> = {
  text: { type: 'text', text: { body: 'Bonjour', preview_url: true } },
  image: { type: 'image', image: { link: IMG, caption: 'Votre colis' } },
  video: { type: 'video', video: { link: 'https://exemple.fr/v.mp4' } },
  audio: { type: 'audio', audio: { link: 'https://exemple.fr/a.ogg' } },
  document: { type: 'document', document: { link: 'https://exemple.fr/f.pdf', filename: 'facture.pdf' } },
  location: { type: 'location', location: { latitude: 48.85, longitude: 2.35, name: 'Boutique', address: 'Paris' } },
  reaction: { type: 'reaction', reaction: { message_id: 'wamid.x', emoji: '👍' } },
  interactive: {
    type: 'interactive',
    interactive: {
      type: 'button', header: { type: 'image', image: { link: IMG } }, body: { text: 'On le livre quand ?' },
      footer: { text: 'Messaging Me' },
      action: { buttons: [{ type: 'reply', reply: { id: 'demain', title: 'Demain' } }, { type: 'reply', reply: { id: 'lundi', title: 'Lundi' } }] },
    },
  },
};

describe('le corps de Meta tel quel', () => {
  it('🔴 chaque type courant passe, et chacun est couvert par un exemple', () => {
    expect(Object.keys(EXEMPLES).sort()).toEqual([...TYPES_MESSAGE_META].sort());
    for (const [t, e] of Object.entries(EXEMPLES)) expect(valide(corps(e)), t).toBe(true);
  });

  it('la liste et le bouton lien passent ; contactId ou externalId remplacent to', () => {
    const listeOk = {
      type: 'interactive',
      interactive: {
        type: 'list', body: { text: 'Choisissez' },
        action: { button: 'Voir', sections: [{ title: 'Matin', rows: [{ id: 'm1', title: '9 h' }] }, { title: 'Soir', rows: [{ id: 's1', title: '18 h', description: 'Après le travail' }] }] },
      },
    };
    expect(valide(corps(listeOk))).toBe(true);
    expect(valide(corps({ type: 'interactive', interactive: { type: 'cta_url', body: { text: 'Payer' }, action: { name: 'cta_url', parameters: { display_text: 'Payer', url: 'https://pay.exemple.fr' } } } }))).toBe(true);
    expect(valide({ contactId: '5f0c1e2a-8b7d-4c3e-9a1f-2d6b7e8c9f01', ...EXEMPLES.text })).toBe(true);
    expect(valide({ contactId: 'pas-un-uuid', ...EXEMPLES.text }), 'les mêmes clés que les autres routes').toBe(false);
    expect(valide({ externalId: 'crm-1', ...EXEMPLES.text })).toBe(true);
  });

  it('🔴 sans destinataire, avec deux contenus, sans contenu, ou un champ inconnu : refusé', () => {
    expect(valide(EXEMPLES.text)).toBe(false);
    expect(valide(corps({ ...EXEMPLES.text, image: { link: IMG } }))).toBe(false);
    expect(valide(corps({ type: 'image' }))).toBe(false);
    expect(valide(corps({ ...EXEMPLES.text, biz_opaque_callback_data: 'x' }))).toBe(false);
    expect(valide(corps({ type: 'text', text: { body: 'x', inconnu: 1 } }))).toBe(false);
    expect(valide(corps({ type: 'sticker', sticker: { link: IMG } })), 'hors lot').toBe(false);
  });

  it('🔴 un média ne passe que par une URL https, jamais par un id (le dépôt viendra plus tard)', () => {
    expect(valide(corps({ type: 'image', image: { id: '123' } }))).toBe(false);
    expect(valide(corps({ type: 'image', image: { link: 'http://exemple.fr/a.jpg' } }))).toBe(false);
    expect(valide(corps({ type: 'image', image: { link: 'pas une url' } }))).toBe(false);
  });

  it('🔴 les bornes de Meta : texte, boutons, titres, lignes, sections, doublons', () => {
    expect(valide(corps({ type: 'text', text: { body: 'a'.repeat(BORNES_META.texte + 1) } }))).toBe(false);
    const bouton = (id: string, title: string) => ({ type: 'reply', reply: { id, title } });
    const avecBoutons = (b: unknown[]) => corps({ type: 'interactive', interactive: { type: 'button', body: { text: 'x' }, action: { buttons: b } } });
    expect(valide(avecBoutons([bouton('a', 'A'), bouton('b', 'B'), bouton('c', 'C'), bouton('d', 'D')]))).toBe(false);
    expect(valide(avecBoutons([bouton('a', 'x'.repeat(21))]))).toBe(false);
    expect(valide(avecBoutons([bouton('a', 'A'), bouton('a', 'B')])), 'même id').toBe(false);
    expect(valide(avecBoutons([bouton('a', 'A'), bouton('b', 'A')])), 'même titre').toBe(false);
    const ligne = (i: number) => ({ id: `l${i}`, title: `L${i}` });
    const avecLignes = (sections: unknown[]) => corps({ type: 'interactive', interactive: { type: 'list', body: { text: 'x' }, action: { button: 'Voir', sections } } });
    expect(valide(avecLignes([{ title: 'A', rows: Array.from({ length: 11 }, (_, i) => ligne(i)) }])), '11 lignes').toBe(false);
    expect(valide(avecLignes([{ rows: [ligne(1)] }, { rows: [ligne(2)] }])), 'sections sans titre').toBe(false);
    expect(valide(avecLignes([{ title: 'A', rows: [ligne(1)] }, { title: 'B', rows: [ligne(1)] }])), 'même id de ligne').toBe(false);
    expect(valide(corps({ type: 'location', location: { latitude: 91, longitude: 0 } }))).toBe(false);
  });
});

describe('les corrections de la relecture (lot 13, domaine 2)', () => {
  it('🔴 la position écrite en CHAÎNES, comme l’exemple de Meta, passe, et part en nombres', () => {
    const lieu = { type: 'location', location: { latitude: '37.44216251868683', longitude: '-122.16153582049394', name: 'Siège' } };
    const lu = schemaMessageMeta.safeParse(corps(lieu));
    expect(lu.success).toBe(true);
    expect(corpsPourMeta(schemaContenuMeta.parse(lieu))).toEqual({ type: 'location', location: { latitude: 37.44216251868683, longitude: -122.16153582049394, name: 'Siège' } });
    expect(valide(corps({ type: 'location', location: { latitude: '91', longitude: '0' } }))).toBe(false);
    expect(valide(corps({ type: 'location', location: { latitude: 'nord', longitude: '0' } }))).toBe(false);
  });

  it('🔴 un refus nomme ce qu’il annonce : le destinataire manquant, un média par id dans un interactif', () => {
    const sansTo = schemaMessageMeta.safeParse(EXEMPLES.text);
    expect(!sansTo.success && messageDeForme(sansTo.error)).toMatch(/désignez la personne/);
    const parId = schemaMessageMeta.safeParse(corps({
      type: 'interactive',
      interactive: { type: 'button', header: { type: 'image', image: { id: '123' } }, body: { text: 'x' }, action: { buttons: [{ type: 'reply', reply: { id: 'a', title: 'A' } }] } },
    }));
    expect(!parId.success && messageDeForme(parId.error)).toMatch(/interactive\.header/);
  });

  it('un vocal (`voice`) passe ; les préfixes réservés au moteur des scénarios sont refusés pour un id de bouton ou de ligne', () => {
    expect(valide(corps({ type: 'audio', audio: { link: 'https://exemple.fr/a.ogg', voice: true } }))).toBe(true);
    for (const id of ['btn:1', 'row:0', 'card:0:btn:1', 'sortie:x']) {
      expect(valide(corps({ type: 'interactive', interactive: { type: 'button', body: { text: 'x' }, action: { buttons: [{ type: 'reply', reply: { id, title: 'A' } }] } } })), id).toBe(false);
      expect(valide(corps({ type: 'interactive', interactive: { type: 'list', body: { text: 'x' }, action: { button: 'Voir', sections: [{ rows: [{ id, title: 'A' }] }] } } })), id).toBe(false);
    }
  });

  it('Claude peut recopier un exemple de Meta : messaging_product et recipient_type sont acceptés, et ne partent pas', () => {
    const m = schemaContenuMeta.parse({ messaging_product: 'whatsapp', recipient_type: 'individual', ...EXEMPLES.text });
    expect(corpsPourMeta(m)).toEqual({ type: 'text', text: { body: 'Bonjour', preview_url: true } });
  });
});

describe('ce qui part chez Meta, et ce que l’Inbox affiche', () => {
  it('🔴 le corps envoyé ne porte que le type et son contenu : ni to, ni contactId, ni nos champs', () => {
    const m = schemaContenuMeta.parse(EXEMPLES.image);
    expect(corpsPourMeta(m)).toEqual({ type: 'image', image: { link: IMG, caption: 'Votre colis' } });
  });

  it('l’aperçu de l’Inbox : le texte, la légende ou le type, le lieu, le corps et les boutons', () => {
    const ap = (e: Record<string, unknown>) => apercuDuMessage(schemaContenuMeta.parse(e));
    expect(ap(EXEMPLES.text!)).toBe('Bonjour');
    expect(ap(EXEMPLES.image!)).toBe('Votre colis');
    expect(ap(EXEMPLES.video!)).toBe('[vidéo]');
    expect(ap(EXEMPLES.document!)).toBe('facture.pdf');
    expect(ap(EXEMPLES.location!)).toBe('[lieu] Boutique, Paris');
    expect(ap(EXEMPLES.interactive!)).toBe('On le livre quand ?\n[Demain] [Lundi]');
  });
});
