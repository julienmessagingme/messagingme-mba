import { describe, it, expect } from 'vitest';
import { systemFieldCode, FRONT_SYSTEM_FIELD_KEYS } from '../web/lib/codes';
import { resolveFieldKey } from '../src/ids/resolve';
import type { FieldLister } from '../src/ids/resolve';
import { SYSTEM_FIELD_KEYS } from '../src/crm/fields';

/**
 * Le générateur de codes de champs système est côté FRONT (la page Champs les affiche), le LECTEUR est côté
 * serveur (`resolveFieldKey`, qui résout un `fld_..._sys_...` sans toucher la base). Ils sont dans deux repos
 * logiques différents et rien ne les relie à la compilation : c'est exactement le genre de couple qui dérive
 * en silence. Ce test les fait dialoguer.
 *
 * Contexte : jusqu'au 2026-07-18 il existait un DEUXIÈME générateur, côté serveur, sans aucun appelant. Le
 * seul test existant couvrait celui-là, donc le générateur réellement utilisé n'était vérifié par rien.
 */
const noFields: FieldLister = { list: async () => [] };

describe('systemFieldCode (générateur front)', () => {
  it('format déterministe et stable : fld_<codeClient>_sys_<clé>', () => {
    expect(systemFieldCode('k7m2p3', 'bsuid')).toBe('fld_k7m2p3_sys_bsuid');
    expect(systemFieldCode('k7m2p3', 'wa_id')).toBe('fld_k7m2p3_sys_wa_id');
    // Déterministe : deux appels identiques donnent le même code (aucun aléa, aucune horloge).
    expect(systemFieldCode('k7m2p3', 'prenom')).toBe(systemFieldCode('k7m2p3', 'prenom'));
  });

  it('le code dépend du tenant : deux clients n’ont jamais le même code pour le même champ', () => {
    expect(systemFieldCode('aaa111', 'email')).not.toBe(systemFieldCode('bbb222', 'email'));
  });
});

describe('aller-retour générateur front -> résolveur serveur', () => {
  // LE test qui compte. Les deux listes de champs système, celle du front et celle du serveur, n'ont aucun
  // lien de compilation. En ajouter un d'un seul côté produirait un code affiché à un client d'API que notre
  // propre API refuserait, en silence. Cette assertion est ce qui l'empêche.
  it('les listes de champs système du front et du serveur sont IDENTIQUES', () => {
    expect([...FRONT_SYSTEM_FIELD_KEYS].sort()).toEqual([...SYSTEM_FIELD_KEYS].sort());
  });

  it('TOUT code produit par le front est résolu par le serveur, sur la bonne clé', async () => {
    // On itère la liste FRONT (celle qui alimente réellement la page Champs), pas la liste serveur : sinon un
    // champ ajouté au front seul ne serait jamais testé, ce qui est exactement le cas qu'on veut attraper.
    for (const key of FRONT_SYSTEM_FIELD_KEYS) {
      const code = systemFieldCode('k7m2p3', key);
      await expect(resolveFieldKey('t1', code, noFields)).resolves.toEqual({ ok: true, key, type: 'text', known: true });
    }
  });

  it('un code `sys_` portant une clé INCONNUE est refusé (le format seul ne suffit pas)', async () => {
    const code = systemFieldCode('k7m2p3', 'nimporte_quoi');
    await expect(resolveFieldKey('t1', code, noFields)).resolves.toEqual({ ok: false, reason: 'not_found' });
  });
});
