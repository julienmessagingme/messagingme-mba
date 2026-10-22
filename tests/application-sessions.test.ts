import { describe, it, expect, beforeEach } from 'vitest';
import { DisconnectReason } from '@whiskeysockets/baileys';
import type { CompteApplication, ComptesApplication, StatutCompte } from '../src/application/comptes';
import { creerGestionnaireSessions, ErreurApplication, type JobEntrant } from '../src/application/sessions';
import type { MessageApplication, RappelsSession, Session } from '../src/application/transport/session';

/**
 * LE GESTIONNAIRE DES SESSIONS DU SERVICE DE CONNEXIONS (plan 2026-10-22, tâche 3), sur un faux transport : ce qui
 * reprend au démarrage, ce qu'un bannissement arrête pour toujours, ce qui se reconnecte, ce qui part dans la file.
 */
const espace = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

function compte(id: string, statut: StatutCompte): CompteApplication {
  return { id, tenantId: espace(Number(id.slice(-1))), numero: '44155547930' + id.slice(-1), jid: null, statut, fourniId: null, relieLe: null, dernierMessageLe: null, statutChangeLe: new Date() };
}

/** Un dépôt en mémoire : les statuts que le gestionnaire écrit se relisent. */
function fauxComptes(liste: CompteApplication[]): ComptesApplication & { touches: string[] } {
  const parId = new Map(liste.map((c) => [c.id, c]));
  return {
    touches: [],
    async preparer() { throw new Error('non utilisé'); },
    async parEspace(t) { return [...parId.values()].find((c) => c.tenantId === t) ?? null; },
    async parId(id) { return parId.get(id) ?? null; },
    async relies() { return [...parId.values()].filter((c) => c.statut === 'relie'); },
    async marquer(id, statut, extra) { const c = parId.get(id)!; parId.set(id, { ...c, statut, jid: extra?.jid ?? c.jid }); },
    async toucher(id) { this.touches.push(id); },
    async filiereDe() { return 'application'; },
  };
}

/** Un faux transport : chaque ouverture garde ses rappels, pour jouer QR, ouverture, messages et fermetures. */
function fauxTransport() {
  const ouvertures: Array<{ compteId: string; rappels: RappelsSession; session: Session & { fermee: boolean; retiree: boolean; envois: string[] } }> = [];
  return {
    ouvertures,
    async ouvrir(c: CompteApplication, rappels: RappelsSession) {
      const session = {
        fermee: false, retiree: false, envois: [] as string[],
        async envoyer(dest: string, texte: string) { this.envois.push(`${dest}:${texte}`); return 'WA-' + this.envois.length; },
        fermer() { this.fermee = true; },
        async retirer() { this.retiree = true; },
      };
      ouvertures.push({ compteId: c.id, rappels, session });
      return session;
    },
    derniere(compteId: string) { return [...ouvertures].reverse().find((o) => o.compteId === compteId)!; },
  };
}

const message = (texte: string): MessageApplication => ({ id: 'M1', jid: '33612345678@s.whatsapp.net', deMoi: false, nom: 'Léa', horodatage: new Date('2026-10-22T10:00:00Z'), type: 'text', texte, numero: '33612345678' });

describe('le gestionnaire des sessions', () => {
  let comptes: ReturnType<typeof fauxComptes>;
  let transport: ReturnType<typeof fauxTransport>;
  let jobs: JobEntrant[];
  let prevenus: string[];
  let effaces: string[];
  let g: ReturnType<typeof creerGestionnaireSessions>;

  beforeEach(() => {
    comptes = fauxComptes([compte('c1', 'relie'), compte('c2', 'banni'), compte('c3', 'deconnecte'), compte('c4', 'sommeil'), compte('c5', 'en_attente')]);
    transport = fauxTransport();
    jobs = [];
    prevenus = [];
    effaces = [];
    g = creerGestionnaireSessions({
      comptes,
      ouvrir: (c, r) => transport.ouvrir(c, r),
      enfiler: async (j) => { jobs.push(j); },
      prevenir: async (c, quoi) => { prevenus.push(`${c.id}:${quoi}`); },
      effacer: async (id) => { effaces.push(id); },
      attendre: async () => undefined,
    });
  });

  it('🔴 au redémarrage, seuls les comptes reliés reprennent : jamais un banni, un déconnecté, un endormi', async () => {
    await g.reprendre();
    expect(transport.ouvertures.map((o) => o.compteId)).toEqual(['c1']);
  });

  it('🔴 un 403 marque le compte banni, prévient, et ne rouvre jamais la session', async () => {
    await g.reprendre();
    await transport.derniere('c1').rappels.fermee('banni', DisconnectReason.forbidden);
    expect((await comptes.parId('c1'))?.statut).toBe('banni');
    expect(prevenus).toEqual(['c1:banni']);
    expect(transport.ouvertures).toHaveLength(1);
    await expect(g.relier('c1')).rejects.toThrow(ErreurApplication);
  });

  it('un 401 marque le compte déconnecté et prévient, sans rouvrir', async () => {
    await g.reprendre();
    await transport.derniere('c1').rappels.fermee('deconnecte', DisconnectReason.loggedOut);
    expect((await comptes.parId('c1'))?.statut).toBe('deconnecte');
    expect(prevenus).toEqual(['c1:deconnecte']);
    expect(transport.ouvertures).toHaveLength(1);
  });

  it('une coupure ordinaire rouvre la session', async () => {
    await g.reprendre();
    await transport.derniere('c1').rappels.fermee('reprise', DisconnectReason.connectionLost);
    expect(transport.ouvertures.map((o) => o.compteId)).toEqual(['c1', 'c1']);
  });

  it('un QR code non scanné qui expire ne relance pas la session en boucle ; le 515 de l’appairage, si', async () => {
    await g.relier('c5');
    const r = transport.derniere('c5').rappels;
    await r.qr('QR-1');
    expect((await g.qr('c5')).qr).toBe('QR-1');
    await r.fermee('reprise', DisconnectReason.restartRequired);
    expect(transport.ouvertures.filter((o) => o.compteId === 'c5')).toHaveLength(2);
    await transport.derniere('c5').rappels.fermee('reprise', DisconnectReason.timedOut);
    expect(transport.ouvertures.filter((o) => o.compteId === 'c5')).toHaveLength(2);
    expect((await comptes.parId('c5'))?.statut).toBe('en_attente');
  });

  it('l’ouverture marque le compte relié avec son identité et efface le QR', async () => {
    await g.relier('c5');
    const r = transport.derniere('c5').rappels;
    await r.qr('QR-1');
    await r.ouverte('441555479305:1@s.whatsapp.net');
    const c = await comptes.parId('c5');
    expect(c?.statut).toBe('relie');
    expect(c?.jid).toBe('441555479305:1@s.whatsapp.net');
    expect((await g.qr('c5')).qr).toBeNull();
  });

  it('un message reçu part dans la file avec son espace, et touche le compte', async () => {
    await g.reprendre();
    await transport.derniere('c1').rappels.ouverte('x@s.whatsapp.net');
    await transport.derniere('c1').rappels.message(message('Bonjour'));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ tenantId: espace(1), compteId: 'c1', message: { id: 'M1', texte: 'Bonjour', horodatage: '2026-10-22T10:00:00.000Z' } });
    expect(comptes.touches).toEqual(['c1']);
  });

  it('envoyer sur un compte relié passe par sa session ; sur un compte non relié, un refus lisible', async () => {
    await g.reprendre();
    await expect(g.envoyer('c1', 'x@s.whatsapp.net', 'avant ouverture')).rejects.toThrow(ErreurApplication);
    await transport.derniere('c1').rappels.ouverte('x@s.whatsapp.net');
    expect(await g.envoyer('c1', '33612345678@s.whatsapp.net', 'Bonjour')).toBe('WA-1');
    await expect(g.envoyer('c4', 'x@s.whatsapp.net', 'Bonjour')).rejects.toThrow(ErreurApplication);
  });

  it('un envoi touche le compte, comme un message reçu : la mise en sommeil compte l’activité dans les deux sens', async () => {
    await g.reprendre();
    await transport.derniere('c1').rappels.ouverte('x@s.whatsapp.net');
    await g.envoyer('c1', '33612345678@s.whatsapp.net', 'Bonjour');
    expect(comptes.touches).toEqual(['c1']);
  });

  it('la mise en sommeil ferme la session sans la retirer, et ne la rouvre pas', async () => {
    await g.reprendre();
    const s = transport.derniere('c1');
    await g.sommeil('c1');
    expect(s.session.fermee).toBe(true);
    expect(s.session.retiree).toBe(false);
    expect((await comptes.parId('c1'))?.statut).toBe('sommeil');
    await s.rappels.fermee('reprise', DisconnectReason.connectionClosed);
    expect(transport.ouvertures).toHaveLength(1);
  });

  it('retirer retire l’appareil d’une session ouverte, ou efface l’état d’un compte sans session', async () => {
    await g.reprendre();
    const s = transport.derniere('c1');
    await g.retirer('c1');
    expect(s.session.retiree).toBe(true);
    expect((await comptes.parId('c1'))?.statut).toBe('retire');
    await g.retirer('c4');
    expect(effaces).toEqual(['c4']);
    expect((await comptes.parId('c4'))?.statut).toBe('retire');
  });
});
