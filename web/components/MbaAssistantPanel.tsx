'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '@/lib/i18n';
import { cardCls, inputCls } from '@/lib/ui';
import { MbaNotice } from './MbaNotice';
import {
  appliquerAssistantMba, effacerFilAssistantMba, lireFilAssistantMba, parlerAssistantMba,
  type OperationAssistantMba, type ResultatApplicationMba, type TourAssistantMba,
} from '@/lib/api-mba';

/**
 * L'ASSISTANT DU META BUSINESS AGENT : on lui parle, il propose, on accepte.
 *
 * 🔴 L'ACCEPTATION DU DIFF SUFFIT, PAS DE SECONDE CONFIRMATION (décision de Julien du 2026-09-14). Une
 * confirmation qui suit une acceptation n'ajoute pas de sécurité, elle apprend à cliquer sans lire. Ce qui
 * protège, c'est que le diff NOMME ce qu'il va faire, une ligne par opération.
 *
 * 🔴 UN ONGLET PARMI LES AUTRES, pas un panneau latéral ni la porte d'entrée : on sait toujours où le
 * retrouver, et les repères de ceux qui utilisent déjà l'écran ne bougent pas.
 *
 * ⚠️ IL N'EST JAMAIS LE SEUL CHEMIN. Tout ce qu'il fait reste faisable dans les autres onglets, à la main.
 * C'est la leçon du « Create » d'OpenAI : le jour où cet onglet a disparu, des GPT sont devenus non
 * modifiables du jour au lendemain.
 */
export function MbaAssistantPanel({ tenantId }: { tenantId: string }) {
  const t = useT();
  const [messages, setMessages] = useState<TourAssistantMba[]>([]);
  const [accueil, setAccueil] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [saisie, setSaisie] = useState('');
  const [diff, setDiff] = useState<OperationAssistantMba[]>([]);
  const [resultat, setResultat] = useState<ResultatApplicationMba | null>(null);
  const [chargement, setChargement] = useState(true);
  const [busy, setBusy] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [budgetEpuise, setBudgetEpuise] = useState(false);
  const finDuFil = useRef<HTMLDivElement>(null);

  const charger = useCallback(async () => {
    setChargement(true);
    try {
      const f = await lireFilAssistantMba(tenantId);
      setMessages(f.messages);
      setAccueil(f.accueil);
      setTotal(f.total);
      setBudgetEpuise(f.budgetEpuise);
    } catch (e) {
      setErreur(e instanceof Error ? e.message : t('Assistant indisponible', 'Assistant unavailable'));
    } finally {
      setChargement(false);
    }
  }, [tenantId, t]);

  useEffect(() => { void charger(); }, [charger]);
  // ⚠️ On suit la fin du fil à chaque message : sans ça, la réponse arrive hors de l'écran et l'assistant
  // a l'air muet.
  useEffect(() => { finDuFil.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages.length, diff.length]);

  async function envoyer() {
    const texte = saisie.trim();
    if (texte === '' || busy) return;
    setBusy(true);
    setErreur(null);
    setResultat(null);
    // Optimiste : le message de l'utilisateur apparaît tout de suite, sinon l'écran a l'air figé.
    setMessages((m) => [...m, { role: 'user', content: texte }]);
    setSaisie('');
    try {
      const r = await parlerAssistantMba(tenantId, texte);
      setMessages((m) => [...m, { role: 'assistant', content: r.message }]);
      setDiff(r.operations);
      if (r.budgetEpuise) setBudgetEpuise(true);
    } catch (e) {
      setErreur(e instanceof Error ? e.message : t('Réponse impossible', 'Unable to answer'));
    } finally {
      setBusy(false);
    }
  }

  async function appliquer() {
    if (diff.length === 0 || busy) return;
    setBusy(true);
    setErreur(null);
    try {
      const r = await appliquerAssistantMba(tenantId, diff);
      setResultat(r);
      // 🔴 LE DIFF DISPARAÎT MÊME EN CAS D'ÉCHEC PARTIEL : le reproposer tel quel ferait réappliquer ce qui
      // est déjà passé. C'est l'assistant qui repropose, à partir de l'état relu.
      setDiff([]);
    } catch (e) {
      setErreur(e instanceof Error ? e.message : t('Application impossible', 'Unable to apply'));
    } finally {
      setBusy(false);
    }
  }

  async function repartir() {
    if (!window.confirm(t('Effacer cette conversation ? Rien de ce qui a déjà été appliqué ne sera annulé.',
      'Clear this conversation? Nothing already applied will be undone.'))) return;
    await effacerFilAssistantMba(tenantId);
    setMessages([]); setDiff([]); setResultat(null);
    await charger();
  }

  if (chargement) return <p className="text-sm text-ink-500">{t('Chargement…', 'Loading…')}</p>;

  return (
    <div className={cardCls}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-ink-900">{t('Assistant', 'Assistant')}</h3>
          <p className="mt-1 text-sm text-ink-500">
            {t('Dites-lui ce que vous voulez changer. Il propose, vous acceptez.',
              'Tell it what you want to change. It proposes, you accept.')}
          </p>
        </div>
        {messages.length > 0 && (
          <button onClick={() => { void repartir(); }} className="shrink-0 text-xs text-ink-400 hover:text-ink-700">
            {t('Repartir de zéro', 'Start over')}
          </button>
        )}
      </div>

      {erreur && <MbaNotice kind="error">{erreur}</MbaNotice>}

      {/* 🔴 LE PLAFOND SE DIT, ET IL DIT AUSSI QUE LES ONGLETS RESTENT : une limite volontaire qu'on
          présenterait comme une panne se retournerait contre nous le jour où ça se sait. */}
      {budgetEpuise && (
        <MbaNotice kind="warning">
          {t('L’assistant a atteint sa limite pour ce mois-ci. Tous les onglets restent utilisables.',
            'The assistant reached its limit for this month. Every tab remains usable.')}
        </MbaNotice>
      )}

      {/* ⚠️ Le total est dit quand il dépasse ce qui est affiché : sans ça, l'écran laisserait croire que le
          reste de la conversation n'existe plus. */}
      {total > messages.length && (
        <p className="mt-3 text-xs text-ink-400">
          {t(`${total} messages au total, les ${messages.length} derniers sont affichés.`,
            `${total} messages in total, showing the last ${messages.length}.`)}
        </p>
      )}

      <div className="mt-4 max-h-[26rem] space-y-3 overflow-y-auto pr-1" data-testid="mba-assistant-fil">
        {messages.length === 0 && accueil && (
          <Bulle role="assistant">{accueil}</Bulle>
        )}
        {messages.map((m, i) => (
          // eslint-disable-next-line react/no-array-index-key
          <Bulle key={i} role={m.role}>{m.content}</Bulle>
        ))}
        <div ref={finDuFil} />
      </div>

      {diff.length > 0 && <Diff operations={diff} busy={busy} onAppliquer={() => { void appliquer(); }} />}
      {resultat && <Resultat resultat={resultat} />}

      <div className="mt-4 flex gap-2">
        <input
          className={inputCls}
          data-testid="mba-assistant-saisie"
          value={saisie}
          disabled={busy || budgetEpuise}
          placeholder={t('Par exemple : ajoute mes horaires du samedi', 'For example: add my Saturday hours')}
          onChange={(e) => setSaisie(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void envoyer(); } }}
        />
        <button
          onClick={() => { void envoyer(); }}
          disabled={busy || budgetEpuise || saisie.trim() === ''}
          data-testid="mba-assistant-envoyer"
          className="shrink-0 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {busy ? t('…', '…') : t('Envoyer', 'Send')}
        </button>
      </div>
    </div>
  );
}

function Bulle({ role, children }: { role: 'user' | 'assistant'; children: React.ReactNode }) {
  const moi = role === 'user';
  return (
    <div className={`flex ${moi ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm ${
        moi ? 'bg-brand-600 text-white' : 'bg-ink-50 text-ink-800'
      }`}>
        {children}
      </div>
    </div>
  );
}

/**
 * LE DIFF : une ligne par opération, déjà rédigée par le serveur.
 *
 * 🔴 UN SEUL BOUTON, ET PAS DE SECONDE CONFIRMATION. Ce qui protège n'est pas un second clic, c'est que
 * chaque ligne NOMME ce qu'elle va faire. Une suppression est signalée à part, parce qu'elle est la seule
 * chose qu'on ne peut pas défaire : Meta n'a pas de corbeille.
 */
function Diff({ operations, busy, onAppliquer }: {
  operations: OperationAssistantMba[];
  busy: boolean;
  onAppliquer: () => void;
}) {
  const t = useT();
  return (
    <div className="mt-4 rounded-xl border border-ink-200 p-4" data-testid="mba-assistant-diff">
      <p className="text-sm font-medium text-ink-800">{t('Ce que je vais faire', 'What I will do')}</p>
      <ul className="mt-2 space-y-1.5">
        {operations.map((o, i) => {
          const suppression = o.type.endsWith('.supprimer');
          return (
            // eslint-disable-next-line react/no-array-index-key
            <li key={i} className={`text-sm ${suppression ? 'text-coral' : 'text-ink-700'}`}>
              {suppression ? '− ' : '+ '}{o.libelle}
              {suppression && (
                <span className="ml-1 text-xs text-ink-500">
                  {t('(définitif : Meta ne garde pas de copie)', '(permanent: Meta keeps no copy)')}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <button
        onClick={onAppliquer}
        disabled={busy}
        data-testid="mba-assistant-appliquer"
        className="mt-3 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
      >
        {t('Appliquer', 'Apply')}
      </button>
    </div>
  );
}

/**
 * CE QUI S'EST PASSÉ : passé, échoué, non tenté.
 *
 * 🔴 LES TROIS LISTES SONT MONTRÉES TELLES QUELLES. Meta n'offre aucune transaction : quand une opération
 * échoue, les précédentes sont déjà passées. Afficher un simple « échec » ferait croire que rien n'a bougé.
 */
function Resultat({ resultat }: { resultat: ResultatApplicationMba }) {
  const t = useT();
  return (
    <div className="mt-4 rounded-xl border border-ink-200 p-4 text-sm" data-testid="mba-assistant-resultat">
      {resultat.passees.length > 0 && (
        <>
          <p className="font-medium text-ink-800">{t('Fait', 'Done')}</p>
          <ul className="mt-1 space-y-0.5 text-ink-600">
            {resultat.passees.map((l) => <li key={l}>✓ {l}</li>)}
          </ul>
        </>
      )}
      {resultat.echec && (
        <div className="mt-3 rounded-lg bg-red-50 px-3 py-2">
          <p className="font-medium text-red-800">{t('Arrêté sur', 'Stopped at')} : {resultat.echec.libelle}</p>
          <p className="mt-0.5 text-red-700">{resultat.echec.message}</p>
        </div>
      )}
      {resultat.nonTentees.length > 0 && (
        <>
          <p className="mt-3 font-medium text-ink-800">{t('Non tenté', 'Not attempted')}</p>
          <ul className="mt-1 space-y-0.5 text-ink-500">
            {resultat.nonTentees.map((l) => <li key={l}>· {l}</li>)}
          </ul>
        </>
      )}
    </div>
  );
}
