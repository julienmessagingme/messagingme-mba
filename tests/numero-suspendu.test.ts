import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { MetaClientFactory } from '../src/meta/factory';
import { MetaCredentialsResolver } from '../src/meta/credentials';
import type { HttpTransport, HttpResponse } from '../src/meta/http';
import {
  NumeroBloqueError, NumeroDelieError, NumeroSuspenduError, MESSAGE_NUMERO_SUSPENDU, creerGardeNumeroSuspendu,
} from '../src/meta/numero-delie';
import { creerLectureSuspension, creerNumeroBloqueDeLEspace } from '../src/numero/suspension';
import { campaignRunJob, type RunJobDeps } from '../src/campaign/run-job';
import { lancerCampagne, type DepsMoteurDeTest } from './campagne-canaux';
import type { RecipientStore, CampaignStore, QualityProvider } from '../src/campaign/engine';
import type { Campaign, Recipient } from '../src/campaign/types';
import { messageDePause, MOTIFS_DE_PAUSE, type MotifDePause } from '../src/campaign/pause';
import { decouperInstructions } from '../src/db/migration-directives';
import type { EtatAbonnementNumero } from '../src/stripe/etat-abonnement';
import { bancDuFil } from './banc-du-fil';

/**
 * LE NUMÉRO SUSPENDU (lot 4, spec docs/superpowers/specs/2026-10-06-numero-impaye-design.md) : un numéro fourni dont
 * l'abonnement est impayé depuis 7 jours, ou fini, ne peut plus rien envoyer. Le refus vit au point d'envoi unique, à
 * côté du numéro délié, et chaque chemin qui traite le délié traite aussi la suspension.
 */

// --------------------------------------------------------------------------------------------------------
// La lecture : le numéro fourni ATTRIBUÉ de l'espace, et l'état de son abonnement
// --------------------------------------------------------------------------------------------------------

function lecture(o: { telephone?: { tenantId: string; chiffres: string } | null; fourni?: string | null; etat?: EtatAbonnementNumero | null }) {
  const lus: string[] = [];
  const lire = creerLectureSuspension({
    telephone: async (pn) => { lus.push(`telephone:${pn}`); return o.telephone === undefined ? { tenantId: 't1', chiffres: '441259797311' } : o.telephone; },
    numeroFourni: async (t) => { lus.push(`fourni:${t}`); return o.fourni === undefined ? '441259797311' : o.fourni; },
    etat: async (t) => { lus.push(`etat:${t}`); const e = o.etat === undefined ? 'suspendu' : o.etat; return e === null ? null : { etat: e }; },
  });
  return { lire, lus };
}

describe('creerLectureSuspension', () => {
  it('🔴 le numéro fourni de l’espace, abonnement suspendu : suspendu', async () => {
    const { lire, lus } = lecture({});
    expect(await lire('pn1')).toBe(true);
    // 🔴 L'espace lu est celui du numéro, jamais un autre.
    expect(lus.filter((l) => !l.startsWith('telephone')).every((l) => l.endsWith(':t1'))).toBe(true);
  });

  it('🔴 un numéro APPORTÉ (pas le numéro fourni) n’est jamais suspendu, même avec un abonnement fini', async () => {
    expect(await lecture({ fourni: '441259797399' }).lire('pn1')).toBe(false);
    expect(await lecture({ fourni: null }).lire('pn1')).toBe(false);
  });

  it('🔴 des chiffres INCONNUS (affichage vide, Meta pas lu à la liaison) comptent pour le numéro fourni (jaune 3 de A)', async () => {
    expect(await lecture({ telephone: { tenantId: 't1', chiffres: '' } }).lire('pn1')).toBe(true);
    // Sans numéro fourni attribué, rien à suspendre, même avec des chiffres inconnus.
    expect(await lecture({ telephone: { tenantId: 't1', chiffres: '' }, fourni: null }).lire('pn1')).toBe(false);
  });

  it('en retard, actif, fin prévue, libéré, ou sans abonnement : pas suspendu', async () => {
    for (const etat of ['en_retard', 'actif', 'fin_prevue', 'libere', null] as const) {
      expect(await lecture({ etat }).lire('pn1')).toBe(false);
    }
  });

  it('un numéro inconnu : pas suspendu, et rien d’autre n’est lu', async () => {
    const { lire, lus } = lecture({ telephone: null });
    expect(await lire('pn-x')).toBe(false);
    expect(lus).toEqual(['telephone:pn-x']);
  });
});

describe('creerNumeroBloqueDeLEspace : le numéro de CET espace, vu du point d’envoi', () => {
  const bloque = (o: { numero?: string | null; erreur?: unknown }) => creerNumeroBloqueDeLEspace({
    numeroDeLEspace: async () => (o.numero === undefined ? 'pn1' : o.numero),
    verifierNumero: async () => { if (o.erreur) throw o.erreur; },
  });
  it('suspendu ou délié : vrai ; ni l’un ni l’autre, ou aucun numéro : faux', async () => {
    expect(await bloque({ erreur: new NumeroSuspenduError('pn1') })('t1')).toBe(true);
    expect(await bloque({ erreur: new NumeroDelieError('pn1') })('t1')).toBe(true);
    expect(await bloque({})('t1')).toBe(false);
    expect(await bloque({ numero: null, erreur: new NumeroSuspenduError('pn1') })('t1')).toBe(false);
  });
  it('une panne de lecture n’est pas un blocage : elle remonte', async () => {
    await expect(bloque({ erreur: new Error('pooler injoignable') })('t1')).rejects.toThrow('pooler injoignable');
  });
});

describe('la garde en cache (comme celle du délié)', () => {
  it('une lecture par numéro dans la fenêtre, relue après, vidée par `invaliderTout`', async () => {
    let t = 0;
    let suspendu = false;
    const lectures: string[] = [];
    const g = creerGardeNumeroSuspendu(async (pn) => { lectures.push(pn); return suspendu; }, 5_000, () => t);
    expect(await g.estSuspendu('pn1')).toBe(false);
    suspendu = true;
    t = 4_999;
    expect(await g.estSuspendu('pn1')).toBe(false);
    t = 10_000;
    expect(await g.estSuspendu('pn1')).toBe(true);
    g.invaliderTout();
    suspendu = false;
    expect(await g.estSuspendu('pn1')).toBe(false);
    expect(lectures).toEqual(['pn1', 'pn1', 'pn1']);
  });
});

// --------------------------------------------------------------------------------------------------------
// Le point de passage des envois
// --------------------------------------------------------------------------------------------------------

class Transport implements HttpTransport {
  readonly appels: string[] = [];
  async post(url: string): Promise<HttpResponse> {
    this.appels.push(url);
    return { status: 200, json: { messages: [{ id: 'wamid.ok' }] } };
  }
}

function fabrique(o: { delies?: string[]; suspendus?: string[] }, transport: Transport, resolutions: string[]) {
  const resolver = new MetaCredentialsResolver({
    getWabaIdForTenant: async (t) => { resolutions.push(t); return null; },
    credentials: { getCredentialsByWaba: async () => null, markTokenInvalid: async () => {} },
    decrypt: (e) => e,
    fallbackToken: 'GLOBAL',
  });
  return new MetaClientFactory({
    resolver, transport, version: 'v25.0', marketingViaLite: false,
    numerosDelies: { estDelie: async (pn) => (o.delies ?? []).includes(pn) },
    numerosSuspendus: { estSuspendu: async (pn) => (o.suspendus ?? []).includes(pn) },
    listeDeLAgent: { retirerAvantUnModele: async () => {} },
    // Les modèles du mois sans limite (lot 6) : ces tests ne portent pas sur l'offre.
    quotaModeles: { consommer: async () => ({ ok: true }) },
  });
}

describe('le point de passage des envois refuse un numéro suspendu', () => {
  it('🔴 suspendu : NumeroSuspenduError (un NumeroBloqueError), AVANT le jeton, et rien ne part chez Meta', async () => {
    const transport = new Transport();
    const resolutions: string[] = [];
    const f = fabrique({ suspendus: ['pn1'] }, transport, resolutions);
    await expect(f.clientForTenant('t1', 'pn1')).rejects.toBeInstanceOf(NumeroSuspenduError);
    await expect(f.senderForTenant('t1', 'pn1')).rejects.toBeInstanceOf(NumeroBloqueError);
    await expect(f.verifierNumero('pn1')).rejects.toMatchObject({ motif: 'numero_suspendu', statusCode: 409 });
    expect(resolutions).toEqual([]);
    expect(transport.appels).toEqual([]);
  });

  it('délié ET suspendu : le délié prime (le geste de l’administrateur), et c’est un NumeroBloqueError aussi', async () => {
    const f = fabrique({ delies: ['pn1'], suspendus: ['pn1'] }, new Transport(), []);
    const e = await f.verifierNumero('pn1').catch((err: unknown) => err);
    expect(e).toBeInstanceOf(NumeroDelieError);
    expect(e).toBeInstanceOf(NumeroBloqueError);
    expect(e).toMatchObject({ motif: 'numero_delie' });
  });

  it('ni délié ni suspendu : l’envoi part comme avant', async () => {
    const transport = new Transport();
    const client = await fabrique({}, transport, []).clientForTenant('t1', 'pn1');
    await expect(client.sendText('33600000001', 'bonjour')).resolves.toMatchObject({ messageId: 'wamid.ok' });
  });

  it('le refus dit quoi faire, sans identifiant', () => {
    const e = new NumeroSuspenduError('pn-secret-42');
    expect(e.message).toBe(MESSAGE_NUMERO_SUSPENDU);
    expect(e.message).toMatch(/renouvel/);
    expect(e.message).not.toContain('pn-secret-42');
  });
});

// --------------------------------------------------------------------------------------------------------
// Une campagne qui bute sur un numéro suspendu
// --------------------------------------------------------------------------------------------------------

class Destinataires implements RecipientStore {
  readonly gestes: string[] = [];
  constructor(private readonly pending: Recipient[]) {}
  async listPending(): Promise<Recipient[]> { return this.pending; }
  async claim(id: string): Promise<boolean> { this.gestes.push(`claim ${id}`); return true; }
  async relacher(id: string): Promise<void> { this.gestes.push(`relacher ${id}`); }
  async markResult(id: string, r: { status: string }): Promise<void> { this.gestes.push(`${r.status} ${id}`); }
}
class Campagnes implements CampaignStore {
  readonly statuts: Array<{ status: string; pause?: { raison: MotifDePause; reprise: Date | null } }> = [];
  async setStatus(_id: string, status: Campaign['status'], pause?: { raison: MotifDePause; reprise: Date | null }): Promise<void> {
    this.statuts.push({ status, ...(pause ? { pause } : {}) });
  }
}
const qualite: QualityProvider = { getRating: async () => 'GREEN' };
const DEUX: Recipient[] = [
  { id: 'r1', contactId: 'x', toE164: '+33611', resolvedParams: [], status: 'pending' },
  { id: 'r2', contactId: 'y', toE164: '+33622', resolvedParams: [], status: 'pending' },
];
const whatsapp: Campaign = {
  id: 'c1', tenantId: 't1', phoneNumberId: 'pn1', category: 'marketing',
  templateName: 'promo', templateLanguage: 'fr', paramMapping: [], status: 'running', workflowId: null, ratePerMinute: null, startNodeId: null,
};

describe('campagne et numéro suspendu', () => {
  it('🔴 le run bute sur la suspension : pause `numero_suspendu` écrite, avec son message', async () => {
    const appels: Array<[string, string, string, string]> = [];
    const campagnes = new Campagnes();
    const deps: RunJobDeps = {
      repo: { getCampaign: async () => whatsapp },
      senderFor: async (_c, pn) => { throw new NumeroSuspenduError(pn); },
      recipients: new Destinataires(DEUX),
      campaigns: campagnes,
      quality: qualite,
      numerosDelies: { pauserCampagne: async (id, tenant, pn, motif) => { appels.push([id, tenant, pn, motif]); return true; } },
    };
    const report = await campaignRunJob({ campaignId: 'c1' }, deps);
    expect(report).toMatchObject({ sent: 0, failed: 0, paused: true, reason: messageDePause('numero_suspendu', null, undefined) });
    expect(appels).toEqual([['c1', 't1', 'pn1', 'numero_suspendu']]);
  });

  it('🔴 en cours de run (scénario par destinataire) : RENDU à la file, jamais en échec, le suivant n’est pas tenté', async () => {
    const destinataires = new Destinataires(DEUX);
    const appels: string[] = [];
    const refus = async (): Promise<boolean> => { throw new NumeroSuspenduError('pn1'); };
    const deps: DepsMoteurDeTest = {
      sender: {
        sendMarketing: async () => { throw new Error('aucun modèle direct'); },
        sendTemplate: async () => { throw new Error('aucun modèle direct'); },
      },
      recipients: destinataires, campaigns: new Campagnes(), quality: qualite,
      startWorkflow: refus, startWorkflowFromNode: refus,
      numerosDelies: { pauserCampagne: async (_id, _t, _pn, motif) => { appels.push(motif); return true; } },
    };
    const report = await lancerCampagne({ ...whatsapp, workflowId: 'wf1' }, deps);
    expect(destinataires.gestes).toEqual(['claim r1', 'relacher r1']);
    expect(report).toMatchObject({ failed: 0, paused: true, reason: messageDePause('numero_suspendu', null, undefined) });
    expect(appels).toEqual(['numero_suspendu']);
  });

  it('🔴 la pause non écrite (campagne arrêtée par un opérateur entre-temps) ne prétend pas que le numéro a été relié (jaune 8 de A)', async () => {
    const deps: RunJobDeps = {
      repo: { getCampaign: async () => whatsapp },
      senderFor: async (_c, pn) => { throw new NumeroSuspenduError(pn); },
      recipients: new Destinataires(DEUX),
      campaigns: new Campagnes(),
      quality: qualite,
      numerosDelies: { pauserCampagne: async () => false },
    };
    const report = await campaignRunJob({ campaignId: 'c1' }, deps);
    expect(report).toMatchObject({ paused: false });
    expect(report.reason).not.toMatch(/relié/);
    expect(report.reason).toMatch(/ne tourne plus/);
  });

  it('le message dit que la campagne reprend d’elle-même au paiement', () => {
    expect(messageDePause('numero_suspendu', null, undefined)).toMatch(/reprendra/);
    expect(MOTIFS_DE_PAUSE).toContain('numero_suspendu');
  });
});

// --------------------------------------------------------------------------------------------------------
// La migration 0215 et le code parlent des mêmes motifs ; le balayage de reprise ne voit pas la suspension
// --------------------------------------------------------------------------------------------------------

const lire = (chemin: string): string => readFileSync(new URL(chemin, import.meta.url), 'utf8');
const sansCommentaires = (t: string): string => t.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join('\n');

describe('le CHECK des motifs de pause, à sa DERNIÈRE définition', () => {
  const migrations = readdirSync(new URL('../db/migrations/', import.meta.url)).filter((f) => f.endsWith('.sql')).sort();
  const derniere = [...migrations].reverse().find((f) => lire(`../db/migrations/${f}`).includes('add constraint campaigns_pause_reason_check'));

  it('🔴 la dernière migration qui le pose porte EXACTEMENT les motifs du code (0215 aujourd’hui)', () => {
    expect(derniere).toBe('0215_numero_impaye.sql');
    const instructions = decouperInstructions(lire(`../db/migrations/${derniere!}`)).map(sansCommentaires).map((i) => i.trim());
    const pose = instructions.find((x) => x.includes('add constraint campaigns_pause_reason_check'))!;
    const codes = [...pose.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]!);
    expect(codes.sort()).toEqual([...MOTIFS_DE_PAUSE].sort());
    // Retiré sous le même nom juste avant.
    const retrait = instructions.findIndex((x) => x.startsWith('alter table campaigns drop constraint if exists campaigns_pause_reason_check'));
    expect(instructions.indexOf(pose)).toBe(retrait + 1);
  });

  it('🔴 le balayage de reprise ne voit jamais `numero_suspendu` : seul le paiement la lève', () => {
    const store = lire('../src/campaign/store.pg.ts');
    const requete = store.slice(store.indexOf('async reprendreCampagnesDues'), store.indexOf('returning id, tenant_id', store.indexOf('async reprendreCampagnesDues')));
    expect(requete).not.toContain('numero_suspendu');
    expect(sansCommentaires(lire('../db/migrations/0215_numero_impaye.sql'))).not.toContain('campaigns_reprise_idx');
  });
});

describe('l’inventaire : chaque chemin qui traitait le numéro délié traite la suspension', () => {
  it('🔴 plus aucun `instanceof NumeroDelieError` hors de son module : on attrape `NumeroBloqueError`', () => {
    const fichiers = (dossier: string): string[] => readdirSync(new URL(dossier, import.meta.url), { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? fichiers(`${dossier}${e.name}/`) : e.name.endsWith('.ts') ? [`${dossier}${e.name}`] : []));
    const fautifs = fichiers('../src/')
      .filter((f) => !f.endsWith('meta/numero-delie.ts'))
      .filter((f) => /instanceof NumeroDelieError/.test(lire(f)));
    expect(fautifs).toEqual([]);
  });
});

describe('le répondeur et un numéro bloqué', () => {
  it('🔴 le répondeur IA n’est pas démarré : il ne pourrait pas répondre, et son tour serait payé pour rien', async () => {
    const banc = bancDuFil({ repondeurAgentId: 'ag1', mbaEnabled: false, numeroBloque: true });
    await banc.fil.remettreSiPersonneNeSuit('t1', 'w', 'Bonjour', { rouverte: false });
    expect(banc.demarrages).toEqual([]);
    const libre = bancDuFil({ repondeurAgentId: 'ag1', mbaEnabled: false });
    await libre.fil.remettreSiPersonneNeSuit('t1', 'w', 'Bonjour', { rouverte: false });
    expect(libre.demarrages).toHaveLength(1);
  });
});
