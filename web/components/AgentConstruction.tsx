'use client';

import { useState } from 'react';
import { useT } from '@/lib/i18n';
import { cardCls, inputCls } from '@/lib/ui';
import { MbaNotice } from '@/components/MbaNotice';
import {
  parlerAuConstructeur, type Changement, type PropositionConstruction, type TourConstruction,
} from '@/lib/api-agent-setup';

/**
 * L'onglet CONSTRUCTION : l'assistant qui règle l'agent en discutant.
 *
 * 🔴 IL PROPOSE, LE CLIENT CORRIGE, ET RIEN NE S'ÉCRIT SANS UN CLIC. C'est le seul point de cet écran qui ne
 * se négocie pas. Le client sait dire son métier et ce qu'on lui demande ; il ne sait pas dire son périmètre
 * de refus, ses règles d'arrêt, ni écrire la description d'un outil, et c'est là que se joue la qualité de
 * l'agent. L'assistant déduit donc plutôt qu'il n'interroge, et chaque proposition passe par un diff que le
 * client garde ou jette. L'inverse (écrire en silence, comme le fait le GPT Builder) ferait un réglage que
 * personne ne peut relire ni défaire.
 *
 * La conversation n'est pas persistée : elle vit dans cet onglet, et tout ce qu'elle produit atterrit dans
 * les autres, éditable champ par champ.
 */
export function AgentConstruction({ tenantId, agentId, onApplique }: {
  tenantId: string;
  agentId: string;
  /** Applique la proposition. Rendu par l'écran parent : c'est LUI qui porte le verrou de version. */
  onApplique: (p: PropositionConstruction) => Promise<void>;
}) {
  const t = useT();
  const [tours, setTours] = useState<TourConstruction[]>([]);
  const [saisie, setSaisie] = useState('');
  const [busy, setBusy] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [changements, setChangements] = useState<Changement[] | null>(null);
  const [proposition, setProposition] = useState<PropositionConstruction | null>(null);

  async function envoyer(texte: string) {
    const propre = texte.trim();
    if (propre === '' || busy) return;
    const suite: TourConstruction[] = [...tours, { role: 'user', content: propre }];
    setTours(suite);
    setSaisie('');
    setBusy(true);
    setErreur(null);
    setChangements(null);
    setProposition(null);
    try {
      const r = await parlerAuConstructeur(tenantId, agentId, suite);
      setTours([...suite, { role: 'assistant', content: r.message }]);
      setProposition(r.proposition);
      setChangements(r.changements);
    } catch (err) {
      setErreur(err instanceof Error ? err.message : t('L’assistant n’a pas répondu', 'The assistant did not answer'));
    } finally {
      setBusy(false);
    }
  }

  async function garder() {
    if (!proposition || busy) return;
    setBusy(true);
    setErreur(null);
    try {
      await onApplique(proposition);
      setChangements(null);
      setProposition(null);
      setTours((t0) => [...t0, { role: 'assistant', content: t('C’est enregistré.', 'Saved.') }]);
    } catch (err) {
      setErreur(err instanceof Error ? err.message : t('Enregistrement impossible', 'Unable to save'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <MbaNotice kind="warning">
        {t(
          'L’assistant ne change RIEN tout seul. Il propose, vous voyez exactement ce que ça changerait, et vous gardez ou vous jetez. Tout ce qu’il écrit reste modifiable dans les autres onglets.',
          'The assistant changes NOTHING on its own. It proposes, you see exactly what would change, and you keep it or drop it. Everything it writes stays editable in the other tabs.',
        )}
      </MbaNotice>
      {erreur && <MbaNotice kind="error" testid="setup-erreur">{erreur}</MbaNotice>}

      <div className={`${cardCls} flex flex-col gap-3`}>
        {tours.length === 0 && (
          <div data-testid="setup-vide" className="flex flex-col gap-2">
            <p className="text-sm text-ink-700">
              {t('Dites-lui ce que votre agent doit faire, dans vos mots.', 'Tell it what your agent should do, in your own words.')}
            </p>
            <div className="flex flex-wrap gap-2">
              {[
                t('Mon agent répond aux questions sur nos séjours et prend des rendez-vous.', 'My agent answers questions about our stays and books appointments.'),
                t('Il qualifie les demandes de devis, puis passe la main à un commercial.', 'It qualifies quote requests, then hands over to a salesperson.'),
              ].map((exemple) => (
                <button
                  key={exemple}
                  data-testid="setup-exemple"
                  disabled={busy}
                  onClick={() => void envoyer(exemple)}
                  className="rounded-lg border border-ink-300 px-3 py-1.5 text-left text-xs text-ink-700 hover:bg-ink-50 disabled:opacity-40"
                >
                  {exemple}
                </button>
              ))}
            </div>
          </div>
        )}

        {tours.map((tour, i) => (
          <div
            key={`${i}-${tour.content.slice(0, 24)}`}
            data-testid={`setup-tour-${tour.role}`}
            className={tour.role === 'user'
              ? 'self-end max-w-[85%] rounded-2xl bg-brand-600 px-3 py-2 text-sm text-white'
              : 'self-start max-w-[85%] rounded-2xl bg-ink-100 px-3 py-2 text-sm text-ink-800'}
          >
            {tour.content}
          </div>
        ))}
        {busy && <p className="text-xs text-ink-500">{t('L’assistant réfléchit…', 'The assistant is thinking…')}</p>}

        <div className="flex flex-wrap gap-2">
          <input
            data-testid="setup-saisie"
            className={`${inputCls} flex-1`}
            value={saisie}
            disabled={busy}
            onChange={(e) => setSaisie(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void envoyer(saisie); }}
            placeholder={t('Votre réponse…', 'Your answer…')}
          />
          <button
            data-testid="setup-envoyer"
            disabled={busy || saisie.trim() === ''}
            onClick={() => void envoyer(saisie)}
            className="rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-40"
          >
            {t('Envoyer', 'Send')}
          </button>
        </div>
      </div>

      {changements !== null && <Diff changements={changements} busy={busy} onGarder={garder} onJeter={() => { setChangements(null); setProposition(null); }} />}
    </div>
  );
}

/** Le diff. C'est LE garde-fou de cette surface : rien ne s'écrit sans qu'il ait été montré. */
function Diff({ changements, busy, onGarder, onJeter }: {
  changements: Changement[]; busy: boolean; onGarder: () => void; onJeter: () => void;
}) {
  const t = useT();
  if (changements.length === 0) {
    return (
      <p data-testid="setup-sans-changement" className="text-sm text-ink-500">
        {t('Rien à changer pour l’instant.', 'Nothing to change for now.')}
      </p>
    );
  }
  return (
    <div data-testid="setup-diff" className={`${cardCls} flex flex-col gap-3`}>
      <p className="text-sm font-medium text-ink-700">{t('Ce que ça changerait', 'What this would change')}</p>
      {changements.map((c) => (
        <div key={c.champ} data-testid={`setup-diff-${c.champ}`} className="flex flex-col gap-1 rounded-lg border border-ink-200 px-3 py-2">
          <p className="text-xs font-medium text-ink-700">{c.label}</p>
          {c.avant !== '' && (
            <p className="whitespace-pre-wrap text-xs text-ink-500 line-through">{c.avant}</p>
          )}
          <p className="whitespace-pre-wrap text-sm text-ink-800">{c.apres}</p>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <button
          data-testid="setup-garder"
          disabled={busy}
          onClick={onGarder}
          className="rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-40"
        >
          {t('Garder', 'Keep')}
        </button>
        <button
          data-testid="setup-jeter"
          disabled={busy}
          onClick={onJeter}
          className="rounded-lg border border-ink-300 px-3 py-2 text-sm text-ink-700 hover:bg-ink-50 disabled:opacity-40"
        >
          {t('Jeter', 'Drop')}
        </button>
      </div>
    </div>
  );
}
