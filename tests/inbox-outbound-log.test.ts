import { describe, it, expect } from 'vitest';
import { logTemplateSent, type OutboundLogger } from '../src/inbox/outbound-log';

type Msg = { body: string; messageId: string | null; type?: string; templateCategory?: string | null; templateName?: string | null };

describe('logTemplateSent (journal best-effort du template envoyé par un workflow)', () => {
  it('appelle recordOutboundByWaId avec le bon wamid + type template', async () => {
    const calls: Array<{ tenantId: string; waId: string; msg: Msg }> = [];
    const inbox: OutboundLogger = { recordOutboundByWaId: async (tenantId, waId, msg) => { calls.push({ tenantId, waId, msg }); } };
    await logTemplateSent(inbox, 't1', '33611', 'promo', 'wamid-Z');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ tenantId: 't1', waId: '33611' });
    expect(calls[0]!.msg).toMatchObject({ type: 'template', templateName: 'promo', messageId: 'wamid-Z' });
    expect(calls[0]!.msg.body).toContain('promo');
  });

  it('BEST-EFFORT : un recordOutboundByWaId qui throw ne propage pas (ne casse pas l\'envoi)', async () => {
    const inbox: OutboundLogger = { recordOutboundByWaId: async () => { throw new Error('db down'); } };
    await expect(logTemplateSent(inbox, 't1', '33611', 'promo', 'wamid-Z')).resolves.toBeUndefined();
  });

  /**
   * 🔴 LA CATÉGORIE, ET POURQUOI SON ABSENCE NE SE VOYAIT PAS.
   *
   * `estimateCostSeries` (`src/stats/cost.ts`) ignore toute ligne sans catégorie : un envoi sans elle
   * remonte bien en VOLUME mais ne produit AUCUN coût, et l'écran affiche zéro sans rien signaler. C'est ce
   * qui rendait 22 envois de scénario invisibles du coût estimé chez le tenant Demo le 2026-09-07, alors
   * que le tableau des volumes, lui, les comptait. Aucun test ne couvrait ce champ, parce qu'il n'était
   * jamais passé.
   */
  const capture = () => {
    const calls: Array<{ msg: Msg }> = [];
    const inbox: OutboundLogger = { recordOutboundByWaId: async (_t, _w, msg) => { calls.push({ msg }); } };
    return { inbox, calls };
  };

  it('🔴 la catégorie fournie est TRANSMISE : sans elle, l’envoi n’est pas chiffrable', async () => {
    const { inbox, calls } = capture();
    await logTemplateSent(inbox, 't1', '33611', 'promo', 'wamid-Z', { templateCategory: 'marketing' });
    expect(calls[0]!.msg.templateCategory).toBe('marketing');
  });

  it('sans contexte, AUCUNE catégorie n’est inventée : absente vaut mieux que fausse', async () => {
    // Une catégorie devinée se facturerait au mauvais tarif, ce qui est pire qu'un volume non chiffrable :
    // un trou se voit, un mauvais chiffre se croit.
    const { inbox, calls } = capture();
    await logTemplateSent(inbox, 't1', '33611', 'promo', 'wamid-Z');
    expect(calls[0]!.msg.templateCategory).toBeUndefined();
  });

  it('une catégorie nulle ou vide n’est pas transmise comme une valeur', async () => {
    // Les deux points d'appel passent `...?.category ?? null` : une lecture de template en échec ne doit pas
    // écrire une chaîne vide, qui ne serait ni une catégorie ni une absence.
    const { inbox, calls } = capture();
    await logTemplateSent(inbox, 't1', '33611', 'promo', 'wamid-Z', { templateCategory: null });
    await logTemplateSent(inbox, 't1', '33611', 'promo', 'wamid-Z', { templateCategory: '' });
    expect(calls[0]!.msg.templateCategory).toBeUndefined();
    expect(calls[1]!.msg.templateCategory).toBeUndefined();
  });

  it('le contexte n’écrase RIEN de ce que la fonction posait déjà', async () => {
    // ⚠️ La première version de ce commentaire décrivait un risque IMPOSSIBLE : « une clé mal nommée du
    // contexte écraserait un champ historique ». Faux, `ctx` n'est jamais étalé tel quel, la fonction
    // construit un littéral à clé FIXE (`{ templateCategory: ctx.templateCategory }`). Une justification
    // fausse est pire qu'aucune, elle se recopie. L'invariant réel, celui que ce test tient : le spread ne
    // transporte qu'une clé connue, et les champs historiques survivent à son ajout.
    const { inbox, calls } = capture();
    await logTemplateSent(inbox, 't1', '33611', 'promo', 'wamid-Z', { templateCategory: 'utility' });
    expect(calls[0]!.msg).toMatchObject({
      type: 'template', templateName: 'promo', messageId: 'wamid-Z', templateCategory: 'utility',
    });
    expect(calls[0]!.msg.body).toContain('promo');
  });
});
