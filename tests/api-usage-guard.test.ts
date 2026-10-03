import { describe, it, expect } from 'vitest';
import { estLourde, unitesDe, type ApiUsageGuard, type DemandeUsage } from '../src/api/usage-guard';
import { GardeUsageMemoire } from './aide/usage';
import { CompteurDebitMemoire } from '../src/db/debit.memoire';
import type { CompteurDebit } from '../src/db/debit';
import { capturerJournal } from './journal';

/**
 * LE CONTRAT DU GARDE D'USAGE, éprouvé SANS RIEN SAVOIR DU STOCKAGE.
 *
 * 🔴 UNE REQUÊTE N'EST PAS UNE UNITÉ DE COÛT, et c'est ce que ces cas gardent. Avec les 60 requêtes par
 * minute d'une clé, un intégrateur fait accepter 3 000 contacts (60 lots de 50) ou 3 000 destinataires
 * (60 envois de 50) : le plafond de débit ne borne pas le travail, il borne la politesse.
 *
 * ⚠️ CES CAS PARLENT AU CONTRAT (`ApiUsageGuard`), PAS À LA CLASSE. C'est ce qui rend le remplacement du
 * stockage possible le jour du multi-replica : si ces tests passaient par des détails d'implémentation,
 * ils interdiraient précisément le changement qu'ils sont censés préparer.
 */
const demande = (p: Partial<DemandeUsage> = {}): DemandeUsage => ({
  tenantId: 't1', cleId: 'k1', operation: 'contacts.batch', unites: 1, ...p,
});

/** Une horloge qu'on avance à la main : les agrégats sont par MINUTE, ils ne se testent pas autrement. */
function horloge(depart = 1_700_000_000_000) {
  let t = depart;
  return { maintenant: () => t, avancerDeMinutes: (n: number) => { t += n * 60_000; } };
}

describe('le calcul des unités', () => {
  it('🔴 un lot de 50 contacts coûte 50, pas 1', async () => {
    expect(unitesDe('contacts.batch', 50)).toBe(50);
    expect(unitesDe('sends.create', 50)).toBe(50);
  });

  it('⚠️ le plancher est 1 : un appel coûte au moins un appel', async () => {
    // Un lot vide, une lecture, un refus MCP : à zéro, une boucle d'appels resterait invisible des
    // compteurs, ce qui est exactement ce qu'on cherche à voir.
    expect(unitesDe('contacts.batch', 0)).toBe(1);
    expect(unitesDe('sends.read')).toBe(1);
    expect(unitesDe('contacts.read')).toBe(1);
    expect(unitesDe('mcp.refus')).toBe(1);
  });
});

describe('le garde en OBSERVATION (aucun seuil posé)', () => {
  const garde = (h = horloge()): { g: ApiUsageGuard; h: ReturnType<typeof horloge> } =>
    ({ g: new GardeUsageMemoire(120, 0, h.maintenant), h });

  it('🔴 il n’interdit RIEN, quel que soit le travail demandé', async () => {
    // Le cas qui empêche de livrer un refus par accident. Tant qu'aucun seuil n'est arbitré, un refus
    // serait une panne qu'on s'inflige : on compte, on regarde, on décide ensuite.
    const { g } = garde();
    for (let i = 0; i < 50; i += 1) {
      expect((await g.demander(demande({ unites: 500 }))).accepte).toBe(true);
    }
    expect((await g.compteurs())[0]).toMatchObject({ appels: 50, unites: 25_000, refusees: 0 });
  });

  it('🔴 le travail est compté en UNITÉS, pas en appels', async () => {
    const { g } = garde();
    await g.demander(demande({ unites: 500 }));
    await g.demander(demande({ unites: 3 }));
    expect((await g.compteurs())[0]).toMatchObject({ appels: 2, unites: 503 });
  });

  it('deux espaces ne partagent aucun compteur', async () => {
    const { g } = garde();
    await g.demander(demande({ tenantId: 't1', unites: 10 }));
    await g.demander(demande({ tenantId: 't2', unites: 7 }));
    const par = Object.fromEntries((await g.compteurs()).map((c) => [c.tenantId, c.unites]));
    expect(par).toEqual({ t1: 10, t2: 7 });
  });

  it('deux clés du MÊME espace se distinguent, et chacune porte son propre compte', async () => {
    // L'agrégat sert à répondre « qui consomme quoi » : deux intégrations d'un même client doivent se
    // lire séparément, sinon on ne peut pas dire à qui parler.
    const { g } = garde();
    await g.demander(demande({ cleId: 'k1', unites: 4 }));
    await g.demander(demande({ cleId: 'k2', unites: 6 }));
    expect((await g.compteurs()).map((c) => c.cleId).sort()).toEqual(['k1', 'k2']);
  });

  it('chaque OPÉRATION se compte à part', async () => {
    const { g } = garde();
    await g.demander(demande({ operation: 'contacts.batch', unites: 500 }));
    await g.demander(demande({ operation: 'sends.create', unites: 50 }));
    await g.demander(demande({ operation: 'mcp.call' }));
    expect((await g.compteurs()).map((c) => c.operation).sort()).toEqual(['contacts.batch', 'mcp.call', 'sends.create']);
  });

  it('🔴 les minutes s’agrègent séparément : une rafale ne se dilue pas dans l’heure', async () => {
    const h = horloge();
    const { g } = garde(h);
    await g.demander(demande({ unites: 100 }));
    h.avancerDeMinutes(1);
    await g.demander(demande({ unites: 5 }));
    const c = await g.compteurs();
    expect(c).toHaveLength(2);
    // Du plus récent au plus ancien : c'est l'ordre dans lequel on regarde un incident.
    expect(c[0]!.unites).toBe(5);
    expect(c[1]!.unites).toBe(100);
  });

  it('⚠️ la mémoire est bornée : au-delà de la rétention, les vieilles minutes tombent', async () => {
    // Sans cela, un process qui tourne des semaines garderait une ligne par minute et par clé.
    const h = horloge();
    const g = new GardeUsageMemoire(2, 0, h.maintenant);
    await g.demander(demande({ unites: 1 }));
    h.avancerDeMinutes(5);
    await g.demander(demande({ unites: 1 }));
    expect(await g.compteurs()).toHaveLength(1);
  });

  it('🔴 aucun compteur ne porte la clé d’API ni son empreinte', async () => {
    // Ces lignes sont faites pour être REGARDÉES (par /ops, dans un journal, dans un dump) : y faire
    // entrer un secret, même haché, reviendrait à le publier. `api_keys.id` désigne la clé sans rien
    // en révéler.
    const { g } = garde();
    await g.demander(demande({ cleId: 'k1' }));
    const serialise = JSON.stringify(await g.compteurs());
    expect(serialise).not.toMatch(/mba_/);
    expect(serialise).not.toMatch(/[0-9a-f]{64}/);
  });
});

describe('la politique de refus, quand un seuil EXISTE', () => {
  /**
   * ⚠️ AUCUN SEUIL N'EST POSÉ EN PRODUCTION AUJOURD'HUI (le garde est construit à 0). Ces cas décrivent ce
   * que le refus FERA quand Julien en aura arbitré un : sans eux, la politique serait écrite le jour de
   * l'incident, c'est-à-dire au pire moment. Le premier cas de ce fichier garde l'autre sens, à savoir
   * qu'aucun refus n'arrive tant que le seuil est à 0.
   */
  it('🔴 le plafond se lit sur l’ESPACE, pas sur la clé', async () => {
    // Un espace à dix clés disposerait sinon de dix fois le quota, et le plafond ne voudrait plus rien
    // dire. Le quota par clé existe déjà : c'est le limiteur de débit.
    const g = new GardeUsageMemoire(120, 100, horloge().maintenant);
    expect((await g.demander(demande({ cleId: 'k1', unites: 60 }))).accepte).toBe(true);
    expect((await g.demander(demande({ cleId: 'k2', unites: 60 }))).accepte).toBe(false);
  });

  it('un refus est COMPTÉ, et il dit pourquoi', async () => {
    const g = new GardeUsageMemoire(120, 10, horloge().maintenant);
    await g.demander(demande({ unites: 10 }));
    const v = await g.demander(demande({ unites: 1 }));
    expect(v.accepte).toBe(false);
    expect(v.raison).toMatch(/quota/i);
    expect((await g.compteurs())[0]).toMatchObject({ appels: 1, unites: 10, refusees: 1 });
  });

  it('⚠️ un refus ne consomme PAS le quota : il ne s’auto-entretient pas', async () => {
    // Sinon une rafale refusée repousserait la réouverture indéfiniment, et un espace bloqué une fois le
    // resterait tant que son intégration réessaie, c'est-à-dire toujours.
    const g = new GardeUsageMemoire(120, 10, horloge().maintenant);
    await g.demander(demande({ unites: 10 }));
    for (let i = 0; i < 5; i += 1) await g.demander(demande({ unites: 5 }));
    expect((await g.compteurs())[0]!.unites).toBe(10);
  });

  it('la minute suivante rouvre le quota', async () => {
    const h = horloge();
    const g = new GardeUsageMemoire(120, 10, h.maintenant);
    await g.demander(demande({ unites: 10 }));
    expect((await g.demander(demande({ unites: 1 }))).accepte).toBe(false);
    h.avancerDeMinutes(1);
    expect((await g.demander(demande({ unites: 1 }))).accepte).toBe(true);
  });
});

describe('les opérations LOURDES ont un plafond de places simultanées', () => {
  /**
   * 🔴 LE CHIFFRE QUI REND CE PLAFOND NÉCESSAIRE : le pool de la copie (`DB_POOL_MAX` de `mba-api`) sert TOUT le
   * process API, et un lot de contacts en demande jusqu'à 4 à la fois. Rien ne comptait les requêtes lourdes EN
   * VOL : dix lots simultanés mettent quarante acquisitions en file derrière une poignée de places, échouent au bout de huit
   * secondes, et pendant ce temps l'Inbox et le worker se disputent les mêmes emplacements.
   *
   * ⚠️ ET LE LIMITEUR DE DÉBIT N'Y CHANGE RIEN : c'est une fenêtre FIXE, donc les 60 requêtes d'une minute
   * peuvent tomber dans la même milliseconde.
   */
  it('🔴 au-delà du plafond, plus aucune place n’est donnée', async () => {
    const g = new GardeUsageMemoire(120, 0, horloge().maintenant, 2);
    expect(g.entrerLourde()).not.toBeNull();
    expect(g.entrerLourde()).not.toBeNull();
    expect(g.entrerLourde()).toBeNull();
  });

  it('🔴 une place rendue rouvre une place, et pas deux', async () => {
    const g = new GardeUsageMemoire(120, 0, horloge().maintenant, 1);
    const liberer = g.entrerLourde();
    expect(g.entrerLourde()).toBeNull();
    liberer!();
    expect(g.entrerLourde()).not.toBeNull();
  });

  it('🔴 libérer DEUX FOIS ne rend qu’une place : un plafond ne monte pas tout seul', async () => {
    // Une réponse peut être close deux fois (un client qui coupe, puis le cycle normal). Sans cette
    // garde, chaque double fermeture agrandirait le plafond, et ça ne se verrait qu'un jour de charge.
    const g = new GardeUsageMemoire(120, 0, horloge().maintenant, 1);
    const liberer = g.entrerLourde()!;
    liberer();
    liberer();
    expect(g.entrerLourde()).not.toBeNull();
    expect(g.entrerLourde()).toBeNull();
  });

  it('⚠️ 0 désactive le plafond, comme les autres', async () => {
    const g = new GardeUsageMemoire(120, 0, horloge().maintenant, 0);
    for (let i = 0; i < 50; i += 1) expect(g.entrerLourde()).not.toBeNull();
  });

  it('🔴 seules les écritures de masse sont LOURDES : une lecture ne prend pas de place', async () => {
    // Soumettre `sends.read` ou `mcp.call` à ce plafond ferait refuser une consultation pendant qu'un lot
    // écrit, ce qui transformerait une protection du pool en panne d'écran.
    expect(estLourde('contacts.batch')).toBe(true);
    expect(estLourde('sends.create')).toBe(true);
    expect(estLourde('contacts.upsert')).toBe(false);
    expect(estLourde('sends.read')).toBe(false);
    expect(estLourde('contacts.read')).toBe(false);
    expect(estLourde('mcp.call')).toBe(false);
    expect(estLourde('mcp.refus')).toBe(false);
  });
});

describe('plusieurs copies de l’API (lot B, 2026-09-28)', () => {
  it('🔴 deux copies sur le même compteur : chacune montre le TOTAL, sur UNE ligne par (minute, espace, clé, opération)', async () => {
    const h = horloge();
    const base = new CompteurDebitMemoire(h.maintenant);
    const copieA = new GardeUsageMemoire(120, 0, h.maintenant, 1, base);
    const copieB = new GardeUsageMemoire(120, 0, h.maintenant, 1, base);
    await copieA.demander(demande({ unites: 10 }));
    await copieB.demander(demande({ unites: 5 }));
    await copieB.noterRefus(demande({ unites: 99 }));
    for (const copie of [copieA, copieB]) {
      expect(await copie.compteurs()).toEqual([
        { minute: expect.any(Number), tenantId: 't1', cleId: 'k1', operation: 'contacts.batch', appels: 2, unites: 15, refusees: 1 },
      ]);
    }
  });

  it('🔴 un quota d’espace, le jour où il existera, est tenu au TOTAL des copies', async () => {
    const h = horloge();
    const base = new CompteurDebitMemoire(h.maintenant);
    const copieA = new GardeUsageMemoire(120, 100, h.maintenant, 1, base);
    const copieB = new GardeUsageMemoire(120, 100, h.maintenant, 1, base);
    expect((await copieA.demander(demande({ unites: 60 }))).accepte).toBe(true);
    expect((await copieB.demander(demande({ unites: 60 }))).accepte).toBe(false);
  });

  it('🔴 les places LOURDES restent par copie : elles protègent le pool de la copie, que l’autre ne partage pas', async () => {
    const base = new CompteurDebitMemoire();
    const copieA = new GardeUsageMemoire(120, 0, () => Date.now(), 1, base);
    const copieB = new GardeUsageMemoire(120, 0, () => Date.now(), 1, base);
    expect(copieA.entrerLourde()).not.toBeNull();
    expect(copieA.entrerLourde()).toBeNull();
    expect(copieB.entrerLourde(), 'la copie B a son propre pool, donc sa propre place').not.toBeNull();
  });

  it('🔴 compteur muet : RIEN n’est refusé (le garde observe, il ne devient pas la panne), et la panne se dit une fois', async () => {
    const muet: CompteurDebit = { compter: async () => { throw new Error('connexion perdue'); }, lister: async () => [] };
    const g = new GardeUsageMemoire(120, 10, horloge().maintenant, 1, muet);
    const { resultat, lignes } = await capturerJournal(async () => [
      await g.demander(demande({ unites: 500 })),
      await g.demander(demande({ unites: 500 })),
      await g.noterRefus(demande()),
    ]);
    expect(resultat.slice(0, 2)).toEqual([{ accepte: true }, { accepte: true }]);
    expect(lignes.filter((l) => l.msg === 'usage_api_compteur_indisponible')).toHaveLength(1);
  });
});

describe('un refus de PLACE se voit dans les compteurs', () => {
  /**
   * 🔴 CE QUE L'ESSAI RÉEL DU 2026-09-14 A TROUVÉ, ET QU'AUCUN TEST VERT NE MONTRAIT. Dix lots simultanés
   * en production : cinq refusés en 429, et `refusees` à ZÉRO. Pire, les cinq refusés étaient comptés
   * comme ACCEPTÉS, avec tout leur travail : les compteurs annonçaient 5 005 unités dont 2 500 n'avaient
   * jamais été faites.
   *
   * ⚠️ LE COMMENTAIRE DU CODE PROMETTAIT L'INVERSE (« un refus de place doit apparaître dans les
   * compteurs ») : c'est une justification fausse, et il a fallu un essai sur la vraie API pour la voir.
   * Un mécanisme vert n'est pas un mécanisme éprouvé.
   */
  it('🔴 un refus noté compte un refus, et AUCUNE unité', async () => {
    const g = new GardeUsageMemoire(120, 0, horloge().maintenant, 1);
    await g.noterRefus(demande({ unites: 500 }));
    expect((await g.compteurs())[0]).toMatchObject({ appels: 0, unites: 0, refusees: 1 });
  });

  it('🔴 il se range sur la MÊME ligne que le travail accepté', async () => {
    // Sinon `/ops/usage` montrerait deux lignes pour un même (minute, espace, clé, opération), et il
    // faudrait les additionner de tête pour savoir ce qui s'est passé.
    const g = new GardeUsageMemoire(120, 0, horloge().maintenant, 1);
    await g.demander(demande({ unites: 500 }));
    await g.noterRefus(demande({ unites: 500 }));
    expect(await g.compteurs()).toHaveLength(1);
    expect((await g.compteurs())[0]).toMatchObject({ appels: 1, unites: 500, refusees: 1 });
  });
});

/**
 * 🔴 L'INVARIANT QUI NE VIT DANS AUCUN DES TROIS FICHIERS : LA PART DU POOL QUE L'API PUBLIQUE PEUT PRENDRE.
 *
 * Trois constantes de trois fichiers : le nombre d'opérations lourdes simultanées (`src/config.ts`), les
 * écritures qu'un lot de contacts lance à la fois (`src/api/contacts-upsert.ts`) et la taille du pool de
 * l'API (`src/config.ts`). Chacune est plausible seule ; c'est leur PRODUIT qui décide si un intégrateur peut
 * faire attendre la console et la réception des webhooks de Meta. La valeur a été 2 jusqu'au 2026-09-21, et
 * 2 x 4 = 8 prenait TOUT le pool : ce test l'aurait refusé.
 */
describe('la part du pool de l’API que prennent les opérations lourdes', () => {
  it('🔴 jamais plus de la MOITIÉ du pool, pour laisser la console et les webhooks respirer', async () => {
    const { config } = await import('../src/config');
    const { ECRITURES_EN_VOL } = await import('../src/api/contacts-upsert');
    const pris = config.API_MAX_LOURDES_SIMULTANEES * ECRITURES_EN_VOL;
    expect(
      pris,
      `${config.API_MAX_LOURDES_SIMULTANEES} opération(s) lourde(s) x ${ECRITURES_EN_VOL} écritures = ${pris} connexions sur les ${config.DB_POOL_MAX} du pool de l’API`,
    ).toBeLessThanOrEqual(config.DB_POOL_MAX / 2);
    expect(config.API_MAX_LOURDES_SIMULTANEES, 'à 0 le plafond est désactivé, et ce test ne dirait plus rien').toBeGreaterThan(0);
  });
});
