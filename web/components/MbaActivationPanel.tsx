'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useT } from '@/lib/i18n';
import { cardCls } from '@/lib/ui';
import { MbaNotice } from './MbaNotice';
import {
  getSettings, setMbaHandoffMode, setControlHandbackSeconds,
  DEFAULT_MBA_HANDOFF_MODE, type MbaHandoffMode,
} from '@/lib/api';

/** Défaut du serveur quand rien n'est réglé, en minutes. Sert uniquement au texte d'aide. */
const DEFAUT_REPRISE_MINUTES = 120;

/**
 * Activation : les deux seuls réglages qui décident QUI parle au client, réunis au même endroit.
 *
 * 1. Quand l'agent de Meta passe la main à un humain.
 * 2. Combien de temps un opérateur garde la main après avoir répondu.
 *
 * Deux questions, pas un arbre : ce paramétrage est le plus sensible de l'outil pour quelqu'un qui n'est pas
 * technique, et chaque branche en plus est une occasion de se tromper sur ce que le client va lire.
 *
 * ⚠️ Ce qui n'est PAS promis ici, parce que le code ne peut pas le tenir : empêcher un humain de prendre la
 * main (aucun verrou n'existe, ni chez nous ni chez Meta), et empêcher l'agent de décider un transfert (il
 * décide seul ; « jamais » le fait seulement garder le fil au lieu de le lâcher).
 */
export function MbaActivationPanel({ tenantId }: { tenantId: string }) {
  const t = useT();
  const [mode, setMode] = useState<MbaHandoffMode | null>(null);
  const [reprise, setReprise] = useState('');
  const [chargement, setChargement] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [enregistre, setEnregistre] = useState('');

  useEffect(() => {
    let vivant = true;
    getSettings(tenantId)
      .then((s) => {
        if (!vivant) return;
        setMode(s.mbaHandoffMode ?? DEFAULT_MBA_HANDOFF_MODE);
        setReprise(s.controlHandbackSeconds === null ? '' : String(Math.round(s.controlHandbackSeconds / 60)));
      })
      .catch((e: unknown) => { if (vivant) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (vivant) setChargement(false); });
    return () => { vivant = false; };
  }, [tenantId]);

  async function choisirMode(m: MbaHandoffMode): Promise<void> {
    const avant = mode;
    setMode(m); // optimiste : le choix se voit tout de suite, et revient en arrière si le serveur refuse
    setBusy(true);
    setErr('');
    setEnregistre('');
    try {
      const r = await setMbaHandoffMode(tenantId, m);
      // Le serveur enregistre toujours le choix ; `appliqueChezMeta: false` dit seulement que Meta n'a pas
      // répondu à l'instant. Le balayage rattrapera, mais l'utilisateur doit le savoir plutôt que de croire
      // que c'est déjà effectif.
      setEnregistre(r.appliqueChezMeta
        ? t('Enregistré.', 'Saved.')
        : t('Enregistré. Meta n’a pas répondu : le réglage sera appliqué dans quelques minutes.', 'Saved. Meta did not respond: the setting will be applied within a few minutes.'));
    } catch (e) {
      setMode(avant);
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function enregistrerReprise(): Promise<void> {
    const brut = reprise.trim();
    const minutes = brut === '' ? null : Number(brut);
    if (minutes !== null && (!Number.isInteger(minutes) || minutes < 0)) {
      setErr(t('Durée invalide : un nombre entier de minutes, ou vide pour le défaut.', 'Invalid duration: a whole number of minutes, or empty for the default.'));
      return;
    }
    setBusy(true);
    setErr('');
    setEnregistre('');
    try {
      await setControlHandbackSeconds(tenantId, minutes === null ? null : minutes * 60);
      setEnregistre(t('Enregistré.', 'Saved.'));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (chargement) return <p className="text-sm text-ink-500">{t('Chargement…', 'Loading…')}</p>;

  const choix: Array<{ cle: MbaHandoffMode; titre: string; detail: string }> = [
    {
      cle: 'always',
      titre: t('Il passe la main', 'It hands over'),
      detail: t('La conversation remonte dans « À traiter », dans l’inbox.', 'The conversation shows up under “To handle” in the inbox.'),
    },
    {
      cle: 'business_hours',
      titre: t('Seulement pendant mes heures d’ouverture', 'Only during my opening hours'),
      detail: t('En dehors, l’agent garde la conversation au lieu d’annoncer un conseiller qui n’est pas là.', 'Outside them, the agent keeps the conversation instead of announcing an advisor who is not there.'),
    },
    {
      cle: 'never',
      titre: t('Jamais', 'Never'),
      detail: t('L’agent garde toujours la conversation.', 'The agent always keeps the conversation.'),
    },
  ];

  return (
    <div className="space-y-5">
      {err !== '' && <MbaNotice kind="error" testid="mba-activation-error">{err}</MbaNotice>}
      {enregistre !== '' && err === '' && <MbaNotice kind="success" testid="mba-activation-ok">{enregistre}</MbaNotice>}

      <section className={cardCls}>
        <h3 className="text-sm font-semibold text-ink-900">
          {t('Quand l’agent décide de passer la main', 'When the agent decides to hand over')}
        </h3>
        <p className="mt-1 text-xs text-ink-500">
          {t(
            'C’est l’agent qui décide, à partir de ce que le client écrit : quand celui-ci réclame un humain, ou quand l’agent refuse de traiter la demande (une réclamation avec demande de dédommagement, par exemple, à laquelle il ne répond rien). Ce réglage dit ce qui se passe ensuite.',
            'The agent decides, based on what the customer writes: when they ask for a human, or when the agent declines to handle the request (a complaint asking for compensation, for instance, which it answers with nothing at all). This setting says what happens next.',
          )}
        </p>
        <p className="mt-1 text-xs text-ink-400">
          {t(
            'En revanche, quand l’agent ignore simplement la réponse, il ne passe PAS la main : il renvoie vers les coordonnées de votre base de connaissance. Mesuré le 21/08/2026.',
            'When the agent merely does not know the answer, it does NOT hand over: it points to the contact details from your knowledge base. Measured 2026-08-21.',
          )}
        </p>
        <div className="mt-3 space-y-2" role="radiogroup" aria-label={t('Passage de main', 'Handover')}>
          {choix.map((c) => (
            <label
              key={c.cle}
              data-testid={`handoff-${c.cle}`}
              className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition ${mode === c.cle ? 'border-brand-500 bg-brand-50' : 'border-ink-200 hover:border-ink-300'} ${busy ? 'opacity-60' : ''}`}
            >
              <input
                type="radio"
                name="handoff-mode"
                className="mt-0.5 h-4 w-4 accent-brand-500"
                checked={mode === c.cle}
                disabled={busy}
                onChange={() => { void choisirMode(c.cle); }}
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-ink-800">{c.titre}</span>
                <span className="block text-xs text-ink-500">{c.detail}</span>
                {c.cle === 'business_hours' && mode === 'business_hours' && (
                  <Link href="/parametres" className="mt-1 inline-block text-xs font-medium text-brand-600 underline">
                    {t('Régler mes horaires', 'Set my opening hours')}
                  </Link>
                )}
              </span>
            </label>
          ))}
        </div>
      </section>

      <section className={cardCls}>
        <h3 className="text-sm font-semibold text-ink-900">
          {t('Quand un humain répond, il garde la main pendant', 'When a human replies, they keep the thread for')}
        </h3>
        <p className="mt-1 text-xs text-ink-500">
          {t(
            'Le décompte part de sa PREMIÈRE réponse dans la conversation : répondre à nouveau ne le repousse pas.',
            'The countdown starts at their FIRST reply in the conversation: replying again does not push it back.',
          )}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            data-testid="handback-input"
            type="number"
            min={0}
            step={1}
            value={reprise}
            onChange={(e) => setReprise(e.target.value)}
            onBlur={() => { void enregistrerReprise(); }}
            disabled={busy}
            placeholder={t('par défaut', 'default')}
            className="w-28 rounded-lg border border-ink-300 px-3 py-1.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 disabled:opacity-60"
          />
          <span className="text-sm text-ink-600">{t('minutes', 'minutes')}</span>
        </div>
        <p className="mt-1.5 text-xs text-ink-400">
          {reprise.trim() === ''
            ? t(`Vide : le défaut s’applique (${DEFAUT_REPRISE_MINUTES} minutes).`, `Empty: the default applies (${DEFAUT_REPRISE_MINUTES} minutes).`)
            : reprise.trim() === '0'
              ? t('0 : la main ne revient jamais toute seule. Il faut la rendre depuis la conversation.', '0: control never returns on its own. You must hand it back from the conversation.')
              : t('Passé ce délai, le scénario ou l’agent peut reprendre la parole.', 'After this delay, the scenario or the agent may speak again.')}
        </p>
      </section>
    </div>
  );
}
