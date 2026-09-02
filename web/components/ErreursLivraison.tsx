'use client';

import { useEffect, useState } from 'react';
import { listErreursLivraison, type ErreurLivraison } from '@/lib/api';
import { useT, useLocale } from '@/lib/i18n';
import { formatDate, hourMin } from '@/lib/day';
import { cardCls, inputCls } from '@/lib/ui';
import { toCsv, downloadCsv } from '@/lib/csv';

/**
 * LE JOURNAL DES ERREURS DE LIVRAISON, à côté du journal des actions.
 *
 * Julien, le 2026-09-02 : « utile quand on a des campagnes et qu'on a des messages d'erreur car tel ou tel
 * message n'est pas délivré ». La donnée existait, par destinataire, mais il fallait ouvrir chaque campagne
 * une par une : personne ne le fait, donc personne ne voyait rien.
 *
 * 🔴 IL PORTE LES NUMÉROS, contrairement au journal des actions juste au-dessus, et ce n'est pas une
 * incohérence. Les deux répondent à des questions opposées : l'autre est une preuve immuable de qui a fait
 * quoi, où écrire un numéro annulerait la purge d'un contact ; celui-ci est de l'exploitation, et « quel
 * message n'est pas arrivé » sans dire « à qui » ne répond à rien. Il n'a rien d'immuable, il se lit depuis
 * les destinataires de campagne, et il disparaît avec le contact quand on le purge.
 */

/** Ce que les codes Meta les plus fréquents veulent dire, en français. Les autres s'affichent bruts. */
const CODES: Record<number, [string, string]> = {
  131026: ['numéro non délivrable (pas de WhatsApp, ou refuse les messages)', 'undeliverable number (no WhatsApp, or refuses messages)'],
  131047: ['fenêtre de 24 h fermée : il fallait un template', '24h window closed: a template was required'],
  131049: ['Meta a plafonné le marketing vers cette personne', 'Meta capped marketing to this person'],
  130429: ['débit trop élevé : Meta a freiné l’envoi', 'rate too high: Meta throttled the send'],
  131048: ['qualité du numéro trop basse : Meta a bloqué l’envoi', 'number quality too low: Meta blocked the send'],
  132000: ['le template ne correspond pas aux variables envoyées', 'the template does not match the variables sent'],
  470: ['fenêtre de service expirée', 'service window expired'],
};

export function ErreursLivraison({ tenantId }: { tenantId: string }) {
  const t = useT();
  const { locale } = useLocale();
  const [erreurs, setErreurs] = useState<ErreurLivraison[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saisie, setSaisie] = useState({ q: '', telephone: '' });
  const [filtre, setFiltre] = useState({ q: '', telephone: '' });
  const cherche = filtre.q !== '' || filtre.telephone !== '';

  useEffect(() => {
    let alive = true;
    setErreurs(null);
    listErreursLivraison(tenantId, 100, filtre)
      .then((r) => { if (alive) setErreurs(Array.isArray(r?.erreurs) ? r.erreurs : []); })
      .catch((err: unknown) => { if (alive) setError(err instanceof Error ? err.message : t('Journal illisible', 'Log unreadable')); });
    return () => { alive = false; };
  }, [tenantId, t, filtre]);

  const stamp = (iso: string | null): string => (iso ? `${formatDate(iso, locale)} ${hourMin(iso, locale)}` : '');
  const sens = (code: number | null): string => {
    if (code === null) return '';
    const l = CODES[code];
    return l ? t(...l) : '';
  };

  function exporter(): void {
    const entetes = [t('Date (ISO)', 'Date (ISO)'), t('Campagne', 'Campaign'), t('Numéro', 'Number'), t('Code', 'Code'), t('Message', 'Message'), t('Origine', 'Source')];
    const lignes = (erreurs ?? []).map((e) => [e.at ?? '', e.campaignName ?? '', e.telephone, e.code === null ? '' : String(e.code), e.message ?? '', e.origine]);
    downloadCsv(t('erreurs-de-livraison.csv', 'delivery-errors.csv'), toCsv(entetes, lignes));
  }

  return (
    <section className={cardCls} data-testid="erreurs-livraison">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-ink-900">{t('Erreurs de livraison', 'Delivery errors')}</h3>
          <p className="text-xs text-ink-500">
            {t(
              'Ce que Meta a répondu quand un message n’est pas parti, ou n’est pas arrivé. Contrairement au journal des actions, celui-ci porte les numéros : sans eux, il ne dirait pas à qui.',
              'What Meta answered when a message did not go out, or did not arrive. Unlike the action log, this one carries phone numbers: without them, it would not say to whom.',
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={exporter}
          disabled={!erreurs || erreurs.length === 0}
          data-testid="erreurs-export-csv"
          className="shrink-0 rounded-lg border border-ink-200 px-2.5 py-1 text-xs font-medium text-ink-600 transition hover:bg-ink-50 disabled:opacity-40"
        >
          {t('Exporter en CSV', 'Export to CSV')}
        </button>
      </div>

      <form className="mb-3 flex flex-wrap items-end gap-2" onSubmit={(ev) => { ev.preventDefault(); setFiltre({ ...saisie }); }}>
        <input
          className={`${inputCls} w-44`} data-testid="erreurs-q" value={saisie.q}
          onChange={(e) => setSaisie({ ...saisie, q: e.target.value })}
          placeholder={t('mot-clé, code, campagne', 'keyword, code, campaign')}
        />
        <input
          className={`${inputCls} w-40`} data-testid="erreurs-telephone" value={saisie.telephone}
          onChange={(e) => setSaisie({ ...saisie, telephone: e.target.value })} placeholder={t('numéro du client', 'client number')}
        />
        <button type="submit" data-testid="erreurs-chercher" className="rounded-lg border border-ink-300 px-3 py-1.5 text-xs font-medium text-ink-700 hover:bg-ink-50">
          {t('Chercher', 'Search')}
        </button>
        {cherche && (
          <button
            type="button" data-testid="erreurs-effacer-filtre"
            onClick={() => { setSaisie({ q: '', telephone: '' }); setFiltre({ q: '', telephone: '' }); }}
            className="text-xs text-ink-500 hover:underline"
          >
            {t('tout afficher', 'show all')}
          </button>
        )}
      </form>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {!error && erreurs === null && <p className="text-sm text-ink-400">{t('Chargement…', 'Loading…')}</p>}
      {!error && erreurs?.length === 0 && (
        <p className="text-sm text-ink-400" data-testid="erreurs-vide">
          {cherche
            ? t('Aucune erreur ne correspond.', 'No error matches.')
            : t('Aucune erreur de livraison. C’est la bonne nouvelle.', 'No delivery error. That is the good news.')}
        </p>
      )}

      {erreurs && erreurs.length > 0 && (
        <ul className="max-h-96 divide-y divide-ink-100 overflow-y-auto">
          {erreurs.map((e) => (
            <li key={e.recipientId} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-sm">
              <span className="w-36 shrink-0 text-xs tabular-nums text-ink-400">{stamp(e.at)}</span>
              <span className="rounded px-1.5 py-0.5 text-xs font-medium bg-red-50 text-red-700">
                {e.code === null ? t('erreur', 'error') : e.code}
              </span>
              <span className="font-mono text-xs text-ink-600">{e.telephone}</span>
              <span className="text-xs text-ink-500">{e.campaignName}</span>
              {/* L'ORIGINE distingue trois pannes très différentes : un refus à l'envoi vient de notre appel,
                  un échec de livraison vient du téléphone d'en face, et un échec de scénario ne vient d'aucun
                  des deux, c'est notre traitement du message ENTRANT qui n'a pas abouti. Chercher au mauvais
                  endroit coûte cher. */}
              <span className="text-[11px] text-ink-400">
                {e.origine === 'envoi' && t('jamais parti', 'never sent')}
                {e.origine === 'livraison' && t('parti, non délivré', 'sent, not delivered')}
                {e.origine === 'scenario' && t('scénario bloqué sur une réponse', 'scenario stuck on a reply')}
              </span>
              <span className="w-full text-xs text-ink-600">
                {sens(e.code) || e.message || t('sans détail', 'no detail')}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
