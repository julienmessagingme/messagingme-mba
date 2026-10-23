import { describe, it, expect } from 'vitest';
import type { WAMessage } from '@whiskeysockets/baileys';
import { traceDuMessageSansContenu } from '../src/application/transport/session';

/**
 * UN MESSAGE SANS CONTENU SE TRACE (essai 152 du 2026-10-23). Un message reçu pendant une coupure du service n'est arrivé
 * qu'à l'ouverture du téléphone de l'entreprise, et le service n'en avait rien écrit : un message que Baileys remet sans
 * contenu (indéchiffré, ou simple marque d'attente que le téléphone doit compléter) était écarté en silence. La trace dit
 * ce que WhatsApp remet, sans rien de personnel : ni numéro, ni identifiant de contact, ni texte.
 */
const brut = ({ key, ...reste }: Record<string, unknown>): WAMessage =>
  ({ key: { id: '3A1B2C', fromMe: false, remoteJid: '33612345678@s.whatsapp.net', ...((key as object) ?? {}) }, ...reste }) as unknown as WAMessage;

describe('la trace d’un message remis sans contenu', () => {
  it('🔴 un message indéchiffré se trace avec sa marque et sa raison, et le type de remise', () => {
    const t = traceDuMessageSansContenu(brut({ messageStubType: 2, messageStubParameters: ['Message absent from node'] }), 'notify');
    expect(t).toBe('message 3A1B2C remis sans contenu (notify, marque CIPHERTEXT : Message absent from node)');
  });

  it('🔴 la trace ne porte ni le numéro, ni l’identifiant masqué, ni le nom du contact', () => {
    const t = traceDuMessageSansContenu(brut({ key: { remoteJid: '70291652927652@lid', senderPn: '33612345678@s.whatsapp.net' }, pushName: 'Alice', messageStubType: 2 }), 'append')!;
    expect(t).toBe('message 3A1B2C remis sans contenu (append, marque CIPHERTEXT)');
    expect(t).not.toMatch(/33612345678|70291652927652|Alice/);
  });

  it('une autre marque ne se trace pas : un appel manqué (40) n’est pas un message perdu, et sa marque peut citer un contact', () => {
    expect(traceDuMessageSansContenu(brut({ messageStubType: 40, messageStubParameters: ['33612345678@s.whatsapp.net'] }), 'notify')).toBeNull();
  });

  it('un message sans contenu ni marque se trace aussi', () => {
    expect(traceDuMessageSansContenu(brut({}), 'append')).toBe('message 3A1B2C remis sans contenu (append, marque aucune)');
  });

  it('un message lisible, une réaction, un groupe ou une diffusion ne se tracent pas', () => {
    expect(traceDuMessageSansContenu(brut({ message: { conversation: 'Bonjour' } }), 'notify')).toBeNull();
    expect(traceDuMessageSansContenu(brut({ message: { reactionMessage: { text: '👍' } } }), 'notify')).toBeNull();
    expect(traceDuMessageSansContenu(brut({ key: { remoteJid: '120363000000000000@g.us' }, messageStubType: 2 }), 'notify')).toBeNull();
    expect(traceDuMessageSansContenu(brut({ key: { remoteJid: 'status@broadcast' }, messageStubType: 2 }), 'notify')).toBeNull();
  });

  it('un message de nous, sans contenu, se dit « de moi »', () => {
    expect(traceDuMessageSansContenu(brut({ key: { fromMe: true }, messageStubType: 2 }), 'notify')).toBe('message 3A1B2C remis sans contenu (notify, marque CIPHERTEXT, de moi)');
  });
});
