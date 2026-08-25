import { describe, it, expect } from 'vitest';
import { actionOf, adressesDestinataires } from '../src/workflow/engine';
import type { EmailRecipient } from '../src/workflow/engine';
import type { WorkflowNode } from '../src/workflow/graph';

/** Node « Envoi de mail » minimal, `data` opaque comme les autres types (cf. graph.ts : parseGraph ne le
 *  valide pas, actionOf lit défensivement). */
const node = (data: Record<string, unknown>): WorkflowNode => ({ id: 'n1', type: 'email', position: { x: 0, y: 0 }, data });

describe('node email : actionOf', () => {
  it('rend l’action sendEmail quand emailAccountId, templateId et un destinataire littéral sont fournis', () => {
    const a = actionOf(node({ emailAccountId: 'a1', templateId: 't1', to: { kind: 'literal', value: 'x@ex.fr' } }));
    expect(a).toEqual({ kind: 'sendEmail', emailAccountId: 'a1', templateId: 't1', to: [{ kind: 'literal', value: 'x@ex.fr' }] });
  });

  it('rend l’action sendEmail quand le destinataire est une variable de champ', () => {
    const a = actionOf(node({ emailAccountId: 'a1', templateId: 't1', to: { kind: 'field', field: 'email_pro' } }));
    expect(a).toEqual({ kind: 'sendEmail', emailAccountId: 'a1', templateId: 't1', to: [{ kind: 'field', field: 'email_pro' }] });
  });

  it('rend null si emailAccountId manque', () => {
    expect(actionOf(node({ templateId: 't1', to: { kind: 'literal', value: 'x@ex.fr' } }))).toBeNull();
  });

  it('rend null si templateId manque', () => {
    expect(actionOf(node({ emailAccountId: 'a1', to: { kind: 'literal', value: 'x@ex.fr' } }))).toBeNull();
  });

  it('rend null si le destinataire est invalide (kind field avec un champ vide)', () => {
    expect(actionOf(node({ emailAccountId: 'a1', templateId: 't1', to: { kind: 'field', field: '' } }))).toBeNull();
  });

  it('rend null si le destinataire est absent', () => {
    expect(actionOf(node({ emailAccountId: 'a1', templateId: 't1' }))).toBeNull();
  });

  it('rend null sur un bloc totalement vide (data = {})', () => {
    expect(actionOf(node({}))).toBeNull();
  });

  it('🔴 COMPATIBILITÉ : un `to` OBJET (ancienne forme) reste envoyé, il ne devient jamais un no-op', () => {
    // Les scénarios enregistrés avant le 2026-08-25 portent `to` comme un OBJET dans leur JSONB, et rien ne
    // les renormalise à la lecture. Ne lire que la forme liste ferait rendre `null` ici, donc transformerait
    // ces blocs en no-op TOTALEMENT SILENCIEUX : aucun log, aucun événement, aucun statut d'échec, des
    // scénarios en production qui cessent d'envoyer sans que rien ne le dise.
    const a = actionOf(node({ emailAccountId: 'a1', templateId: 't1', to: { kind: 'literal', value: 'ancien@ex.fr' } }));
    expect(a).not.toBeNull();
    expect((a as { to: unknown }).to).toEqual([{ kind: 'literal', value: 'ancien@ex.fr' }]);
  });

  it('accepte une LISTE de destinataires, dans l’ordre (le 1er sera le « À »)', () => {
    const a = actionOf(node({
      emailAccountId: 'a1',
      templateId: 't1',
      to: [{ kind: 'literal', value: 'un@ex.fr' }, { kind: 'field', field: 'email_pro' }],
    }));
    expect((a as { to: unknown }).to).toEqual([{ kind: 'literal', value: 'un@ex.fr' }, { kind: 'field', field: 'email_pro' }]);
  });

  it('TRONQUE à 3 : le bouton « + » du builder n’est pas la garde, un graphe fabriqué en passerait plus', () => {
    const a = actionOf(node({
      emailAccountId: 'a1',
      templateId: 't1',
      to: [1, 2, 3, 4, 5].map((n) => ({ kind: 'literal', value: `d${n}@ex.fr` })),
    }));
    expect((a as { to: unknown[] }).to).toHaveLength(3);
    expect((a as { to: Array<{ value: string }> }).to.map((r) => r.value)).toEqual(['d1@ex.fr', 'd2@ex.fr', 'd3@ex.fr']);
  });

  it('écarte les entrées invalides UNE À UNE : une ligne laissée vide ne prive pas les autres', () => {
    const a = actionOf(node({
      emailAccountId: 'a1',
      templateId: 't1',
      to: [{ kind: 'literal', value: 'bon@ex.fr' }, { kind: 'field', field: '' }, null, { kind: 'literal', value: '' }],
    }));
    expect((a as { to: unknown }).to).toEqual([{ kind: 'literal', value: 'bon@ex.fr' }]);
  });

  it('liste vide, ou dont AUCUNE entrée n’est valide -> null (bloc non configuré)', () => {
    expect(actionOf(node({ emailAccountId: 'a1', templateId: 't1', to: [] }))).toBeNull();
    expect(actionOf(node({ emailAccountId: 'a1', templateId: 't1', to: [{ kind: 'field', field: '' }] }))).toBeNull();
  });

  it('tolère les espaces autour des identifiants (trim) sans changer la validité', () => {
    const a = actionOf(node({ emailAccountId: '  a1  ', templateId: '  t1  ', to: { kind: 'literal', value: 'x@ex.fr' } }));
    expect(a).toEqual({ kind: 'sendEmail', emailAccountId: 'a1', templateId: 't1', to: [{ kind: 'literal', value: 'x@ex.fr' }] });
  });
});

/**
 * Résolution des adresses : c'est elle qui décide QUI reçoit, et à quel titre. Le premier de la liste part en
 * « À », les suivants en copie cachée (`wiring.ts`), donc l'ORDRE compte autant que le contenu.
 */
describe('adressesDestinataires', () => {
  const litt = (v: string): EmailRecipient => ({ kind: 'literal', value: v });
  const champ = (f: string): EmailRecipient => ({ kind: 'field', field: f });

  it('résout les variables sur les champs du contact, et garde l’ordre', () => {
    const out = adressesDestinataires([litt('fixe@ex.fr'), champ('email_pro')], { email_pro: 'pro@ex.fr' });
    expect(out).toEqual(['fixe@ex.fr', 'pro@ex.fr']); // le 1er sera le « À »
  });

  it('une adresse qui résout à VIDE est écartée, les autres partent quand même', () => {
    // Un champ en mode variable lit `contacts.fields`, qui est libre : rien ne garantit qu'il soit renseigné.
    // Sans ce comportement, une 3e ligne mal remplie priverait les deux premières de leur mail.
    const out = adressesDestinataires([litt('ok@ex.fr'), champ('absent'), champ('vide')], { vide: '' });
    expect(out).toEqual(['ok@ex.fr']);
  });

  it('un champ à null (contact hors base) est traité comme vide, sans planter', () => {
    expect(adressesDestinataires([champ('email_pro')], { email_pro: null })).toEqual([]);
  });

  it('écarte les DOUBLONS : la même personne ne reçoit pas deux exemplaires', () => {
    const out = adressesDestinataires(
      [litt('meme@ex.fr'), champ('email_pro'), litt('  meme@ex.fr  ')],
      { email_pro: 'meme@ex.fr' },
    );
    expect(out).toEqual(['meme@ex.fr']);
  });

  it('trime les adresses (une saisie avec une espace de trop reste valide)', () => {
    expect(adressesDestinataires([litt('  a@ex.fr  ')], {})).toEqual(['a@ex.fr']);
  });

  it('aucune adresse résolue -> liste vide (l’appelant n’envoie alors RIEN et le journalise)', () => {
    expect(adressesDestinataires([champ('inconnu')], {})).toEqual([]);
  });
});
