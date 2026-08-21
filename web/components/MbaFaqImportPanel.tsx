'use client';

import { useRef, useState } from 'react';
import { useT, useLocale } from '@/lib/i18n';
import { cardCls, inputCls } from '@/lib/ui';
import { MbaNotice } from './MbaNotice';
import { MbaFaqImportPreview } from './MbaFaqImportPreview';
import { resumeImport } from '@/lib/mba-faq';
import { importMbaFaq, previewMbaFaqImport, type MbaFaqPreview, type MbaFaqSource } from '@/lib/api-mba';

/**
 * Chargement en lot d'un jeu de questions/réponses, en deux temps : on analyse, on montre, puis seulement on
 * écrit.
 *
 * L'aperçu n'est pas un confort. Chez Meta, la FAQ n'a NI suppression en lot NI corbeille : un import raté se
 * rattrape entrée par entrée à la main. On montre donc ce qui va être créé et modifié avant d'y toucher.
 *
 * ⚠️ INVARIANT : ce qui est envoyé à l'import est EXACTEMENT la charge qui a été prévisualisée (`source`), pas
 * une relecture des champs au moment du clic. Sinon, modifier le texte après l'aperçu ferait écrire quelque
 * chose que personne n'a jamais vu. Toute modification d'un champ invalide donc l'aperçu.
 */

type Mode = 'texte' | 'fichier' | 'url';

export function MbaFaqImportPanel({ tenantId, phoneNumberId, onImported }: {
  tenantId: string;
  phoneNumberId: string;
  onImported: () => void;
}) {
  const t = useT();
  const { locale } = useLocale();
  const [mode, setMode] = useState<Mode>('texte');
  const [csv, setCsv] = useState('');
  const [url, setUrl] = useState('');
  const [nomFichier, setNomFichier] = useState('');
  /** La charge EXACTE qui a été analysée. Null tant qu'aucun aperçu valide n'existe. */
  const [source, setSource] = useState<MbaFaqSource | null>(null);
  const [apercu, setApercu] = useState<MbaFaqPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [resultat, setResultat] = useState<{ kind: 'success' | 'warning'; texte: string } | null>(null);

  /**
   * Numéro de la source courante. Il change à CHAQUE modification, et une analyse dont le numéro n'est plus
   * celui du moment est jetée à son retour.
   *
   * ⚠️ Sans ce compteur, taper pendant qu'une analyse est en vol produisait un écran qui ment : la frappe
   * périmait bien l'aperçu, puis la réponse de l'analyse le RÉARMAIT par-dessus, avec le bouton de
   * confirmation actif, alors que la zone de texte affichait déjà autre chose. L'utilisateur validait un plan
   * périmé présenté comme courant, sur une base de connaissance qui n'a ni corbeille ni suppression en lot.
   */
  const sequence = useRef(0);

  /** Toute modification d'une source périme l'aperçu : on ne peut plus écrire sans réanalyser. */
  function invalider(): void {
    sequence.current += 1;
    setSource(null);
    setApercu(null);
    setResultat(null);
  }

  function chargePrevue(): MbaFaqSource | null {
    if (mode === 'url') return url.trim() === '' ? null : { url: url.trim() };
    return csv.trim() === '' ? null : { csv };
  }

  async function analyser(): Promise<void> {
    const charge = chargePrevue();
    if (charge === null) return;
    const monTour = sequence.current;
    setBusy(true);
    setErr('');
    setResultat(null);
    try {
      const plan = await previewMbaFaqImport(tenantId, phoneNumberId, charge);
      // La source a bougé pendant l'analyse : ce plan décrit un texte que l'écran n'affiche plus. On le jette
      // au lieu de le montrer, l'utilisateur relancera l'analyse sur ce qu'il voit.
      if (sequence.current !== monTour) return;
      setSource(charge);
      setApercu(plan);
    } catch (e) {
      if (sequence.current !== monTour) return;
      setSource(null);
      setApercu(null);
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      // Toujours relâché, même pour une analyse jetée : une seule analyse est en vol à la fois (le bouton est
      // désactivé pendant), donc ne pas le relâcher figerait l'écran.
      setBusy(false);
    }
  }

  async function confirmer(): Promise<void> {
    if (source === null) return;
    setBusy(true);
    setErr('');
    try {
      // ⚠️ `source`, pas les champs : c'est l'invariant de ce panneau.
      const res = await importMbaFaq(tenantId, phoneNumberId, source);
      setResultat(resumeImport(res, locale));
      setApercu(null);
      setSource(null);
      onImported();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const onglet = (m: Mode, label: string) => (
    <button
      key={m}
      data-testid={`mba-import-mode-${m}`}
      onClick={() => { setMode(m); invalider(); }}
      className={`rounded-lg border px-3 py-1.5 text-sm transition ${
        mode === m ? 'border-brand-500 bg-brand-50 font-medium text-brand-700' : 'border-ink-200 text-ink-600 hover:text-ink-900'
      }`}
    >
      {label}
    </button>
  );

  return (
    <section className={`${cardCls} space-y-4`} data-testid="mba-faq-import">
      <div>
        <h3 className="text-sm font-semibold text-ink-900">{t('Charger des questions en lot', 'Bulk load questions')}</h3>
        <p className="mt-1 text-xs leading-relaxed text-ink-600">
          {t(
            'Vos questions existent déjà quelque part : un tableur, une page de site. Chargez-les ici. Rien n’est écrit avant que vous ayez vu ce qui va l’être, et relancer la même source ne crée pas de doublon.',
            'Your questions already exist somewhere: a spreadsheet, a page on your site. Load them here. Nothing is written before you have seen what will be, and re-running the same source creates no duplicates.',
          )}
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {onglet('texte', t('Coller du texte', 'Paste text'))}
        {onglet('fichier', t('Déposer un fichier CSV', 'Drop a CSV file'))}
        {onglet('url', t('Depuis une adresse web', 'From a web address'))}
      </div>

      {mode === 'texte' && (
        <label className="block">
          <span className="text-xs text-ink-500">
            {t('Deux colonnes : la question, puis la réponse.', 'Two columns: the question, then the answer.')}
          </span>
          <textarea
            className={`${inputCls} mt-1.5 font-mono text-xs`}
            rows={8}
            data-testid="mba-import-csv"
            placeholder={t('question,réponse\nLes chiens sont-ils admis ?,Oui, tenus en laisse.', 'question,answer\nAre dogs allowed?,Yes, on a leash.')}
            value={csv}
            onChange={(e) => { setCsv(e.target.value); invalider(); }}
          />
        </label>
      )}

      {mode === 'fichier' && (
        <div>
          <label className="flex cursor-pointer items-center justify-center rounded-lg border border-dashed border-ink-300 px-4 py-6 text-sm text-ink-600 hover:border-brand-400">
            <input
              type="file"
              accept=".csv,text/csv"
              hidden
              data-testid="mba-import-file"
              onChange={(e) => {
                const f = e.target.files?.[0];
                invalider();
                // ⚠️ La lecture du fichier est ASYNCHRONE, et elle change la source en arrivant. Sans le tour
                // capturé ici, deux trous s'ouvraient : la lecture d'un fichier remplacé entre-temps écrasait
                // le bon contenu, et une lecture qui atterrissait APRÈS un clic sur Analyser laissait passer
                // l'aperçu du fichier PRÉCÉDENT, présenté comme décrivant le fichier affiché.
                const monDepot = sequence.current;
                setNomFichier(f?.name ?? '');
                if (!f) { setCsv(''); return; }
                void f.text().then((texte) => {
                  if (sequence.current !== monDepot) return; // un autre fichier a été déposé depuis
                  setCsv(texte);
                  invalider(); // le contenu vient de changer : tout aperçu en vol est périmé
                });
              }}
            />
            {nomFichier === '' ? t('Choisir un fichier .csv', 'Choose a .csv file') : nomFichier}
          </label>
          <p className="mt-1 text-xs text-ink-500">
            {t(
              'Un export de tableur enregistré au format CSV convient. Excel n’est pas lu directement.',
              'A spreadsheet exported as CSV works. Excel files are not read directly.',
            )}
          </p>
        </div>
      )}

      {mode === 'url' && (
        <label className="block">
          <span className="text-xs text-ink-500">
            {t('Une page publique qui porte vos questions et réponses.', 'A public page carrying your questions and answers.')}
          </span>
          <input
            className={`${inputCls} mt-1.5`}
            data-testid="mba-import-url"
            placeholder={t('https://www.exemple.fr/faq', 'https://www.example.com/faq')}
            value={url}
            onChange={(e) => { setUrl(e.target.value); invalider(); }}
          />
        </label>
      )}

      {err !== '' && <MbaNotice kind="error" testid="mba-import-error">{err}</MbaNotice>}
      {resultat !== null && <MbaNotice kind={resultat.kind} testid="mba-import-result">{resultat.texte}</MbaNotice>}

      <div className="flex items-center gap-3">
        <button
          className="rounded-lg border border-ink-300 px-4 py-2 text-sm font-medium text-ink-800 disabled:opacity-50"
          data-testid="mba-import-analyse"
          disabled={busy || chargePrevue() === null}
          onClick={() => void analyser()}
        >
          {busy && apercu === null ? t('Analyse…', 'Analysing…') : t('Analyser', 'Analyse')}
        </button>
        <button
          className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          data-testid="mba-import-confirm"
          disabled={busy || source === null || apercu === null}
          onClick={() => void confirmer()}
        >
          {t('Confirmer l’import', 'Confirm import')}
        </button>
        {source === null && apercu === null && resultat === null && (
          <span className="text-xs text-ink-500">{t('Analysez d’abord pour voir ce qui sera écrit.', 'Analyse first to see what will be written.')}</span>
        )}
      </div>

      {apercu !== null && <MbaFaqImportPreview apercu={apercu} />}
    </section>
  );
}
