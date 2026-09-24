import { describe, it, expect } from 'vitest';
import { envoyerRcsLibre, phraseOperateur, type DepsRcsLibre } from '../src/rcs/envoyer-libre';
import { TTL_MS } from '../src/rcs/reachability';
import type { RcsOutbound } from '../src/rcs/types';
import type { RcsSendOutcome } from '../src/rcs/sender';

/**
 * L'ENVOI RCS LIBRE (spec 2026-09-24, § 4) : UN chemin pour le bouton RCS de l'Inbox et `POST /v1/messages/rcs`.
 * La garde de consentement ne vise que la MACHINE, jamais l'opérateur.
 */
interface Monde {
  desabonne: boolean;
  desabonneRcs: boolean;
  consentiOuEcrit: boolean;
  agent: string | null;
  joignabilite: { reachable: boolean; checkedAt: number } | null;
  message: { content: RcsOutbound | null } | null;
  issue: RcsSendOutcome;
}

const MAINTENANT = 1_800_000_000_000;
const MONDE: Monde = {
  desabonne: false, desabonneRcs: false, consentiOuEcrit: true, agent: 'agent-1',
  joignabilite: null, message: null, issue: { messageId: 'rcs-1' },
};
const NUMERO = '33612345678';

function monde(over: Partial<Monde> = {}) {
  const m: Monde = { ...MONDE, ...over };
  const envois: Array<{ agentId: string; waId: string; msg: RcsOutbound; id: string; jeton?: string }> = [];
  const lectures: string[] = [];
  const deps: DepsRcsLibre = {
    agentIdForTenant: async () => m.agent,
    estDesabonne: async (_t, waId) => { lectures.push(`desabonne:${waId}`); return m.desabonne; },
    estDesabonneRcs: async (_t, e164) => { lectures.push(`desabonneRcs:${e164}`); return m.desabonneRcs; },
    aConsentiOuEcrit: async (_t, waId) => { lectures.push(`consentement:${waId}`); return m.consentiOuEcrit; },
    lireJoignabilite: async (agentId, e164) => { lectures.push(`joignabilite:${agentId}:${e164}`); return m.joignabilite; },
    lireMessageRcs: async () => m.message,
    variablesDeLaFiche: async () => ({ prenom: 'Camille' }),
    jetonDuContact: async () => 'jeton-1',
    envoyer: async (_t, agentId, waId, msg, id, jeton) => {
      envois.push({ agentId, waId, msg, id, ...(jeton ? { jeton } : {}) });
      return m.issue;
    },
    nouvelId: () => 'id-1',
    maintenant: () => MAINTENANT,
  };
  return { deps, envois, lectures };
}

describe('envoyerRcsLibre : le consentement d’une MACHINE', () => {
  it('a consenti ou a écrit : le RCS part, au wa_id, sous un identifiant neuf', async () => {
    const { deps, envois } = monde();
    expect(await envoyerRcsLibre(deps, 't1', NUMERO, { text: 'Bonjour' }, 'api')).toEqual({ messageId: 'rcs-1', apercu: 'Bonjour' });
    expect(envois).toEqual([{ agentId: 'agent-1', waId: NUMERO, msg: { kind: 'text', text: 'Bonjour' }, id: 'id-1' }]);
  });

  it('🔴 ni consenti ni écrit : no_consent, et RIEN ne part', async () => {
    const { deps, envois, lectures } = monde({ consentiOuEcrit: false });
    expect(await envoyerRcsLibre(deps, 't1', NUMERO, { text: 'Bonjour' }, 'api')).toEqual({ refus: 'no_consent' });
    expect(lectures).toContain(`consentement:${NUMERO}`);
    expect(envois).toEqual([]);
  });

  it('🔴 désabonné du RCS : opted_out, même consenti, AVANT le consentement', async () => {
    const { deps, envois, lectures } = monde({ desabonneRcs: true });
    expect(await envoyerRcsLibre(deps, 't1', NUMERO, { text: 'Bonjour' }, 'api')).toEqual({ refus: 'opted_out' });
    expect(lectures).toContain('desabonneRcs:+33612345678');
    expect(lectures).not.toContain(`consentement:${NUMERO}`);
    expect(envois).toEqual([]);
  });

  it('désabonné en général : opted_out', async () => {
    const { deps, envois } = monde({ desabonne: true });
    expect(await envoyerRcsLibre(deps, 't1', NUMERO, { text: 'Bonjour' }, 'api')).toEqual({ refus: 'opted_out' });
    expect(envois).toEqual([]);
  });
});

describe('envoyerRcsLibre : l’OPÉRATEUR n’est pas une machine', () => {
  it('🔴 ni le consentement, ni le désabonnement général, ni le cache de joignabilité ne sont lus, et le message part', async () => {
    const { deps, envois, lectures } = monde({ consentiOuEcrit: false, desabonne: true });
    expect(await envoyerRcsLibre(deps, 't1', NUMERO, { text: 'Bonjour' }, 'humain')).toEqual({ messageId: 'rcs-1', apercu: 'Bonjour' });
    expect(lectures).toEqual([]);
    expect(envois).toHaveLength(1);
  });

  it('le STOP RCS l’arrête quand même, par le point de passage unique de l’envoi', async () => {
    const { deps } = monde({ issue: { skipped: 'rcs_optout' } });
    expect(await envoyerRcsLibre(deps, 't1', NUMERO, { text: 'Bonjour' }, 'humain')).toEqual({ refus: 'opted_out' });
  });
});

describe('envoyerRcsLibre : les conditions communes', () => {
  it('pas de numéro (un BSUID) : no_phone, avant toute lecture', async () => {
    const { deps, lectures } = monde();
    expect(await envoyerRcsLibre(deps, 't1', 'BSUID.abc', { text: 'Bonjour' }, 'api')).toEqual({ refus: 'no_phone' });
    expect(lectures).toEqual([]);
  });

  it('canal éteint : rcs_not_enabled', async () => {
    const { deps, envois } = monde({ agent: null });
    expect(await envoyerRcsLibre(deps, 't1', NUMERO, { text: 'Bonjour' }, 'humain')).toEqual({ refus: 'rcs_not_enabled' });
    expect(envois).toEqual([]);
  });

  it('🔴 injoignable connu et récent : la MACHINE est refusée, l’OPÉRATEUR part comme avant (spec § 17)', async () => {
    const injoignable = { joignabilite: { reachable: false, checkedAt: MAINTENANT - 1000 } };
    const api = monde(injoignable);
    expect(await envoyerRcsLibre(api.deps, 't1', NUMERO, { text: 'Bonjour' }, 'api')).toEqual({ refus: 'rcs_unreachable' });
    expect(api.envois).toEqual([]);
    // Le bouton RCS de l'Inbox doit rester identique : l'opérateur n'est jamais refusé sur le cache.
    const humain = monde(injoignable);
    expect(await envoyerRcsLibre(humain.deps, 't1', NUMERO, { text: 'Bonjour' }, 'humain')).toEqual({ messageId: 'rcs-1', apercu: 'Bonjour' });
    expect(humain.envois).toHaveLength(1);
  });

  it('injoignable PÉRIMÉ (au-delà de TTL_MS) : on retente', async () => {
    const { deps, envois } = monde({ joignabilite: { reachable: false, checkedAt: MAINTENANT - TTL_MS - 1 } });
    expect(await envoyerRcsLibre(deps, 't1', NUMERO, { text: 'Bonjour' }, 'api')).toEqual({ messageId: 'rcs-1', apercu: 'Bonjour' });
    expect(envois).toHaveLength(1);
  });

  it('le fournisseur dit non joignable : rcs_unreachable', async () => {
    const { deps } = monde({ issue: { skipped: 'not_rcs_reachable' } });
    expect(await envoyerRcsLibre(deps, 't1', NUMERO, { text: 'Bonjour' }, 'api')).toEqual({ refus: 'rcs_unreachable' });
  });
});

describe('envoyerRcsLibre : le contenu', () => {
  it('texte libre : aucune substitution, une accolade tapée reste une accolade', async () => {
    const { deps, envois } = monde();
    await envoyerRcsLibre(deps, 't1', NUMERO, { text: 'Prix {{prenom}}' }, 'humain');
    expect(envois[0]!.msg).toEqual({ kind: 'text', text: 'Prix {{prenom}}' });
  });

  it('message de la bibliothèque : variables résolues sur la fiche', async () => {
    const { deps, envois } = monde({ message: { content: { kind: 'text', text: 'Bonjour {{prenom}}' } } });
    expect(await envoyerRcsLibre(deps, 't1', NUMERO, { rcsMessageId: 'm1' }, 'humain')).toEqual({ messageId: 'rcs-1', apercu: 'Bonjour Camille' });
    expect(envois[0]!.msg).toEqual({ kind: 'text', text: 'Bonjour Camille' });
  });

  it('message supprimé ou illisible : rcs_message_not_found', async () => {
    expect(await envoyerRcsLibre(monde({ message: null }).deps, 't1', NUMERO, { rcsMessageId: 'm1' }, 'humain')).toEqual({ refus: 'rcs_message_not_found' });
    expect(await envoyerRcsLibre(monde({ message: { content: null } }).deps, 't1', NUMERO, { rcsMessageId: 'm1' }, 'humain')).toEqual({ refus: 'rcs_message_not_found' });
  });

  it('le jeton du contact n’est lu que si le message porte un lien tracé', async () => {
    const lien: RcsOutbound = { kind: 'text', text: 'Voir', suggestions: [{ kind: 'openUrl', text: 'Ouvrir', url: 'https://exemple.fr/offre', postbackData: 'o' }] };
    const avec = monde({ message: { content: lien } });
    await envoyerRcsLibre(avec.deps, 't1', NUMERO, { rcsMessageId: 'm1' }, 'humain');
    expect(avec.envois[0]!.jeton).toBe('jeton-1');
    const sans = monde();
    await envoyerRcsLibre(sans.deps, 't1', NUMERO, { text: 'Bonjour' }, 'humain');
    expect(sans.envois[0]!.jeton).toBeUndefined();
  });
});

describe('phraseOperateur', () => {
  it('🔴 les phrases que l’opérateur lisait déjà ne changent pas', () => {
    expect(phraseOperateur('rcs_not_enabled')).toBe("Le canal RCS n'est pas activé sur cet espace (page d'accueil, sous le numéro WhatsApp).");
    expect(phraseOperateur('rcs_message_not_found')).toBe('Ce message RCS n’existe plus, ou son format n’est plus reconnu.');
    expect(phraseOperateur('opted_out')).toBe('Ce contact s’est désabonné du RCS (il a répondu STOP). Passez par WhatsApp.');
    expect(phraseOperateur('rcs_unreachable')).toBe('Ce contact n’est pas joignable en RCS.');
  });
});
