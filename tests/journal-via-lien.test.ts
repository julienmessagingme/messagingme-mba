import { describe, it, expect } from 'vitest';
import { makeJournal, type AuditSink } from '../src/audit/journal';

/**
 * UNE ÉCRITURE FAITE PAR LE LIEN DE CLAUDE CODE LE DIT DANS LE JOURNAL (lot 3c, spec § 2.2). La garde `adminOuLien`
 * pose `viaLien` sur l'autorité ; le journal le recopie dans le détail, pour qu'on sache plus tard que la connexion
 * du numéro est venue du lien et non d'une session de la console.
 */
describe('le journal d’audit et le lien de connexion du numéro', () => {
  const capter = () => {
    const lignes: Array<Record<string, unknown> | undefined> = [];
    const audit: AuditSink = async (_t, _a, _action, _cible, detail) => { lignes.push(detail); };
    return { journal: makeJournal(audit), lignes };
  };

  it('venue du lien : le détail porte `via: lien_claude_code`, à côté du détail de la route', async () => {
    const { journal, lignes } = capter();
    await journal('t1', { auth: { userId: 'u1', viaLien: true } }, 'numero.connecte', { kind: 'phone_number', id: 'pn1' }, { avertissements: 0 });
    expect(lignes).toEqual([{ avertissements: 0, via: 'lien_claude_code' }]);
  });

  it('venue d’une session : le détail est celui d’hier, sans clé de plus', async () => {
    const { journal, lignes } = capter();
    await journal('t1', { auth: { userId: 'u1' } }, 'numero.connecte', { kind: 'phone_number', id: 'pn1' }, { avertissements: 0 });
    expect(lignes).toEqual([{ avertissements: 0 }]);
  });
});
