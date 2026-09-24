import { describe, it, expect } from 'vitest';
import { estLourde, unitesDe, type ApiUsageGuard, type DemandeUsage } from '../src/api/usage-guard';
import { GardeUsageMemoire } from '../src/api/usage-guard.memoire';

/**
 * LE CONTRAT DU GARDE D'USAGE, éprouvé SANS RIEN SAVOIR DU STOCKAGE.
 *
 * 🔴 UNE REQUÊTE N'EST PAS UNE UNITÉ DE COÛT, et c'est ce que ces cas gardent. Avec les 60 requêtes par
 * minute d'une clé, un intégrateur fait accepter 30 000 contacts (60 lots de 500) ou 3 000 destinataires
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
  it('🔴 un lot de 500 contacts coûte 500, pas 1', () => {
    expect(unitesDe('contacts.batch', 500)).toBe(500);
    expect(unitesDe('sends.create', 50)).toBe(50);
  });

  it('⚠️ le plancher est 1 : un appel coûte au moins un appel', () => {
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

  it('🔴 il n’interdit RIEN, quel que soit le travail demandé', () => {
    // Le cas qui empêche de livrer un refus par accident. Tant qu'aucun seuil n'est arbitré, un refus
    // serait une panne qu'on s'inflige : on compte, on regarde, on décide ensuite.
    const { g } = garde();
    for (let i = 0; i < 50; i += 1) {
      expect(g.demander(demande({ unites: 500 })).accepte).toBe(true);
    }
    expect(g.compteurs()[0]).toMatchObject({ appels: 50, unites: 25_000, refusees: 0 });
  });

  it('🔴 le travail est compté en UNITÉS, pas en appels', () => {
    const { g } = garde();
    g.demander(demande({ unites: 500 }));
    g.demander(demande({ unites: 3 }));
    expect(g.compteurs()[0]).toMatchObject({ appels: 2, unites: 503 });
  });

  it('deux espaces ne partagent aucun compteur', () => {
    const { g } = garde();
    g.demander(demande({ tenantId: 't1', unites: 10 }));
    g.demander(demande({ tenantId: 't2', unites: 7 }));
    const par = Object.fromEntries(g.compteurs().map((c) => [c.tenantId, c.unites]));
    expect(par).toEqual({ t1: 10, t2: 7 });
  });

  it('deux clés du MÊME espace se distinguent, et chacune porte son propre compte', () => {
    // L'agrégat sert à répondre « qui consomme quoi » : deux intégrations d'un même client doivent se
    // lire séparément, sinon on ne peut pas dire à qui parler.
    const { g } = garde();
    g.demander(demande({ cleId: 'k1', unites: 4 }));
    g.demander(demande({ cleId: 'k2', unites: 6 }));
    expect(g.compteurs().map((c) => c.cleId).sort()).toEqual(['k1', 'k2']);
  });

  it('chaque OPÉRATION se compte à part', () => {
    const { g } = garde();
    g.demander(demande({ operation: 'contacts.batch', unites: 500 }));
    g.demander(demande({ operation: 'sends.create', unites: 50 }));
    g.demander(demande({ operation: 'mcp.call' }));
    expect(g.compteurs().map((c) => c.operation).sort()).toEqual(['contacts.batch', 'mcp.call', 'sends.create']);
  });

  it('🔴 les minutes s’agrègent séparément : une rafale ne se dilue pas dans l’heure', () => {
    const h = horloge();
    const { g } = garde(h);
    g.demander(demande({ unites: 100 }));
    h.avancerDeMinutes(1);
    g.demander(demande({ unites: 5 }));
    const c = g.compteurs();
    expect(c).toHaveLength(2);
    // Du plus récent au plus ancien : c'est l'ordre dans lequel on regarde un incident.
    expect(c[0]!.unites).toBe(5);
    expect(c[1]!.unites).toBe(100);
  });

  it('⚠️ la mémoire est bornée : au-delà de la rétention, les vieilles minutes tombent', () => {
    // Sans cela, un process qui tourne des semaines garderait une ligne par minute et par clé.
    const h = horloge();
    const g = new GardeUsageMemoire(2, 0, h.maintenant);
    g.demander(demande({ unites: 1 }));
    h.avancerDeMinutes(5);
    g.demander(demande({ unites: 1 }));
    expect(g.compteurs()).toHaveLength(1);
  });

  it('🔴 aucun compteur ne porte la clé d’API ni son empreinte', () => {
    // Ces lignes sont faites pour être REGARDÉES (par /ops, dans un journal, dans un dump) : y faire
    // entrer un secret, même haché, reviendrait à le publier. `api_keys.id` désigne la clé sans rien
    // en révéler.
    const { g } = garde();
    g.demander(demande({ cleId: 'k1' }));
    const serialise = JSON.stringify(g.compteurs());
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
  it('🔴 le plafond se lit sur l’ESPACE, pas sur la clé', () => {
    // Un espace à dix clés disposerait sinon de dix fois le quota, et le plafond ne voudrait plus rien
    // dire. Le quota par clé existe déjà : c'est le limiteur de débit.
    const g = new GardeUsageMemoire(120, 100, horloge().maintenant);
    expect(g.demander(demande({ cleId: 'k1', unites: 60 })).accepte).toBe(true);
    expect(g.demander(demande({ cleId: 'k2', unites: 60 })).accepte).toBe(false);
  });

  it('un refus est COMPTÉ, et il dit pourquoi', () => {
    const g = new GardeUsageMemoire(120, 10, horloge().maintenant);
    g.demander(demande({ unites: 10 }));
    const v = g.demander(demande({ unites: 1 }));
    expect(v.accepte).toBe(false);
    expect(v.raison).toMatch(/quota/i);
    expect(g.compteurs()[0]).toMatchObject({ appels: 1, unites: 10, refusees: 1 });
  });

  it('⚠️ un refus ne consomme PAS le quota : il ne s’auto-entretient pas', () => {
    // Sinon une rafale refusée repousserait la réouverture indéfiniment, et un espace bloqué une fois le
    // resterait tant que son intégration réessaie, c'est-à-dire toujours.
    const g = new GardeUsageMemoire(120, 10, horloge().maintenant);
    g.demander(demande({ unites: 10 }));
    for (let i = 0; i < 5; i += 1) g.demander(demande({ unites: 5 }));
    expect(g.compteurs()[0]!.unites).toBe(10);
  });

  it('la minute suivante rouvre le quota', () => {
    const h = horloge();
    const g = new GardeUsageMemoire(120, 10, h.maintenant);
    g.demander(demande({ unites: 10 }));
    expect(g.demander(demande({ unites: 1 })).accepte).toBe(false);
    h.avancerDeMinutes(1);
    expect(g.demander(demande({ unites: 1 })).accepte).toBe(true);
  });
});

describe('les opérations LOURDES ont un plafond de places simultanées', () => {
  /**
   * 🔴 LE CHIFFRE QUI REND CE PLAFOND NÉCESSAIRE : le pool sert 8 connexions pour TOUT le process API, et
   * un lot de contacts en demande jusqu'à 4 à la fois. Rien ne comptait les requêtes lourdes EN VOL : dix
   * lots simultanés mettent quarante acquisitions en file derrière huit places, échouent au bout de huit
   * secondes, et pendant ce temps l'Inbox et le worker se disputent les mêmes emplacements.
   *
   * ⚠️ ET LE LIMITEUR DE DÉBIT N'Y CHANGE RIEN : c'est une fenêtre FIXE, donc les 60 requêtes d'une minute
   * peuvent tomber dans la même milliseconde.
   */
  it('🔴 au-delà du plafond, plus aucune place n’est donnée', () => {
    const g = new GardeUsageMemoire(120, 0, horloge().maintenant, 2);
    expect(g.entrerLourde()).not.toBeNull();
    expect(g.entrerLourde()).not.toBeNull();
    expect(g.entrerLourde()).toBeNull();
  });

  it('🔴 une place rendue rouvre une place, et pas deux', () => {
    const g = new GardeUsageMemoire(120, 0, horloge().maintenant, 1);
    const liberer = g.entrerLourde();
    expect(g.entrerLourde()).toBeNull();
    liberer!();
    expect(g.entrerLourde()).not.toBeNull();
  });

  it('🔴 libérer DEUX FOIS ne rend qu’une place : un plafond ne monte pas tout seul', () => {
    // Une réponse peut être close deux fois (un client qui coupe, puis le cycle normal). Sans cette
    // garde, chaque double fermeture agrandirait le plafond, et ça ne se verrait qu'un jour de charge.
    const g = new GardeUsageMemoire(120, 0, horloge().maintenant, 1);
    const liberer = g.entrerLourde()!;
    liberer();
    liberer();
    expect(g.entrerLourde()).not.toBeNull();
    expect(g.entrerLourde()).toBeNull();
  });

  it('⚠️ 0 désactive le plafond, comme les autres', () => {
    const g = new GardeUsageMemoire(120, 0, horloge().maintenant, 0);
    for (let i = 0; i < 50; i += 1) expect(g.entrerLourde()).not.toBeNull();
  });

  it('🔴 seules les écritures de masse sont LOURDES : une lecture ne prend pas de place', () => {
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
  it('🔴 un refus noté compte un refus, et AUCUNE unité', () => {
    const g = new GardeUsageMemoire(120, 0, horloge().maintenant, 1);
    g.noterRefus(demande({ unites: 500 }));
    expect(g.compteurs()[0]).toMatchObject({ appels: 0, unites: 0, refusees: 1 });
  });

  it('🔴 il se range sur la MÊME ligne que le travail accepté', () => {
    // Sinon `/ops/usage` montrerait deux lignes pour un même (minute, espace, clé, opération), et il
    // faudrait les additionner de tête pour savoir ce qui s'est passé.
    const g = new GardeUsageMemoire(120, 0, horloge().maintenant, 1);
    g.demander(demande({ unites: 500 }));
    g.noterRefus(demande({ unites: 500 }));
    expect(g.compteurs()).toHaveLength(1);
    expect(g.compteurs()[0]).toMatchObject({ appels: 1, unites: 500, refusees: 1 });
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
