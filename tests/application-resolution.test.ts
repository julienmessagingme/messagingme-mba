import { describe, it, expect } from 'vitest';
import { adresseDeReponse } from '../src/application/transport/session';
import { resoudreDestinataire, type SocketVerification } from '../src/application/transport/resolution';

/**
 * L'ADRESSE D'UN CLIENT QUI N'A JAMAIS ÉCRIT (plan 2026-10-23, tâche 1). Une réponse envoyée au NUMÉRO restait « En
 * attente de ce message » sur le mobile (essai du 2026-10-22) ; pour un inconnu, aucun identifiant masqué n'est appris
 * d'un message reçu. `onWhatsApp` le demande à WhatsApp avant d'écrire, et la correspondance retenue sert l'envoi.
 */
const NUMERO = '33633921577';
const LID = '70291652927652@lid';
const MON_LID = '241914855080103:2@lid';

/** Des correspondances en mémoire, dans les deux sens comme `correspondancesPostgres`. */
function correspondances() {
  const lids = new Map<string, string>();
  const retenues: string[] = [];
  return {
    retenues,
    async retenir(lid: string, numero: string) { retenues.push(`${lid}:${numero}`); lids.set(numero, lid); },
    async lidDe(numero: string) { return lids.get(numero) ?? null; },
  };
}

/** Une socket qui rend ce qu'on lui dit, et garde ce qu'on lui a demandé. */
function socket(reponse: Awaited<ReturnType<SocketVerification['onWhatsApp']>>): SocketVerification & { demandes: string[][] } {
  const demandes: string[][] = [];
  return { demandes, async onWhatsApp(...jids) { demandes.push(jids); return reponse; } };
}

describe('la résolution d’un destinataire avant un premier message', () => {
  it('🔴 un numéro sur WhatsApp : son identifiant masqué est retenu, et l’envoi qui suit lui est adressé', async () => {
    const c = correspondances();
    const sock = socket([{ jid: `${NUMERO}@s.whatsapp.net`, exists: true, lid: LID }]);
    expect(await resoudreDestinataire(sock, c, NUMERO)).toEqual({ present: true, lid: LID });
    expect(sock.demandes).toEqual([[`${NUMERO}@s.whatsapp.net`]]);
    expect(c.retenues).toEqual([`${LID}:${NUMERO}`]);
    // L'envoi au numéro part à l'identifiant masqué : c'est ce qui évite « En attente de ce message ».
    expect(await adresseDeReponse(`${NUMERO}@s.whatsapp.net`, c, MON_LID)).toBe(LID);
  });

  it('🔴 un numéro absent de WhatsApp (Baileys ne rend AUCUNE entrée, pas `exists: false`) : absent, rien de retenu', async () => {
    for (const reponse of [[], undefined]) {
      const c = correspondances();
      expect(await resoudreDestinataire(socket(reponse), c, NUMERO)).toEqual({ present: false });
      expect(c.retenues).toEqual([]);
    }
  });

  it('un identifiant masqué donné en chiffres seuls se complète ; une forme inconnue est ignorée sans écrire', async () => {
    const c1 = correspondances();
    expect(await resoudreDestinataire(socket([{ jid: `${NUMERO}@s.whatsapp.net`, exists: true, lid: '70291652927652' }]), c1, NUMERO)).toEqual({ present: true, lid: LID });
    expect(c1.retenues).toEqual([`${LID}:${NUMERO}`]);
    for (const lid of [undefined, null, '', 'abc@lid', '1:2@lid', 42, { val: LID }]) {
      const c = correspondances();
      expect(await resoudreDestinataire(socket([{ jid: `${NUMERO}@s.whatsapp.net`, exists: true, lid }]), c, NUMERO)).toEqual({ present: true, lid: null });
      expect(c.retenues).toEqual([]);
    }
  });

  it('🔴 un numéro que WhatsApp normalise (Brésil sans le 9) : présent, mais rien n’est retenu sous la forme demandée', async () => {
    const c = correspondances();
    const sock = socket([{ jid: '551187654321@s.whatsapp.net', exists: true, lid: LID }]);
    expect(await resoudreDestinataire(sock, c, '5511987654321')).toEqual({ present: true, lid: null });
    expect(c.retenues).toEqual([]);
  });

  it('🔴 un identifiant masqué déjà connu : présent, sans rien demander à WhatsApp ni rien réécrire', async () => {
    const c = correspondances();
    await c.retenir(LID, NUMERO);
    const sock = socket([]);
    expect(await resoudreDestinataire(sock, c, NUMERO)).toEqual({ present: true, lid: LID });
    expect(sock.demandes).toEqual([]);
    expect(c.retenues).toEqual([`${LID}:${NUMERO}`]);
    // Un autre numéro, inconnu, se demande toujours.
    const autre = socket([{ jid: '33600000000@s.whatsapp.net', exists: true, lid: '123@lid' }]);
    expect(await resoudreDestinataire(autre, c, '33600000000')).toEqual({ present: true, lid: '123@lid' });
    expect(autre.demandes).toEqual([['33600000000@s.whatsapp.net']]);
  });

  it('un numéro mal formé ne part pas chez WhatsApp', async () => {
    const sock = socket([]);
    await expect(resoudreDestinataire(sock, correspondances(), '+33 6 12')).rejects.toThrow();
    expect(sock.demandes).toEqual([]);
  });
});
