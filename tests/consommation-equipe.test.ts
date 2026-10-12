import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { TACHES_PAR_ROLE } from '../src/worker/roles';
import { lireConsommationEquipe, creerVeilleVercel, ConsommationIllisible, SEUILS_POURCENT, type ConsommationEquipe } from '../src/agent/llm/consommation-equipe';
import { SEUIL_VERCEL_ORANGE_POURCENT, SEUIL_VERCEL_ROUGE_POURCENT, teinteVercel, fmtDollars } from '../web/lib/ops-mesures';
import { CompteurDebitMemoire } from '../src/db/debit.memoire';
import type { HttpGet } from '../src/lib/http-get';

/**
 * 🔴 LE PLAFOND D'ÉQUIPE DE VERCEL (lot 14, A) : 100 $ par mois sur la passerelle d'IA, et à 100 % chaque bot de chaque
 * client se tait d'un coup. On lit la consommation chaque heure et on prévient à 80 % puis à 95 %, une fois par seuil et
 * par mois, même à travers les redémarrages (le « une fois » est tenu en base, `compteurs_debit`).
 *
 * La forme de la réponse de `GET /ai-gateway/budgets/list` n'est pas dans la documentation de Vercel : elle a été
 * MESURÉE en lecture seule le 2026-10-12. Ce jour-là, le compteur de l'équipe disait 0 $ quand les clés mensuelles en
 * disaient 7,96 : la jauge retient le plus grand des deux, ce qui est juste si le compteur de l'équipe l'est (une clé
 * compte aussi pour l'équipe, la somme des clés ne le dépasse pas) et prudent s'il est en retard.
 */

const reponse = (budgets: unknown[]) => ({ budgets });
const equipe = (limitAmount: number, currentSpend: number, o: Record<string, unknown> = {}) => ({
  quotaEntityId: 'team_id_t', scopeType: 'team', scopeId: 'team_id_t', limitAmount, currentSpend, currentByokSpend: 0,
  includeByokInQuota: false, refreshPeriod: 'monthly', active: true, archived: false, createdAt: 1, updatedAt: 2, ...o,
});
const cle = (currentSpend: number, refreshPeriod = 'monthly', o: Record<string, unknown> = {}) => ({
  quotaEntityId: 'api_key_id_k', scopeType: 'api-key', scopeId: 'k', limitAmount: 15, currentSpend, currentByokSpend: 0,
  includeByokInQuota: false, refreshPeriod, active: true, archived: false, createdAt: 1, updatedAt: 2, ...o,
});

function http(status: number, json: unknown) {
  const appels: Array<{ url: string; headers: Record<string, string> }> = [];
  const h: HttpGet = { get: async (url, headers) => { appels.push({ url, headers }); return { status, json }; } };
  return { h, appels };
}

describe('lireConsommationEquipe', () => {
  it('lit le budget de l’équipe et la somme des clés mensuelles actives, avec le jeton de compte', async () => {
    const { h, appels } = http(200, reponse([equipe(100, 12), cle(3), cle(4.5), cle(9, 'none'), cle(50, 'monthly', { archived: true })]));
    const c = await lireConsommationEquipe(h, { jeton: 'jt', teamId: 'team_1' });
    expect(appels[0]!.url).toBe('https://api.vercel.com/ai-gateway/budgets/list?teamId=team_1');
    expect(appels[0]!.headers.authorization).toBe('Bearer jt');
    expect(c).toMatchObject({ limiteDollars: 100, depenseEquipeDollars: 12, depenseClesMensuellesDollars: 7.5, depenseRetenueDollars: 12, part: 0.12 });
  });

  it('🔴 le compteur de l’équipe en retard (mesuré) : la jauge retient la somme des clés', async () => {
    const { h } = http(200, reponse([equipe(100, 0), cle(3.8), cle(4.16)]));
    const c = await lireConsommationEquipe(h, { jeton: 'jt', teamId: 't' });
    expect(c.depenseRetenueDollars).toBeCloseTo(7.96, 6);
    expect(c.part).toBeCloseTo(0.0796, 6);
  });

  it('aucun budget d’équipe actif : limite nulle, part nulle', async () => {
    const { h } = http(200, reponse([equipe(100, 5, { active: false }), cle(2)]));
    const c = await lireConsommationEquipe(h, { jeton: 'jt', teamId: 't' });
    expect(c.limiteDollars).toBeNull();
    expect(c.part).toBeNull();
  });

  it('🔴 un statut en échec ou une réponse d’une autre forme lève, sans jamais deviner', async () => {
    await expect(lireConsommationEquipe(http(403, { error: {} }).h, { jeton: 'jt', teamId: 't' })).rejects.toBeInstanceOf(ConsommationIllisible);
    await expect(lireConsommationEquipe(http(200, { items: [] }).h, { jeton: 'jt', teamId: 't' })).rejects.toBeInstanceOf(ConsommationIllisible);
    await expect(lireConsommationEquipe(http(200, reponse([{ scopeType: 'team', limitAmount: '100' }])).h, { jeton: 'jt', teamId: 't' })).rejects.toBeInstanceOf(ConsommationIllisible);
  });
});

describe('🔴 la veille du plafond Vercel', () => {
  const lecture = (part: number | null): ConsommationEquipe => ({
    limiteDollars: part === null ? null : 100,
    depenseEquipeDollars: (part ?? 0) * 100,
    depenseClesMensuellesDollars: 0,
    depenseRetenueDollars: (part ?? 0) * 100,
    part,
  });
  function monter(t0 = Date.UTC(2026, 9, 12, 10)) {
    let t = t0;
    let part: number | null = 0.1;
    const alertes: Array<{ cle: string; texte: string }> = [];
    const compteur = new CompteurDebitMemoire(() => t);
    const veille = creerVeilleVercel({ lire: async () => lecture(part), compteur, alerter: (cle, texte) => alertes.push({ cle, texte }), maintenant: () => t });
    return { veille, alertes, poser: (p: number | null) => { part = p; }, aller: (ms: number) => { t = ms; } };
  }

  it('sous 80 %, rien ; à 80 %, une alerte ; relue toutes les heures, toujours une seule', async () => {
    const m = monter();
    await m.veille();
    expect(m.alertes).toEqual([]);
    m.poser(0.81);
    await m.veille();
    await m.veille();
    expect(m.alertes.map((a) => a.cle)).toEqual(['vercel:80']);
    expect(m.alertes[0]!.texte).toMatch(/81 %.*81 \$.*100 \$/);
  });

  it('🔴 puis 95 %, une seconde ; un saut direct à 95 % ne fait qu’une alerte, et 80 % ne revient pas ensuite', async () => {
    const m = monter();
    m.poser(0.96);
    await m.veille();
    m.poser(0.85);
    await m.veille();
    expect(m.alertes.map((a) => a.cle)).toEqual(['vercel:95']);
  });

  it('🔴 une fois par MOIS : le mois suivant, les seuils se réarment', async () => {
    const m = monter();
    m.poser(0.9);
    await m.veille();
    m.aller(Date.UTC(2026, 10, 1, 0, 30));
    await m.veille();
    expect(m.alertes.map((a) => a.cle)).toEqual(['vercel:80', 'vercel:80']);
  });

  it('🔴 Julien relève le budget : les seuils se réarment sur le NOUVEAU plafond dans le même mois', async () => {
    let lu: ConsommationEquipe = { limiteDollars: 100, depenseEquipeDollars: 96, depenseClesMensuellesDollars: 0, depenseRetenueDollars: 96, part: 0.96 };
    const alertes: string[] = [];
    const t = Date.UTC(2026, 9, 20, 10);
    const veille = creerVeilleVercel({ lire: async () => lu, compteur: new CompteurDebitMemoire(() => t), alerter: (cle) => alertes.push(cle), maintenant: () => t });
    await veille();
    lu = { limiteDollars: 150, depenseEquipeDollars: 125, depenseClesMensuellesDollars: 0, depenseRetenueDollars: 125, part: 125 / 150 };
    await veille();
    expect(alertes, '80 % des 150 $ se dit, comme 95 % des 100 $ s’était dit').toEqual(['vercel:95', 'vercel:80']);
  });

  it('aucun plafond d’équipe : une alerte par mois, car rien ne borne alors la dépense', async () => {
    const m = monter();
    m.poser(null);
    await m.veille();
    await m.veille();
    expect(m.alertes.map((a) => a.cle)).toEqual(['vercel:sans-plafond']);
  });
});

/** Le câblage, lu dans le worker. */
describe('la veille Vercel est câblée dans le worker principal', () => {
  const worker = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

  it('🔴 toutes les heures, avec le jeton de compte, son « une fois » dans le compteur partagé, et un échec de lecture alerte', () => {
    expect(worker).toMatch(/if \(config\.VERCEL_API_TOKEN !== '' && config\.VERCEL_TEAM_ID !== ''\) \{/);
    expect(worker).toMatch(/lire: \(\) => lireConsommationEquipe\(fetchGet, \{ jeton: config\.VERCEL_API_TOKEN, teamId: config\.VERCEL_TEAM_ID, signal: AbortSignal\.timeout\(15_000\) \}\),/);
    expect(worker).toMatch(/compteur: compteurDebit,\s*alerter: \(cle, texte\) => alert\(cle, texte\),/);
    expect(worker).toMatch(/taches\.programmer\('consommation-vercel', 60 \* 60_000, veilleVercel, \{[\s\S]{0,200}?enEchec: \(err\) => alert\('vercel:lecture', /);
  });

  it('elle appartient au rôle principal', () => {
    expect(TACHES_PAR_ROLE['consommation-vercel']).toBe('principal');
  });
});

describe('la carte de /ops change de couleur aux seuils des alertes', () => {
  it('🔴 orange et rouge = les deux seuils du worker, et sans budget d’équipe, rouge', () => {
    expect([SEUIL_VERCEL_ROUGE_POURCENT, SEUIL_VERCEL_ORANGE_POURCENT]).toEqual([...SEUILS_POURCENT]);
    expect(teinteVercel(0.79)).toBeNull();
    expect(teinteVercel(0.8)).toBe('alerte');
    expect(teinteVercel(0.95)).toBe('danger');
    expect(teinteVercel(null)).toBe('danger');
    expect(fmtDollars(7.96, 'fr')).toBe('7,96 $');
  });
});
