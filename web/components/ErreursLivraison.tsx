'use client';

import { useEffect, useState } from 'react';
import { listErreursLivraison, listErreursSysteme, type ErreurLivraison, type EchecAppelSysteme } from '@/lib/api';
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

/** D'où venait un message libre non délivré : la colonne `origin` du message, en mots. */
const ORIGINES_MESSAGE: Record<string, [string, string]> = {
  humain: ['réponse d’un opérateur', 'operator reply'],
  api: ['envoi par l’API', 'API send'],
  mcp: ['agent branché par MCP', 'MCP agent'],
  scenario: ['bloc de scénario', 'scenario block'],
  ia: ['agent IA', 'AI agent'],
  mba: ['agent de Meta', 'Meta agent'],
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
  /** Le libellé d'une ligne `message` : son canal, et d'où venait le message quand on le sait. */
  const libelleMessage = (e: ErreurLivraison): string => {
    const base = e.canal === 'rcs' ? t('RCS non délivré', 'RCS not delivered') : t('message non délivré', 'message not delivered');
    const origine = e.origineMessage ? ORIGINES_MESSAGE[e.origineMessage] : undefined;
    return origine ? `${base} (${t(...origine)})` : base;
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
              {/* L'ORIGINE distingue quatre pannes très différentes : un refus à l'envoi vient de notre appel,
                  un échec de livraison vient du téléphone d'en face, un échec de scénario ne vient d'aucun
                  des deux, c'est notre traitement du message ENTRANT qui n'a pas abouti, et un message libre
                  non délivré vient du téléphone d'en face, hors de toute campagne. Chercher au mauvais
                  endroit coûte cher. */}
              <span className="text-[11px] text-ink-400">
                {e.origine === 'envoi' && t('jamais parti', 'never sent')}
                {e.origine === 'livraison' && t('parti, non délivré', 'sent, not delivered')}
                {e.origine === 'scenario' && t('scénario bloqué sur une réponse', 'scenario stuck on a reply')}
                {e.origine === 'message' && libelleMessage(e)}
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

/**
 * LA MOITIÉ SYSTÈME DU JOURNAL : ce que VOS systèmes nous ont répondu de travers.
 *
 * 🔴 UNE SECTION À PART, ET PAS DES LIGNES DE PLUS DANS LA PRÉCÉDENTE. Les deux moitiés répondent à des
 * questions opposées : là-haut, « mon message n'est pas arrivé chez mon client » ; ici, « mon CRM a refusé
 * l'appel que Engage Me lui a passé ». Les mélanger obligerait chaque ligne à porter les colonnes vides de
 * l'autre, et ferait chercher un numéro de téléphone là où il n'y en a jamais eu.
 *
 * 🔴 CE QUE CETTE SECTION RÉVÈLE ET QUE PERSONNE NE VOYAIT. Ces lignes sont écrites depuis la migration
 * 0086 et n'étaient LUES PAR PERSONNE. Depuis la 0142, elles couvrent aussi les deux appelants qui ne
 * journalisaient rien du tout : le bloc « Appel HTTP » d'un scénario, et la poussée d'un désabonnement vers
 * votre système.
 */
export function ErreursSysteme({ tenantId }: { tenantId: string }) {
  const t = useT();
  const { locale } = useLocale();
  const [erreurs, setErreurs] = useState<EchecAppelSysteme[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let vivant = true;
    listErreursSysteme(tenantId)
      /**
       * 🔴 LE TYPE MENT SUR UNE DONNÉE DE RÉSEAU, ET CELLE-CI FAISAIT TOMBER LA PAGE ENTIÈRE.
       * `request()` rend ce que le serveur a envoyé, le type n'est qu'une promesse. Une réponse 200 sans
       * `erreurs` (une API plus ancienne que ce composant, un proxy qui répond `{}`) posait `undefined`
       * dans l'état : `erreurs !== null` devenait VRAI, et `erreurs.length` jetait EN PLEIN RENDU. Ce
       * n'est pas cette carte qui tombe alors, c'est tout le centre de Sécurité, y compris le journal des
       * erreurs de livraison à côté, qui n'avait rien demandé.
       *
       * ⚠️ LE CAS EST RÉEL SUR CE PRODUIT, PAS THÉORIQUE : la console part sur Vercel à chaque push et
       * l'API se déploie à la main sur le VPS. Entre les deux, le front est en avance sur le serveur.
       * `ErreursLivraison`, juste au-dessus, se gardait déjà de la même façon ; cette moitié-ci ne l'avait
       * pas. Trouvé le 2026-09-17 en amenant la carte des erreurs Meta sur cette page : la suite E2E est
       * passée de verte à « Application error » sur six tests d'un coup.
       *
       * ⚠️ `[]` ET PAS UNE ERREUR : un corps illisible n'est pas un échec de lecture, la requête a abouti.
       * La distinction « aucun appel en échec » contre « lecture impossible » reste tenue par le `catch`,
       * qui est le seul à savoir que le réseau a vraiment échoué.
       */
      .then((r) => { if (vivant) setErreurs(Array.isArray(r?.erreurs) ? r.erreurs : []); })
      // ⚠️ Une lecture en échec n'est PAS « aucune erreur » : les deux se lisent de façon opposée, et
      // confondre les deux ferait croire que tout va bien.
      .catch((e: unknown) => { if (vivant) setError(e instanceof Error ? e.message : t('Lecture impossible', 'Unable to read')); });
    return () => { vivant = false; };
  }, [tenantId, t]);

  /** QUI a passé l'appel, dit en français : c'est ce qui permet de savoir où aller corriger. */
  const quiAppelait = (source: string): string => {
    if (source === 'agent') return t('un agent IA', 'an AI agent');
    if (source === 'scenario') return t('un bloc « Appel HTTP » d’un scénario', 'a scenario’s HTTP block');
    if (source === 'optout') return t('la poussée d’un désabonnement', 'an unsubscribe push');
    if (source === 'mba') return t('l’agent de Meta', 'Meta’s agent');
    return source;
  };

  /** L'issue, dite en français. `timeout` et « refusé » appellent des corrections opposées. */
  const issue = (statut: string, httpStatus: number | null): string => {
    if (statut === 'timeout') return t('votre système n’a pas répondu à temps', 'your system did not answer in time');
    if (statut === 'budget') return t('budget de l’agent épuisé', 'agent budget exhausted');
    if (statut === 'erreur_protocole') return t('réponse inexploitable', 'unusable response');
    if (httpStatus !== null) return `${t('votre système a répondu', 'your system answered')} ${httpStatus}`;
    return t('l’appel n’a pas abouti', 'the call did not succeed');
  };

  return (
    <section className={cardCls} data-testid="erreurs-systeme">
      <div className="border-b border-ink-100 px-4 py-3">
        <span className="text-sm font-semibold text-ink-900">{t('Erreurs système', 'System errors')}</span>
        <p className="mt-1 text-xs text-ink-500">
          {t(
            'Les appels que Engage Me passe vers VOS systèmes (CRM, ERP, back-office) et qui n’ont pas abouti. Rien à voir avec les messages ci-dessus : ici, personne n’attend au bout d’un téléphone.',
            'Calls Engage Me makes to YOUR systems (CRM, ERP, back-office) that did not succeed. Nothing to do with the messages above: nobody is waiting at the end of a phone here.',
          )}
        </p>
      </div>

      {error !== null && <p className="px-4 py-3 text-sm text-red-700" data-testid="erreurs-systeme-erreur">{error}</p>}
      {error === null && erreurs === null && <p className="px-4 py-3 text-sm text-ink-500">{t('Lecture…', 'Loading…')}</p>}
      {error === null && erreurs !== null && erreurs.length === 0 && (
        <p className="px-4 py-3 text-sm text-ink-500" data-testid="erreurs-systeme-vide">
          {t('Aucun appel en échec. Vos connecteurs répondent.', 'No failed call. Your connectors are answering.')}
        </p>
      )}

      {erreurs !== null && erreurs.length > 0 && (
        <ul className="divide-y divide-ink-100">
          {erreurs.map((e) => (
            <li key={e.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2" data-testid="erreur-systeme-ligne">
              <span className="text-xs text-ink-400">{formatDate(e.at, locale)} {hourMin(e.at, locale)}</span>
              <span className="text-sm text-ink-800">{e.nom}</span>
              <span className="text-xs text-ink-500">{quiAppelait(e.source)}</span>
              <span className="w-full text-xs text-ink-600">
                {issue(e.statut, e.httpStatus)}
                {e.erreur ? ` · ${e.erreur}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
