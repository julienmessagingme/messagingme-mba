import { describe, it, expect } from 'vitest';
import {
  appliquerActivation, EtatMetaIllisible, MetaARefuse, type ActivationDeps,
} from '../src/mba/activation';
import { creerWebhooksMuetsSweep } from '../src/ops/webhooks-muets-sweep';

/**
 * Allumer et éteindre l'agent de Meta, et la sonde qui aurait vu la panne.
 *
 * 🔴 CE FICHIER GARDE LA MÊME PANNE SURVENUE TROIS FOIS LE 2026-09-10 : un bouton qui annonce « désactivé »
 * pendant que l'agent de Meta répond aux clients. Les trois fois, le code n'a pas ÉCHOUÉ, il a SAUTÉ l'appel
 * à Meta et écrit notre drapeau quand même. Ce qui est testé ici n'est donc pas « ça marche », c'est
 * « ça REFUSE d'écrire quand il ne sait pas ».
 */

function deps(over: Partial<ActivationDeps> = {}): { d: ActivationDeps; ecrits: boolean[]; metaEcrits: boolean[] } {
  const ecrits: boolean[] = [];
  const metaEcrits: boolean[] = [];
  const d: ActivationDeps = {
    numeroDuTenant: async () => '1234840649713976',
    eligible: async () => true,
    ecrireChezMeta: async (_t, _pn, enabled) => { metaEcrits.push(enabled); },
    ecrireDrapeau: async (_t, enabled) => { ecrits.push(enabled); },
    ...over,
  };
  return { d, ecrits, metaEcrits };
}

describe('appliquerActivation', () => {
  it('numéro éligible : Meta D’ABORD, notre drapeau ENSUITE', async () => {
    const { d, ecrits, metaEcrits } = deps();
    const r = await appliquerActivation(d, 'tenant-1', true);
    expect(r).toEqual({ enabled: true, chezMeta: 'applique', phoneNumberId: '1234840649713976' });
    expect(metaEcrits).toEqual([true]);
    expect(ecrits).toEqual([true]);
  });

  it('🔴 état Meta ILLISIBLE : rien n’est écrit, ni chez Meta ni chez nous', async () => {
    // « An error is not a negative answer », phrase de Meta que notre doc cite depuis le 18 août. Un 401 dit
    // que la question n'a pas pu être posée. La route /status en faisait un « non éligible »
    // (`.catch(() => false)`), et c'est ce qui a rendu la panne muette pendant tout l'après-midi.
    const { d, ecrits, metaEcrits } = deps({ eligible: async () => { throw new Error('401'); } });
    await expect(appliquerActivation(d, 'tenant-1', false)).rejects.toBeInstanceOf(EtatMetaIllisible);
    expect(metaEcrits).toEqual([]);
    expect(ecrits).toEqual([]);
  });

  it('🔴 Meta REFUSE l’écriture : notre drapeau ne bouge PAS', async () => {
    // Sinon l'écran annoncerait « éteint » sur un agent qui répond, ce qui est pire qu'une erreur : c'est
    // une erreur qu'on ne peut pas voir.
    const { d, ecrits } = deps({ ecrireChezMeta: async () => { throw new Error('jeton expiré'); } });
    await expect(appliquerActivation(d, 'tenant-1', false)).rejects.toBeInstanceOf(MetaARefuse);
    expect(ecrits).toEqual([]);
  });

  it('numéro non éligible : drapeau local seul, et la raison est DITE', async () => {
    const { d, ecrits, metaEcrits } = deps({ eligible: async () => false });
    const r = await appliquerActivation(d, 'tenant-1', true);
    expect(r.chezMeta).toBe('non_eligible');
    expect(metaEcrits).toEqual([]);
    expect(ecrits).toEqual([true]);
  });

  it('aucun numéro connecté : drapeau local seul, sans jamais interroger Meta', async () => {
    let demande = false;
    const { d, ecrits } = deps({
      numeroDuTenant: async () => null,
      eligible: async () => { demande = true; return true; },
    });
    const r = await appliquerActivation(d, 'tenant-1', true);
    expect(r).toEqual({ enabled: true, chezMeta: 'aucun_numero', phoneNumberId: null });
    expect(demande).toBe(false);
    expect(ecrits).toEqual([true]);
  });
});

describe('le balayage « des webhooks arrivent mais rien ne s’écrit »', () => {
  function sonde(recus: number, enregistres: number) {
    const alertes: string[] = [];
    const sweep = creerWebhooksMuetsSweep({
      recus: async () => recus,
      enregistres: async () => enregistres,
      alert: (m) => alertes.push(m),
    });
    return { sweep, alertes };
  }

  it('🔴 alerte quand des webhooks arrivent et que RIEN n’est enregistré', async () => {
    // La signature exacte de la panne du 2026-09-08 : 58 webhooks reçus, 0 événement enregistré.
    const { sweep, alertes } = sonde(58, 0);
    expect(await sweep()).toBe(true);
    expect(alertes[0]).toMatch(/AUCUN événement enregistré/);
  });

  it('🔴 n’alerte QU’UNE FOIS tant que la panne dure', async () => {
    // Une panne d'écriture dure tant que personne ne la corrige : réalerter à chaque passe enverrait un
    // Telegram toutes les 5 minutes à vie, et une alerte permanente est une alerte qu'on cesse de lire.
    const { sweep, alertes } = sonde(58, 0);
    await sweep();
    await sweep();
    await sweep();
    expect(alertes.length).toBe(1);
  });

  it('se tait quand l’écriture fonctionne', async () => {
    const { sweep, alertes } = sonde(58, 41);
    expect(await sweep()).toBe(false);
    expect(alertes).toEqual([]);
  });

  it('🔴 se RÉARME après un retour à la normale, donc une rechute réalerte', async () => {
    const alertes: string[] = [];
    let enregistres = 0;
    const sweep = creerWebhooksMuetsSweep({
      recus: async () => 58,
      enregistres: async () => enregistres,
      alert: (m) => alertes.push(m),
    });
    await sweep();               // panne -> alerte
    enregistres = 12;
    await sweep();               // reprise -> réarme
    enregistres = 0;
    await sweep();               // rechute -> réalerte
    expect(alertes.length).toBe(2);
  });

  it('🔴 ne conclut RIEN sous le seuil de trafic', async () => {
    // Sur un parc calme, deux webhooks sans enregistrement peuvent être deux redélivrances déjà connues,
    // ce qui est parfaitement normal. Alerter là-dessus discréditerait la sonde en une semaine.
    const { sweep, alertes } = sonde(2, 0);
    expect(await sweep()).toBe(false);
    expect(alertes).toEqual([]);
  });

  it('🔴 un creux de trafic pendant la panne ne RÉARME pas', async () => {
    // Sinon la sonde réalerterait dès la reprise du trafic, alors que la panne, elle, n'a pas bougé.
    const alertes: string[] = [];
    let recus = 58;
    const sweep = creerWebhooksMuetsSweep({
      recus: async () => recus,
      enregistres: async () => 0,
      alert: (m) => alertes.push(m),
    });
    await sweep();     // panne -> alerte
    recus = 1;
    await sweep();     // creux -> ne conclut rien, et surtout ne réarme pas
    recus = 58;
    await sweep();     // le trafic revient, la panne aussi : pas de seconde alerte
    expect(alertes.length).toBe(1);
  });
});
