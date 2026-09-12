import { describe, it, expect } from 'vitest';
import { campaignJobExpireSeconds, plafondDuCanal, resolveRatePerMinute, SANS_PLAFOND } from '../src/campaign/pacing';

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
  // ⚠️ Ces quatre cas sont ceux d'avant le plafond par canal, CONSERVÉS TELS QUELS : ils exercent la
  // RÉSOLUTION (campagne > défaut serveur), pas le plafonnement. Ils passent donc `SANS_PLAFOND`, qui
  // est exactement ce que faisait la fonction à deux paramètres.
  it('rate posé sur la campagne -> prime sur le défaut serveur', () => {
    expect(resolveRatePerMinute(60, 30, SANS_PLAFOND)).toBe(60);
    expect(resolveRatePerMinute(15, 30, SANS_PLAFOND)).toBe(15);
  });

  it('rate null -> défaut serveur', () => {
    expect(resolveRatePerMinute(null, 30, SANS_PLAFOND)).toBe(30);
  });

  it('rate null + défaut serveur 0 (opt-out) -> 0 (aucun frein)', () => {
    expect(resolveRatePerMinute(null, 0, SANS_PLAFOND)).toBe(0);
  });

  it('rate <= 0 traité comme non posé -> défaut serveur', () => {
    expect(resolveRatePerMinute(0, 30, SANS_PLAFOND)).toBe(30);
    expect(resolveRatePerMinute(-5, 30, SANS_PLAFOND)).toBe(30);
  });
});

describe('alignement pacing / run-job (pas de rejeu parallèle)', () => {
  // Le piège : pacing et run-job doivent voir le MÊME débit. Si un défaut serveur < 30 est appliqué au run
  // (run-job throttle), pacing doit l'estimer avec CE débit, pas avec son plancher de 30 (qui sous-estimerait la
  // durée -> expireInSeconds trop court -> pg-boss rejoue en parallèle). On passe donc le rate RÉSOLU à pacing.
  it('défaut serveur 15/min : la durée est estimée à 15/min, pas au plancher 30', () => {
    const resolu = resolveRatePerMinute(null, 15, SANS_PLAFOND); // = 15
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
    expect(campaignJobExpireSeconds(1000, resolveRatePerMinute(null, 30, SANS_PLAFOND))).toBe(campaignJobExpireSeconds(1000, 30));
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

/**
 * LE PLAFOND DE DÉBIT EST PROPRE AU CANAL.
 *
 * 🔴 CE QUE CE BLOC CORRIGE. `PHONE_RATE_PER_MINUTE_MAX` vaut 80 parce que c'est ce que Meta tolère
 * pour un numéro WhatsApp. Une campagne RCS ne passe par aucun numéro Meta : lui appliquer ce chiffre,
 * c'est faire tenir la cadence d'un canal par la contrainte d'un autre. Le jour où l'un des deux
 * bouge, l'autre bouge avec lui sans que personne ne l'ait voulu.
 */
describe('plafondDuCanal', () => {
  const config = { PHONE_RATE_PER_MINUTE_MAX: 80, RCS_RATE_PER_MINUTE_MAX: 60 };

  it('une campagne RCS n herite PAS du plafond WhatsApp', () => {
    // Le plafond WhatsApp vient de Meta (80). Le RCS a le sien, 60 pour commencer.
    expect(plafondDuCanal('whatsapp', config)).toBe(80);
    expect(plafondDuCanal('rcs', config)).toBe(60);
  });

  it('un canal absent est du WhatsApp : c est le defaut historique de la colonne', () => {
    // `campaigns.channel` est `not null default 'whatsapp'` (migration 0056), et `Campaign.channel` est
    // optionnel côté type. Les deux lectures doivent dire la même chose.
    expect(plafondDuCanal(undefined, config)).toBe(80);
  });

  it('les deux plafonds bougent INDEPENDAMMENT', () => {
    // 🔴 LE CAS QUI DISCRIMINE. Avec 80 et 60, une implémentation qui rendrait toujours
    // `PHONE_RATE_PER_MINUTE_MAX` se verrait sur le RCS ; mais une implémentation qui rendrait toujours
    // `RCS_RATE_PER_MINUTE_MAX` se verrait sur le WhatsApp seulement si les deux valeurs diffèrent.
    // On les fait donc bouger dans les DEUX sens, et on vérifie que chacune suit la sienne.
    expect(plafondDuCanal('rcs', { PHONE_RATE_PER_MINUTE_MAX: 80, RCS_RATE_PER_MINUTE_MAX: 12 })).toBe(12);
    expect(plafondDuCanal('whatsapp', { PHONE_RATE_PER_MINUTE_MAX: 7, RCS_RATE_PER_MINUTE_MAX: 60 })).toBe(7);
    // Et le RCS peut passer AU-DESSUS du plafond WhatsApp : rien ne les ordonne l'un par rapport à l'autre.
    expect(plafondDuCanal('rcs', { PHONE_RATE_PER_MINUTE_MAX: 80, RCS_RATE_PER_MINUTE_MAX: 200 })).toBe(200);
  });
});

describe('resolveRatePerMinute : le plafond du canal borne le debit choisi', () => {
  it('un debit choisi AU-DESSUS du plafond du canal est ramene au plafond', () => {
    // L'écran laissait choisir jusqu'à 80 pour tous les canaux : une campagne RCS à 80 doit descendre à 60.
    expect(resolveRatePerMinute(80, 30, 60)).toBe(60);
  });

  it('un debit choisi SOUS le plafond est respecte tel quel', () => {
    expect(resolveRatePerMinute(20, 30, 60)).toBe(20);
  });

  it('le defaut SERVEUR est plafonne aussi', () => {
    // 🔴 Sinon un `CAMPAIGN_DEFAULT_RATE_PER_MINUTE` relevé au-dessus d'un plafond de canal le
    // contournerait pour toutes les campagnes qui ne posent pas de débit, c'est-à-dire la majorité.
    expect(resolveRatePerMinute(null, 80, 60)).toBe(60);
  });

  it('l opt-out (aucun frein) reste un opt-out, le plafond ne le REVEILLE pas', () => {
    // ⚠️ `0` veut dire « aucun frein », pas « débit de zéro ». Le plafonner à 60 transformerait un
    // opt-out explicite en une cadence de 60/min, donc changerait le comportement de reproduction
    // d'incident pour lequel l'opt-out existe.
    expect(resolveRatePerMinute(null, 0, 60)).toBe(0);
    expect(resolveRatePerMinute(0, 0, 60)).toBe(0);
  });

  it('un plafond <= 0 veut dire AUCUN plafond', () => {
    expect(resolveRatePerMinute(80, 30, SANS_PLAFOND)).toBe(80);
    expect(resolveRatePerMinute(80, 30, 0)).toBe(80);
  });
});

/**
 * 🔴 UN PLAFOND DÉCLARÉ MAIS NON CÂBLÉ NE PLAFONNE RIEN, ET RIEN NE LE DIRAIT.
 *
 * `plafondDeDebit` et `plafondLePlusBas` sont des dépendances OPTIONNELLES, parce que les tests de câblage
 * de `run-job` et des balayages ne les passent pas et doivent rester en opt-out. Le prix de cette
 * commodité est exactement le défaut que le dépôt a déjà payé : une dépendance oubliée continue de
 * compiler, et le comportement retombe en silence sur celui d'avant. Ce test le rend mécanique, comme le
 * fait déjà le câblage de l'expiration juste au-dessus.
 */
describe('cablage : un debit par defaut cable impose un plafond cable', () => {
  it('tout fichier de src qui INJECTE defaultRatePerMinute injecte aussi un plafond', async () => {
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
      // ⚠️ `defaultRatePerMinute:` sans `?` : une INJECTION, pas la déclaration du champ optionnel
      // (`defaultRatePerMinute?: number;`), qui elle est légitime et ne câble rien.
      const injections = [...src.matchAll(/defaultRatePerMinute:\s/g)].length;
      if (injections === 0) continue;
      vus += injections;
      const plafonds = [...src.matchAll(/plafond(DeDebit|LePlusBas):\s/g)].length;
      if (plafonds < injections) {
        fautifs.push(`${f.split('src')[1]} : ${injections} injection(s) de débit pour ${plafonds} plafond(s)`);
      }
    }
    expect(vus, 'le test doit VRAIMENT trouver des injections, sinon il ne prouve rien').toBeGreaterThan(0);
    expect(fautifs).toEqual([]);
  });
});
