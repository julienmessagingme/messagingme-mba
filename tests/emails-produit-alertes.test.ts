import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ATTENTE_RECENTE_MS, balayerLimites, creerAlerteCreditBas, creerPaiementRefuse, creerPrevenirEquipe, limitesAlertables, numeroMasque,
  PLAFOND_TRANSFERTS_JOUR, seuilAtteint, SEUIL_CREDIT_BAS_MICRO_EUR, type ContextePassage, type DepsLimites,
} from '../src/emails-produit/alertes';
import type { Emission } from '../src/emails-produit/emission';
import { PgCreditStore } from '../src/agent/credits.pg';
import { CLES_TRANSFERT, modeleDe } from '../src/emails-produit/catalogue';
import { rendre } from '../src/emails-produit/rendu';
import { DROITS } from '../src/offres/offres';

/**
 * LES ALERTES DE LA LIVRAISON B (lot 7) : ce qui décide qu'un e-mail part, et son occasion. Ce que le journal fait de
 * l'occasion (une seule réservation) : `tests/integration/emails-produit.integration.test.ts`.
 */

afterEach(() => { vi.restoreAllMocks(); });

function emetteur() {
  const emissions: Emission[] = [];
  return { emissions, emettre: async (e: Emission) => { emissions.push(e); return { destinataires: 1, reserves: 1 }; } };
}

describe('le crédit IA presque épuisé', () => {
  it('🔴 seul le débit qui FRANCHIT 0,50 € émet, avec le dernier crédit reçu pour occasion', async () => {
    const e = emetteur();
    const a = creerAlerteCreditBas({ emettre: e.emettre, dernierCreditRecu: async () => 'mvt-recharge-1', pageCredit: 'https://c/credit' });
    await a.surDebit('t1', 900_000, 600_000);
    await a.surDebit('t1', 400_000, 300_000);
    expect(e.emissions).toEqual([]);
    await a.surDebit('t1', 600_000, 420_000);
    expect(e.emissions).toEqual([{
      cle: 'credit_bas', tenantId: 't1', occasion: 'recharge:mvt-recharge-1', a: 'admins',
      valeurs: { solde: '420000', lien_credit: 'https://c/credit' },
    }]);
    // Pile au seuil : franchi (sous 0,50 €, strictement) seulement en dessous.
    await a.surDebit('t1', SEUIL_CREDIT_BAS_MICRO_EUR + 1, SEUIL_CREDIT_BAS_MICRO_EUR);
    expect(e.emissions).toHaveLength(1);
  });

  it('🔴 sans crédit jamais reçu, l’occasion existe quand même ; une panne n’arrête jamais le débit', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const e = emetteur();
    await creerAlerteCreditBas({ emettre: e.emettre, dernierCreditRecu: async () => null, pageCredit: 'x' }).surDebit('t1', 600_000, 0);
    expect(e.emissions[0]!.occasion).toBe('recharge:aucun');
    await expect(creerAlerteCreditBas({
      emettre: async () => { throw new Error('base'); }, dernierCreditRecu: async () => 'm', pageCredit: 'x',
    }).surDebit('t1', 600_000, 100_000)).resolves.toBeUndefined();
  });

  it('🔴 le magasin du crédit appelle l’alerte après chaque débit, avec le solde d’avant et d’après, et un échec ne remonte pas', async () => {
    const vus: Array<[string, number, number]> = [];
    const pool = { query: async () => ({ rows: [{ solde_micro_eur: '420000' }] }) };
    const store = new PgCreditStore(pool as never, async (t, avant, apres) => { vus.push([t, avant, apres]); });
    expect(await store.debiter('t1', 180_000)).toBe(420_000);
    expect(await store.debiterTraduction('t1', 180_000)).toBe(420_000);
    expect(vus).toEqual([['t1', 600_000, 420_000], ['t1', 600_000, 420_000]]);
    const enPanne = new PgCreditStore(pool as never, async () => { throw new Error('alerte'); });
    await expect(enPanne.debiter('t1', 180_000)).resolves.toBe(420_000);
  });

  it('le texte dit le solde dans la langue de la personne', () => {
    const m = modeleDe('credit_bas')!;
    expect(rendre(m, m.textes.fr, { solde: '420000', espace: 'A' }, 'fr').sujet).toMatch(/0,42\s€/);
    expect(rendre(m, m.textes.en, { solde: '420000', espace: 'A' }, 'en').sujet).toContain('€0.42');
  });
});

describe('le paiement refusé', () => {
  it('🔴 le numéro : la date de coupure de l’état de l’espace, une fois par facture ; le Pro : sa page Offre', async () => {
    const e = emetteur();
    const p = creerPaiementRefuse({
      emettre: e.emettre, pageNumero: 'https://c/numero', pageOffre: 'https://c/offre',
      coupureDuNumero: async () => new Date('2026-10-21T10:00:00Z'),
    });
    await p({ tenantId: 't1', offre: 'numero', factureId: 'in_1' });
    await p({ tenantId: 't1', offre: 'pro', factureId: 'in_2' });
    expect(e.emissions).toEqual([
      { cle: 'paiement_refuse_numero', tenantId: 't1', occasion: 'facture:in_1', a: 'admins', valeurs: { date_coupure: '2026-10-21T10:00:00.000Z', lien_numero: 'https://c/numero' } },
      { cle: 'paiement_refuse_pro', tenantId: 't1', occasion: 'facture:in_2', a: 'admins', valeurs: { lien_offre: 'https://c/offre' } },
    ]);
  });

  it('🔴 un numéro qui ne sera pas coupé (un numéro apporté envoie) : aucun e-mail, il annoncerait une coupure fausse', async () => {
    const e = emetteur();
    const p = creerPaiementRefuse({ emettre: e.emettre, pageNumero: 'x', pageOffre: 'y', coupureDuNumero: async () => null });
    await p({ tenantId: 't1', offre: 'numero', factureId: 'in_1' });
    expect(e.emissions).toEqual([]);
  });
});

describe('les limites de la Free et du Pro', () => {
  it('🔴 la Free et le Pro reçoivent les alertes de LEUR offre ; l’Entreprise, réglée sur devis, aucune (spec offres v2, livraison 5)', () => {
    // Une Entreprise peut avoir une limite de contacts posée par /ops : un e-mail qui la dirait en Free ou en Pro serait faux.
    const limites = { envoisModelesMois: 1000, contacts: 20000 };
    expect(limitesAlertables('base', limites)).toEqual({ modelesMois: 1000, contacts: 20000, offre: 'free' });
    // Le Pro n'a pas de limite de modèles : ses alertes ne portent que sur les contacts.
    expect(limitesAlertables('pro', limites)).toEqual({ modelesMois: null, contacts: 20000, offre: 'pro' });
    expect(limitesAlertables('entreprise', limites)).toEqual({ modelesMois: null, contacts: null, offre: null });
  });

  it('🔴 un Pro reçoit l’alerte du Pro, qui renvoie à l’Entreprise ; la Free cite la limite du Pro, lue dans la grille', async () => {
    const { d, e } = banc({ pro: { modelesMois: null, contacts: 5000, crees: 4000, offre: 'pro' }, free: { modelesMois: null, contacts: 100, crees: 100 } });
    await balayerLimites(d);
    expect(e.emissions.map((x) => [x.tenantId, x.cle, x.valeurs.limite])).toEqual([
      ['pro', 'limite_contacts_pro_80', '5000'],
      ['free', 'limite_contacts_100', '100'],
    ]);
    expect(e.emissions[1]!.valeurs.limite_pro).toBe(String(DROITS.pro.limites.contacts));
    for (const cle of ['limite_contacts_pro_80', 'limite_contacts_pro_100']) {
      const m = modeleDe(cle)!;
      for (const l of ['fr', 'en'] as const) {
        const texte = rendre(m, m.textes[l], { limite: '5000', espace: 'A', lien_offre: 'https://c/offre' }, l);
        expect(texte.text, cle + l).toMatch(/Entreprise|Enterprise/);
        expect(texte.text, cle + l).not.toMatch(/Passez en Pro|Upgrade to Pro|offre Free|Free plan/);
      }
    }
    // La Free ne dit plus que le Pro n'a pas de limite de contacts : il en a une, et l'e-mail la cite.
    for (const cle of ['limite_contacts_80', 'limite_contacts_100']) {
      const m = modeleDe(cle)!;
      const fr = rendre(m, m.textes.fr, { limite: '100', limite_pro: '5000', espace: 'A', lien_offre: 'https://c/offre' }, 'fr');
      expect(fr.text, cle).toContain('5000');
      expect(fr.text, cle).not.toMatch(/n’a pas cette limite|ne plus avoir de limite/);
    }
  });

  it('le seuil se compte à l’entier supérieur', () => {
    expect(seuilAtteint(79, 100, 80)).toBe(false);
    expect(seuilAtteint(80, 100, 80)).toBe(true);
    expect(seuilAtteint(800, 1000, 80)).toBe(true);
    expect(seuilAtteint(5, 0, 80)).toBe(false);
  });

  /** Un banc : des espaces, leurs usages, et l'état des seuils comme en base (migration 0235). */
  function banc(espaces: Record<string, { modelesMois: number | null; contacts: number | null; modeles?: number | null; crees?: number; offre?: 'free' | 'pro' }>) {
    const e = emetteur();
    const seuils = new Map<string, { atteint: boolean; generation: number }>();
    const d: DepsLimites = {
      espaces: async () => Object.keys(espaces),
      limites: async (t) => ({ modelesMois: espaces[t]!.modelesMois, contacts: espaces[t]!.contacts, offre: espaces[t]!.offre ?? 'free' }),
      modelesDuMois: async (t) => espaces[t]!.modeles ?? 0,
      contactsCrees: async (t) => espaces[t]!.crees ?? 0,
      franchir: async (t, seuil, atteint) => {
        const k = `${t}/${seuil}`;
        const l = seuils.get(k) ?? { atteint: false, generation: 0 };
        if (!atteint) { seuils.set(k, { ...l, atteint: false }); return null; }
        if (l.atteint) return null;
        seuils.set(k, { atteint: true, generation: l.generation + 1 });
        return l.generation + 1;
      },
      emettre: e.emettre,
      pageOffre: 'https://c/offre',
      moisDeParis: () => '2026-10',
    };
    return { d, e, espaces };
  }

  it('🔴 les modèles : rien sous 80 %, l’alerte de 80 %, puis celle de 100 % seule, avec le mois pour occasion ; un Pro, rien', async () => {
    const { d, e, espaces } = banc({ free: { modelesMois: 1000, contacts: 100, modeles: 799 }, pro: { modelesMois: null, contacts: null } });
    await balayerLimites(d);
    expect(e.emissions).toEqual([]);
    espaces.free!.modeles = 800;
    await balayerLimites(d);
    espaces.free!.modeles = 1000;
    await balayerLimites(d);
    expect(e.emissions.map((x) => [x.cle, x.occasion, x.valeurs.limite])).toEqual([
      ['limite_modeles_80', 'mois:2026-10', '1000'],
      ['limite_modeles_100', 'mois:2026-10', '1000'],
    ]);
    expect(e.emissions.every((x) => x.tenantId === 'free')).toBe(true);
  });

  it('🔴 les contacts : une fois par franchissement ; rester au-dessus ne redit rien, repasser dessous puis dessus le redit', async () => {
    const { d, e, espaces } = banc({ free: { modelesMois: null, contacts: 100, crees: 85 } });
    await balayerLimites(d);
    await balayerLimites(d);
    expect(e.emissions.map((x) => [x.cle, x.occasion])).toEqual([['limite_contacts_80', 'franchissement:1']]);
    espaces.free!.crees = 50;
    await balayerLimites(d);
    espaces.free!.crees = 85;
    await balayerLimites(d);
    // Un bond de 50 à 100 franchit les deux seuils d'un coup : seul le plus haut s'écrit.
    espaces.free!.crees = 50;
    await balayerLimites(d);
    espaces.free!.crees = 100;
    await balayerLimites(d);
    expect(e.emissions.map((x) => [x.cle, x.occasion])).toEqual([
      ['limite_contacts_80', 'franchissement:1'],
      ['limite_contacts_80', 'franchissement:2'],
      ['limite_contacts_100', 'franchissement:1'],
    ]);
  });

  it('🔴 une émission ratée relâche les seuils franchis : le tour suivant reprend l’alerte, avec une génération neuve', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { d, e } = banc({ free: { modelesMois: null, contacts: 100, crees: 100 } });
    const emettre = d.emettre;
    let enPanne = true;
    d.emettre = async (x) => { if (enPanne) throw new Error('pool saturé'); return emettre(x); };
    await balayerLimites(d);
    expect(e.emissions).toEqual([]);
    enPanne = false;
    await balayerLimites(d);
    expect(e.emissions.map((x) => [x.cle, x.occasion])).toEqual([['limite_contacts_100', 'franchissement:2']]);
  });

  it('🔴 une offre sans limite (Pro) relâche ses seuils : revenue en Free au-dessus, l’alerte de 100 % repart', async () => {
    const { d, e, espaces } = banc({ free: { modelesMois: null, contacts: 100, crees: 100 } });
    await balayerLimites(d);
    espaces.free!.contacts = null;
    await balayerLimites(d);
    espaces.free!.contacts = 100;
    await balayerLimites(d);
    expect(e.emissions.map((x) => [x.cle, x.occasion])).toEqual([
      ['limite_contacts_100', 'franchissement:1'],
      ['limite_contacts_100', 'franchissement:2'],
    ]);
  });

  it('🔴 les seuils sont ceux de l’offre : un Pro à sa limite, revenu en Free, reçoit l’alerte de la Free (et l’inverse)', async () => {
    // Des seuils communs aux deux offres laisseraient le Pro à 5 000 contacts « déjà franchi » une fois revenu en Free :
    // aucun « Passez en Pro » au moment où il sert le plus.
    const { d, e, espaces } = banc({ t: { modelesMois: null, contacts: 5000, crees: 5000, offre: 'pro' } });
    await balayerLimites(d);
    espaces.t = { modelesMois: 1000, contacts: 100, crees: 5000, offre: 'free' };
    await balayerLimites(d);
    espaces.t = { modelesMois: null, contacts: 5000, crees: 4100, offre: 'pro' };
    await balayerLimites(d);
    expect(e.emissions.map((x) => [x.cle, x.occasion])).toEqual([
      ['limite_contacts_pro_100', 'franchissement:1'],
      ['limite_contacts_100', 'franchissement:1'],
      // Le seuil de 80 % du Pro avait été posé au premier tour (seul le plus haut s'écrit) : relâché, il repart neuf.
      ['limite_contacts_pro_80', 'franchissement:2'],
    ]);
  });

  it('un espace en panne n’arrête pas les autres', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { d, e } = banc({ casse: { modelesMois: 1000, contacts: null }, free: { modelesMois: 1000, contacts: null, modeles: 900 } });
    const limites = d.limites;
    d.limites = async (t) => { if (t === 'casse') throw new Error('base'); return limites(t); };
    await balayerLimites(d);
    expect(e.emissions.map((x) => x.tenantId)).toEqual(['free']);
  });
});

describe('la conversation passée à l’équipe', () => {
  const MAINTENANT = new Date('2026-10-14T10:00:00Z');
  function prevenir(c: ContextePassage | null, dejaCeJour = 0, inbox: boolean | 'panne' = true) {
    const e = emetteur();
    const p = creerPrevenirEquipe({
      contexte: async () => c, transfertsDuJour: async () => dejaCeJour, emettre: e.emettre,
      lienConversation: (id) => `https://c/inbox?c=${id}`, now: () => MAINTENANT,
      inboxOuverte: async () => { if (inbox === 'panne') throw new Error('offre illisible'); return inbox; },
      lienOffre: 'https://c/offre',
    });
    return { p, e };
  }
  const contexte = (o: Partial<ContextePassage> = {}): ContextePassage => ({
    conversationId: 'conv-1', nom: 'Camille', waId: '33612345678', dernierEntrantLe: new Date(MAINTENANT.getTime() - 2 * 60_000), ...o,
  });

  it('🔴 le contact vient d’écrire : un e-mail, la fin de la fenêtre à 24 h de son message, et son message pour occasion', async () => {
    const { p, e } = prevenir(contexte());
    await p('t1', '33612345678');
    expect(e.emissions).toEqual([{
      cle: 'transfert_equipe', tenantId: 't1', a: 'admins', occasion: 'attente:conv-1:2026-10-14T09:58:00.000Z',
      valeurs: { contact: 'Camille', fin_fenetre: '2026-10-15T09:58:00.000Z', lien_conversation: 'https://c/inbox?c=conv-1' },
    }]);
  });

  it('🔴 la garde contre l’envoi de masse : un contact qui n’a pas écrit depuis 15 minutes, ou jamais, ne déclenche rien', async () => {
    for (const c of [
      contexte({ dernierEntrantLe: new Date(MAINTENANT.getTime() - ATTENTE_RECENTE_MS - 1) }),
      contexte({ dernierEntrantLe: null }),
      null,
    ]) {
      const { p, e } = prevenir(c);
      await p('t1', 'w');
      expect(e.emissions).toEqual([]);
    }
  });

  it('sans nom de profil, le numéro masqué ; une panne ne lève pas', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { p, e } = prevenir(contexte({ nom: '  ' }));
    await p('t1', '33612345678');
    expect(e.emissions[0]!.valeurs.contact).toBe('+33 •• •• •• 78');
    expect(numeroMasque('12')).toBe('••••');
    const enPanne = creerPrevenirEquipe({
      contexte: async () => { throw new Error('base'); }, transfertsDuJour: async () => 0, emettre: async () => ({ destinataires: 0, reserves: 0 }),
      lienConversation: () => '', inboxOuverte: async () => true, lienOffre: '',
    });
    await expect(enPanne('t1', 'w')).resolves.toBeUndefined();
  });

  it('🔴 un espace dont l’offre n’ouvre pas l’Inbox (la Free) reçoit sa version : répondre depuis Claude, et le lien de l’offre', async () => {
    const { p, e } = prevenir(contexte(), 0, false);
    await p('t1', '33612345678');
    expect(e.emissions).toEqual([{
      cle: 'transfert_equipe_free', tenantId: 't1', a: 'admins', occasion: 'attente:conv-1:2026-10-14T09:58:00.000Z',
      valeurs: { contact: 'Camille', fin_fenetre: '2026-10-15T09:58:00.000Z', lien_offre: 'https://c/offre' },
    }]);
    const m = modeleDe('transfert_equipe_free')!;
    expect(m.categorie).toBe(modeleDe('transfert_equipe')!.categorie);
    expect(m.textes.fr.corps).toMatch(/Claude/);
    expect(m.textes.en.corps).toMatch(/Claude/);
    expect(m.textes.fr.bouton?.lien).toBe('{{lien_offre}}');
  });

  it('une offre illisible garde l’e-mail d’aujourd’hui, avec le lien vers l’Inbox', async () => {
    const { p, e } = prevenir(contexte(), 0, 'panne');
    await p('t1', '33612345678');
    expect(e.emissions.map((x) => x.cle)).toEqual(['transfert_equipe']);
  });

  it('🔴 le plafond du jour vaut pour les deux versions : la Free n’y échappe pas', async () => {
    expect(CLES_TRANSFERT).toEqual(['transfert_equipe', 'transfert_equipe_free']);
    const au = prevenir(contexte(), PLAFOND_TRANSFERTS_JOUR, false);
    await au.p('t1', '33612345678');
    expect(au.e.emissions).toHaveLength(0);
  });

  it('🔴 au-delà de dix passages dans la journée, plus aucun e-mail (décision du 2026-10-14)', async () => {
    expect(PLAFOND_TRANSFERTS_JOUR).toBe(10);
    const sous = prevenir(contexte(), PLAFOND_TRANSFERTS_JOUR - 1);
    await sous.p('t1', '33612345678');
    expect(sous.e.emissions).toHaveLength(1);
    const au = prevenir(contexte(), PLAFOND_TRANSFERTS_JOUR);
    await au.p('t1', '33612345678');
    expect(au.e.emissions).toHaveLength(0);
  });

  it('le texte dit l’heure de fin de la fenêtre, dans la langue et le fuseau', () => {
    const m = modeleDe('transfert_equipe')!;
    const v = { contact: 'Camille', fin_fenetre: '2026-10-15T09:58:00.000Z', lien_conversation: 'https://c/inbox?c=1', espace: 'A', _fuseau: 'Europe/Paris' };
    expect(rendre(m, m.textes.fr, v, 'fr').text).toMatch(/15 octobre (à )?11:58/);
    expect(rendre(m, m.textes.en, v, 'en').text).toMatch(/15 October(,| at)? 11:58/);
  });
});
