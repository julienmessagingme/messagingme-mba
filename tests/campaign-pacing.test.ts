import { describe, it, expect } from 'vitest';
import { campaignJobExpireSeconds, resolveRatePerMinute } from '../src/campaign/pacing';

/**
 * Lot 8 Phase 4 : dimensionnement du timeout d'un job campaign-run. Un timeout FIXE (ex. 7200 s) ne couvre
 * qu'une petite liste au débit minimal -> un run long expire et est rejoué en parallèle (débit réel doublé).
 * Le timeout doit suivre le TRAVAIL RÉEL (destinataires / débit).
 */
describe('campaignJobExpireSeconds', () => {
  it('plancher 15 min pour une petite campagne (ou 0 destinataire)', () => {
    expect(campaignJobExpireSeconds(0, null)).toBe(900);
    expect(campaignJobExpireSeconds(0, 80)).toBe(900);
    expect(campaignJobExpireSeconds(10, 80)).toBe(900); // 10/80 min ~ négligeable -> plancher
  });

  it('grosse liste à débit BAS -> timeout largement au-dessus de 15 min (couvre le run entier)', () => {
    // 1000 à 1/min : durée ~1000 min = 60000 s ; 1.5x + 600 = 90600 s, soit ~25 h -> PLAFONNÉ à 23 h.
    // La valeur brute était celle que pg-boss REFUSE (assert strict < 24 h) : la campagne ne partait jamais.
    expect(campaignJobExpireSeconds(1000, 1)).toBe(82_800);
    // 500 à 5/min : durée = 500/5*60 = 6000 s ; 1.5x + 600 = 9600 s (2h40, > la constante fixe 7200 s abandonnée).
    expect(campaignJobExpireSeconds(500, 5)).toBe(9600);
  });

  it('JAMAIS une valeur que pg-boss refuse : strictement sous 24 h sur tout le domaine autorisé', () => {
    // pg-boss/dist/attorney.js:403 : `expireInSeconds / 60 / 60 < 24`, comparaison STRICTE (86400 échoue).
    // Le débit est borné 1..80 en base et aux deux routes ; on balaie le domaine réel, pas deux cas choisis.
    for (const rate of [1, 5, 15, 30, 80]) {
      for (const n of [1, 1000, 10_000, 100_000, 1_000_000]) {
        const v = campaignJobExpireSeconds(n, rate);
        expect(v, `${n} destinataires à ${rate}/min`).toBeLessThan(86_400);
      }
    }
    // Et le cas opt-out (rate null -> plancher d'estimation 30/min), qui passe par le même chemin.
    expect(campaignJobExpireSeconds(1_000_000, null)).toBeLessThan(86_400);
  });

  it('débit au plafond (80/min) : timeout raisonnable proportionnel', () => {
    // 8000 à 80/min : durée = 6000 s ; 1.5x + 600 = 9600 s.
    expect(campaignJobExpireSeconds(8000, 80)).toBe(9600);
  });

  it('sans débit (null) : plancher de débit prudent 30/min -> timeout généreux', () => {
    // 1000 sans throttle, estimé à 30/min : durée ~2000 s ; 1.5x + 600 ~ 3600 s (1 h), généreux vs run réel court.
    // Plage (pas d'égalité stricte : arithmétique flottante sur 1000/30).
    const v = campaignJobExpireSeconds(1000, null);
    expect(v).toBeGreaterThanOrEqual(3600);
    expect(v).toBeLessThan(3700);
  });

  it('monotone : plus de destinataires -> timeout >= (jamais plus petit)', () => {
    expect(campaignJobExpireSeconds(2000, 10)).toBeGreaterThanOrEqual(campaignJobExpireSeconds(1000, 10));
  });
});

describe('resolveRatePerMinute (débit effectif partagé run-job / pacing)', () => {
  it('rate posé sur la campagne -> prime sur le défaut serveur', () => {
    expect(resolveRatePerMinute(60, 30)).toBe(60);
    expect(resolveRatePerMinute(15, 30)).toBe(15);
  });

  it('rate null -> défaut serveur', () => {
    expect(resolveRatePerMinute(null, 30)).toBe(30);
  });

  it('rate null + défaut serveur 0 (opt-out) -> 0 (aucun frein)', () => {
    expect(resolveRatePerMinute(null, 0)).toBe(0);
  });

  it('rate <= 0 traité comme non posé -> défaut serveur', () => {
    expect(resolveRatePerMinute(0, 30)).toBe(30);
    expect(resolveRatePerMinute(-5, 30)).toBe(30);
  });
});

describe('alignement pacing / run-job (pas de rejeu parallèle)', () => {
  // Le piège : pacing et run-job doivent voir le MÊME débit. Si un défaut serveur < 30 est appliqué au run
  // (run-job throttle), pacing doit l'estimer avec CE débit, pas avec son plancher de 30 (qui sous-estimerait la
  // durée -> expireInSeconds trop court -> pg-boss rejoue en parallèle). On passe donc le rate RÉSOLU à pacing.
  it('défaut serveur 15/min : la durée est estimée à 15/min, pas au plancher 30', () => {
    const resolu = resolveRatePerMinute(null, 15); // = 15
    const expire15 = campaignJobExpireSeconds(600, resolu);
    const expire30 = campaignJobExpireSeconds(600, 30);
    // 600 à 15/min = 2400 s de run ; à 30/min = 1200 s. L'estimation à 15 doit être STRICTEMENT plus grande
    // que celle à 30, sinon le run réel (15/min) dépasserait un timeout dimensionné pour 30/min.
    expect(expire15).toBeGreaterThan(expire30);
    // Et elle couvre bien la durée réelle du run à 15/min (2400 s), avec marge.
    expect(expire15).toBeGreaterThanOrEqual(2400);
  });

  it('défaut serveur >= 30 : pacing et run-job convergent (le plancher 30 ne mord jamais sur un rate positif)', () => {
    // resolu = 30 ; effectiveRate = 30 ; identique au cas opt-out estimé à 30. Pas de sous-dimensionnement.
    expect(campaignJobExpireSeconds(1000, resolveRatePerMinute(null, 30))).toBe(campaignJobExpireSeconds(1000, 30));
  });
});

/**
 * Le dimensionnement ne sert à rien s'il n'est pas BRANCHÉ. Ce test-ci lit le câblage réel, faute de pouvoir
 * instancier le worker dans un test unitaire : sa fonction `main()` n'est atteignable par aucun test.
 *
 * Le trou qu'il ferme, relevé par l'audit du 2026-08-25 et resté ouvert jusqu'au 2026-08-31 : le `retry-sweep`
 * était le SEUL enfileur de `campaign-run` à ne passer aucun dimensionnement. Il retombait donc sur le défaut
 * de 15 minutes de la file, alors qu'une relance de plus de ~450 destinataires (à 30/min) dure plus longtemps
 * que ça : le job expirait en plein envoi, pg-boss le rejouait, et le run reparti en parallèle appliquait SON
 * propre limiteur de débit. Le débit réel doublait.
 */
describe('câblage : tout enfilement de campaign-run est dimensionné ET groupé', () => {
  it("aucun `enqueue('campaign-run', ...)` du dépôt n'omet son expiration ni son groupe", async () => {
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const racine = new URL('../src/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

    const fichiers: string[] = [];
    const parcourir = (dir: string): void => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) parcourir(p);
        else if (p.endsWith('.ts')) fichiers.push(p);
      }
    };
    parcourir(racine);

    const fautifs: string[] = [];
    let vus = 0;
    for (const f of fichiers) {
      const src = readFileSync(f, 'utf8');
      // Un appel d'enfilement de cette file, avec ce qui suit sur la même ligne (les appels du dépôt tiennent
      // sur une ligne). `enqueueCampaignRun`, lui, dimensionne par construction : il n'est pas concerné.
      for (const m of src.matchAll(/\.enqueue\(\s*'campaign-run'[^\n]*/g)) {
        vus += 1;
        if (!m[0].includes('expireInSeconds')) fautifs.push(`expiration absente -> ${f.split('src')[1]} : ${m[0].trim()}`);
        // 🔴 Et le GROUPE, ajouté au lot 5 : un enfilement sans groupe échappe au plafond de concurrence par
        // espace, donc un seul client peut occuper toute la file. Une campagne programmée y est passée à
        // travers exactement comme ça, jusqu'à ce que ce test le dise.
        if (!m[0].includes('groupId')) fautifs.push(`groupe absent -> ${f.split('src')[1]} : ${m[0].trim()}`);
      }
    }
    expect(vus, 'le test doit VRAIMENT trouver des enfilements, sinon il ne prouve rien').toBeGreaterThan(0);
    expect(fautifs, 'un enfilement de campaign-run doit porter SON EXPIRATION (sinon rejeu parallèle) et SON GROUPE (sinon un client occupe toute la file)').toEqual([]);
  });
});
