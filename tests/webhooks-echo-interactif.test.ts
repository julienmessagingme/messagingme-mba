import { describe, it, expect, vi, afterEach } from 'vitest';
import { ECHO_INCONNU, texteDeLEcho } from '../src/webhooks/echo-interactif';
import { lireLesBascules, processHandovers } from '../src/webhooks/handover';
import { extractInbound } from '../src/webhooks/inbound';
import { CLICS_MBA, ECHOS_MBA } from './echos-mba-fixtures';

/**
 * L'écho d'un message interactif de l'agent de Meta devient un texte lisible dans l'Inbox, sur les échos RÉELS
 * relevés le 2026-10-07 (`tests/echos-mba-fixtures.ts`). Jusque-là, seul le texte d'accompagnement s'enregistrait.
 */

afterEach(() => { vi.restoreAllMocks(); });

const message = (e: { message: Record<string, unknown> }) => e.message;

describe('texteDeLEcho, sur les échos réels', () => {
  it('boutons de réponse : le corps, puis les boutons', () => {
    expect(texteDeLEcho(message(ECHOS_MBA.boutons))).toBe('Essai T0 : choisissez une option.\n[Boutons : Option A · Option B]');
  });
  it('liste : le corps, le bouton qui l’ouvre, et ses lignes', () => {
    expect(texteDeLEcho(message(ECHOS_MBA.liste))).toBe('Essai T0 : choisissez un créneau.\n[Liste « Voir les créneaux » : 9 h · 10 h · 11 h]');
  });
  it('bouton lien : le libellé et l’adresse', () => {
    expect(texteDeLEcho(message(ECHOS_MBA.lien))).toBe('Essai T0 : le lien de test.\n[Bouton lien « Ouvrir le site » : https://app.messagingme.fr/]');
  });
  it('🔴 formulaire : il part en galaxy_message, jamais en flow', () => {
    expect((ECHOS_MBA.formulaire.message as { interactive: { type: string } }).interactive.type).toBe('galaxy_message');
    expect(texteDeLEcho(message(ECHOS_MBA.formulaire))).toBe('Essai T0 : le formulaire de test.\n[Formulaire « Remplir »]');
  });
  it('image : sa légende', () => {
    expect(texteDeLEcho(message(ECHOS_MBA.image))).toBe('Essai T0 : une image.');
  });
  it('lieu : son nom', () => {
    expect(texteDeLEcho(message(ECHOS_MBA.lieu))).toBe('Tour Eiffel');
  });
  it('demande de position : le corps, puis la demande', () => {
    expect(texteDeLEcho(message(ECHOS_MBA.demandeDePosition))).toBe('Essai T0 : partagez votre position.\n[Demande de position]');
  });
  it('carrousels : le corps, puis le texte de chaque carte', () => {
    expect(texteDeLEcho(message(ECHOS_MBA.carrouselLiens))).toBe('Essai T0 : deux cartes.\n[Carrousel : Carte accueil · Carte chaînes]');
    expect(texteDeLEcho(message(ECHOS_MBA.carrouselReponses))).toBe('Essai T0 : choisissez une carte.\n[Carrousel : Carte accueil · Carte chaînes]');
  });
  it('un sous-type interactif inconnu rend le libellé générique, un type inconnu rend null', () => {
    expect(texteDeLEcho({ type: 'interactive', interactive: { type: 'catalog_message', body: { text: 'x' } } })).toBe(ECHO_INCONNU);
    expect(texteDeLEcho({ type: 'sticker', sticker: {} })).toBeNull();
    expect(texteDeLEcho({})).toBeNull();
  });
  it('le texte simple n’est pas son affaire : il reste lu par processHandovers comme avant', () => {
    expect(texteDeLEcho(message(ECHOS_MBA.phraseAvantLeComposant))).toBeNull();
  });
});

const enveloppe = (echos: unknown[]) => ({
  entry: [{ changes: [{ field: 'standby', value: { metadata: { phone_number_id: 'pn1' }, standby: { message_echoes: echos } } }] }],
});
const espace = async (pn: string): Promise<string | null> => (pn === 'pn1' ? 't1' : null);

describe('processHandovers enregistre les messages interactifs de l’agent', () => {
  it('🔴 la phrase d’accompagnement ET le composant, chacun avec son identifiant', async () => {
    const enregistres: Array<[string, string]> = [];
    await processHandovers(await lireLesBascules(enveloppe([ECHOS_MBA.phraseAvantLeComposant, ECHOS_MBA.liste]), espace), {
      marquerEscalade: async () => {},
      recordAgentMessage: async (_t, _w, body, id) => { enregistres.push([String(id), body]); },
    });
    expect(enregistres).toEqual([
      // Le texte simple, tel que Meta l'envoie (saut de ligne final compris), comme avant ce lot.
      [ECHOS_MBA.phraseAvantLeComposant.id, 'Voir les détails ci-dessous.\n'],
      [ECHOS_MBA.liste.id, 'Essai T0 : choisissez un créneau.\n[Liste « Voir les créneaux » : 9 h · 10 h · 11 h]'],
    ]);
  });

  it('un sous-type inconnu est enregistré sous le libellé générique et son payload journalisé en entier', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const inconnu = { id: 'wamid.X', message: { to: '33600000000', type: 'interactive', interactive: { type: 'catalog_message' } } };
    const enregistres: string[] = [];
    await processHandovers(await lireLesBascules(enveloppe([inconnu]), espace), {
      marquerEscalade: async () => {},
      recordAgentMessage: async (_t, _w, body) => { enregistres.push(body); },
    });
    expect(enregistres).toEqual([ECHO_INCONNU]);
    expect(log.mock.calls.some((c) => String(c[0]).includes('standby_echo_inconnu') && String(c[0]).includes('catalog_message'))).toBe(true);
  });

  it('un écho illisible au milieu du lot n’empêche pas d’enregistrer les suivants', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const enregistres: string[] = [];
    await processHandovers(await lireLesBascules(enveloppe([{ id: 'w1', message: null }, 42, ECHOS_MBA.boutons]), espace), {
      marquerEscalade: async () => {},
      recordAgentMessage: async (_t, _w, body) => { enregistres.push(body); },
    });
    expect(enregistres).toEqual(['Essai T0 : choisissez une option.\n[Boutons : Option A · Option B]']);
  });
});

describe('les clics qui reviennent, lus par la réception comme aujourd’hui', () => {
  const lu = (clic: Record<string, unknown>) => extractInbound({
    entry: [{ changes: [{ field: 'standby', value: { metadata: { phone_number_id: 'pn1' }, standby: { messages: [clic] } } }] }],
  })[0];
  it('bouton, ligne de liste, formulaire, et carte de carrousel (qui arrive en type button)', () => {
    expect(lu(CLICS_MBA.clicBouton)).toMatchObject({ body: 'Option A', buttonPayload: 'biz_ai_qr_0', field: 'standby' });
    expect(lu(CLICS_MBA.clicLigne)).toMatchObject({ body: '10 h', buttonPayload: 'biz_ai_list_creneau_10h' });
    expect(lu(CLICS_MBA.reponseFormulaire)?.body).toBe('Sent');
    expect(lu(CLICS_MBA.reponseFormulaire)?.buttonPayload).toContain('camille@example.com');
    expect(lu(CLICS_MBA.clicCarte)).toMatchObject({ type: 'button', body: 'Choisir chaînes' });
  });
});
