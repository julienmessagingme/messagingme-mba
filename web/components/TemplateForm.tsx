'use client';

import { useEffect, useRef, useState } from 'react';
import { WhatsAppPreview } from '@/components/WhatsAppPreview';
import { FlowBuilder } from '@/components/FlowBuilder';
import {
  useTemplateBody, TemplateBodyField, TemplateVariableExamples, labelForSource, unmappedVariablesMessage,
} from '@/components/TemplateBodyField';
import { listFlows, createTemplate, updateTemplate, uploadMedia, getTemplateHints, type TemplateSummary, type TemplateButtonInput, type TemplateHeaderInput, type FlowSummary, type TemplateParamHint } from '@/lib/api';
import { resizeToDataUrl, fileToDataUrl } from '@/lib/image';
import { isSendableButtonUrl } from '@/lib/button-url';
import { useT } from '@/lib/i18n';
import { META_TEMPLATE_LANGUAGES } from '@/lib/languages';

/**
 * Formulaire de creation (et d'edition) d'un template Meta.
 *
 * Extrait tel quel de `web/app/templates/page.tsx`, sans retouche de logique, pour etre reutilise depuis
 * l'ecran Campagne : on y cree un template sans quitter la campagne en cours. Le corps et ses variables
 * vivent dans `TemplateBodyField` : le formulaire CAROUSEL s'en sert aussi, à l'identique.
 */

const inputCls =
  'w-full rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';

/** Ce qu'un template neuf renvoie a l'appelant. `status` vaut PENDING chez Meta : il n'est PAS envoyable. */
export interface CreatedTemplate { name: string; language: string; status: string }

export function TemplateForm({ tenantId, onCreated, initial }: {
  tenantId: string;
  onCreated: (created?: CreatedTemplate) => void;
  initial?: TemplateSummary;
}) {
  const t = useT();
  const isEdit = !!initial;
  const [name, setName] = useState(initial?.name ?? '');
  const [category, setCategory] = useState<'MARKETING' | 'UTILITY'>((initial?.category?.toUpperCase() as 'MARKETING' | 'UTILITY') ?? 'MARKETING');
  const [language, setLanguage] = useState(initial?.language ?? 'fr');
  // Corps + variables (chips, sélecteur de champ, exemples, indices) : logique PARTAGÉE avec le carousel.
  const bodyState = useTemplateBody(tenantId, { ...(initial?.body ? { body: initial.body } : {}), ...(initial?.example ? { example: initial.example } : {}) });
  const { body } = bodyState;
  const [buttons, setButtons] = useState<TemplateButtonInput[]>(initial?.buttons ?? []);
  // En-tête : en édition seuls les templates à en-tête TEXTE (ou sans) sont éditables (média non re-téléchargeable).
  const [headerType, setHeaderType] = useState<'none' | 'TEXT' | 'IMAGE' | 'VIDEO'>(initial?.headerFormat === 'TEXT' ? 'TEXT' : 'none');
  const [headerText, setHeaderText] = useState(initial?.headerText ?? '');
  const [headerHandle, setHeaderHandle] = useState('');
  const [headerFileName, setHeaderFileName] = useState('');
  // Source affichable (object URL) du média choisi -> vrai visuel dans l'aperçu (l'upload ne renvoie qu'un handle
  // Meta opaque, non affichable). Gérée via une ref pour révoquer l'ancienne URL (pas de fuite mémoire).
  const [headerPreviewUrl, setHeaderPreviewUrl] = useState('');
  const headerPreviewRef = useRef<string>('');
  const [headerUploading, setHeaderUploading] = useState(false);
  const [footer, setFooter] = useState(initial?.footer ?? '');
  const headerFileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [pubFlows, setPubFlows] = useState<FlowSummary[]>([]);
  const [creatingFlow, setCreatingFlow] = useState(false);
  const hasFlow = buttons.some((b) => b.type === 'FLOW');

  useEffect(() => {
    listFlows(tenantId)
      .then(({ flows }) => setPubFlows(flows.filter((f) => f.status === 'PUBLISHED')))
      .catch(() => setPubFlows([]));
  }, [tenantId]);

  // Restauration des indices variable->champ à l'ÉDITION (chips + re-save). Les champs du sélecteur, eux,
  // sont chargés par `useTemplateBody`.
  useEffect(() => {
    if (!initial) return;
    let alive = true;
    getTemplateHints(tenantId, initial.name, initial.language)
      .then(({ hints }) => {
        if (!alive || hints.length === 0) return;
        bodyState.setVarSources((prev) => {
          const next = [...prev];
          for (const h of hints) next[h.position - 1] = { source: h.source, label: labelForSource(h.source, bodyState.userFields, t) };
          return next;
        });
      })
      .catch(() => { /* indices indisponibles : les chips restent en {{n}}, le formulaire marche */ });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, initial, t, bodyState.userFields]);

  function buildHeader(): TemplateHeaderInput | undefined {
    if (headerType === 'TEXT') return headerText.trim() ? { format: 'TEXT', text: headerText.trim() } : undefined;
    if (headerType === 'IMAGE' || headerType === 'VIDEO') return headerHandle ? { format: headerType, handle: headerHandle } : undefined;
    return undefined;
  }

  // Vide le média du header (handle + nom + aperçu) et révoque l'object URL courant. Appelé au changement de type
  // d'en-tête et après soumission.
  function clearHeaderMedia() {
    if (headerPreviewRef.current) URL.revokeObjectURL(headerPreviewRef.current);
    headerPreviewRef.current = '';
    setHeaderPreviewUrl('');
    setHeaderHandle('');
    setHeaderFileName('');
  }
  // Révoque l'object URL au démontage (pas de fuite).
  useEffect(() => () => { if (headerPreviewRef.current) URL.revokeObjectURL(headerPreviewRef.current); }, []);

  async function onHeaderFile(file: File | undefined) {
    if (!file) return;
    setHeaderUploading(true);
    setError(null);
    try {
      // Image : resize canvas (léger). Vidéo : brut en base64 (pas de resize, capé côté serveur à 16 Mo).
      const dataUrl = headerType === 'VIDEO' ? await fileToDataUrl(file) : await resizeToDataUrl(file, 1024, 0.85);
      const { handle } = await uploadMedia(tenantId, dataUrl);
      setHeaderHandle(handle);
      setHeaderFileName(file.name);
      // Aperçu local (object URL, léger) : montre le vrai média dans la miniature. Révoque l'ancien d'abord.
      const preview = URL.createObjectURL(file);
      if (headerPreviewRef.current) URL.revokeObjectURL(headerPreviewRef.current);
      headerPreviewRef.current = preview;
      setHeaderPreviewUrl(preview);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Upload du média impossible', 'Media upload failed'));
    } finally {
      setHeaderUploading(false);
    }
  }

  async function submit() {
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      // Canonicalisation des variables (renumérotation 1..N contiguë, exemples et indices réalignés) : même
      // fonction que le carousel, donc mêmes règles chez Meta.
      const canon = bodyState.canonicalize();
      // Toute variable {{n}} doit être rattachée à un champ via « + Variable » : tapée à la main, elle
      // partirait vide à l'envoi et se ferait rejeter par Meta.
      if (canon.unmapped.length > 0) {
        setError(unmappedVariablesMessage(canon.unmapped, t));
        setBusy(false);
        return;
      }
      const canonBody = canon.body;
      const example = canon.example;
      const paramHints: TemplateParamHint[] = canon.paramHints;
      const header = buildHeader();
      const foot = footer.trim() || undefined;
      if (isEdit && initial) {
        // name/language immuables : on édite le template résolu par son nom+langue côté serveur.
        await updateTemplate(tenantId, initial.name, {
          language: initial.language,
          category,
          body: canonBody,
          ...(header ? { header } : {}),
          ...(foot ? { footer: foot } : {}),
          ...(example ? { example } : {}),
          ...(buttons.length > 0 ? { buttons } : {}),
          ...(paramHints.length > 0 ? { paramHints } : {}),
        });
        setOk(t('Modifications envoyées. Le template repasse en validation Meta.', 'Changes sent. The template goes back to Meta for review.'));
        onCreated();
        return;
      }
      // Nom normalisé une seule fois : c'est LUI que Meta connaît, donc lui qu'on remonte à l'appelant.
      // Le recalculer ailleurs ferait diverger le nom affiché du nom réel dès qu'un caractère est filtré.
      const metaName = name.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
      const res = await createTemplate(tenantId, {
        name: metaName,
        category,
        language,
        body: canonBody,
        ...(header ? { header } : {}),
        ...(foot ? { footer: foot } : {}),
        ...(example ? { example } : {}),
        ...(buttons.length > 0 ? { buttons } : {}),
        ...(paramHints.length > 0 ? { paramHints } : {}),
      });
      setOk(`${t('Template soumis (statut', 'Template submitted (status')} : ${res.status}). ${t('Il passe en revue Meta.', 'It goes through Meta review.')}`);
      setName('');
      bodyState.reset();
      setButtons([]);
      setHeaderType('none');
      setHeaderText('');
      clearHeaderMedia();
      setFooter('');
      onCreated({ name: metaName, language, status: res.status });
    } catch (err) {
      setError(err instanceof Error ? err.message : isEdit ? t('Modification impossible', 'Update failed') : t('Création impossible', 'Creation failed'));
    } finally {
      setBusy(false);
    }
  }

  // Chaque bouton doit être complet : texte + (URL pour un lien / formulaire choisi pour un FLOW).
  // L'URL doit être une VRAIE adresse : sinon Meta refuse avec un message qui désigne un chemin de tableau
  // JSON, illisible. Une URL dynamique (`https://x.fr/{{1}}`) reste valide, le repo pose déjà son exemple.
  const buttonsComplete = buttons.every((b) => b.text.trim() !== '' && (b.type !== 'URL' || isSendableButtonUrl(b.url ?? '')) && (b.type !== 'FLOW' || (b.flowId ?? '') !== ''));
  const urlKo = (b: { type: string; url?: string }): boolean => b.type === 'URL' && (b.url ?? '').trim() !== '' && !isSendableButtonUrl(b.url ?? '');
  const headerReady =
    headerType === 'none' ||
    (headerType === 'TEXT' && headerText.trim() !== '') ||
    ((headerType === 'IMAGE' || headerType === 'VIDEO') && headerHandle !== '');
  const canSubmit = name.trim() !== '' && body.trim() !== '' && buttonsComplete && headerReady && !headerUploading && !busy;

  return (
    <div className={isEdit ? '' : 'rounded-2xl border border-ink-200 bg-white p-6 shadow-sm'}>
      {!isEdit && (
        <>
          <h2 className="text-base font-semibold tracking-tight text-ink-900">{t('Nouveau template', 'New template')}</h2>
          <p className="mt-1 text-xs text-ink-500">{t('Soumis à Meta pour validation (quelques minutes à quelques heures).', 'Submitted to Meta for review (a few minutes to a few hours).')}</p>
        </>
      )}

      <div className="mt-4 grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        {/* Colonne formulaire */}
        <div>
          <Field label={isEdit ? t('Nom (non modifiable)', 'Name (not editable)') : t('Nom (minuscules, sans espaces)', 'Name (lowercase, no spaces)')}>
            <input value={name} onChange={(e) => setName(e.target.value)} disabled={isEdit} className={`${inputCls} disabled:bg-ink-50 disabled:text-ink-400`} placeholder="promo_ete" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('Catégorie', 'Category')}>
              <select value={category} onChange={(e) => setCategory(e.target.value as 'MARKETING' | 'UTILITY')} className={inputCls}>
                <option value="MARKETING">marketing</option>
                <option value="UTILITY">utility</option>
              </select>
            </Field>
            <Field label={isEdit ? t('Langue (non modifiable)', 'Language (not editable)') : t('Langue', 'Language')}>
              <select value={language} onChange={(e) => setLanguage(e.target.value)} disabled={isEdit} className={`${inputCls} disabled:bg-ink-50 disabled:text-ink-400`}>
                {/* Filet : un template déjà créé avec une langue hors liste (ancien champ libre) garde sa valeur affichée. */}
                {language !== '' && !META_TEMPLATE_LANGUAGES.some((l) => l.code === language) && (
                  <option value={language}>{language}</option>
                )}
                {META_TEMPLATE_LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>{l.label} ({l.code})</option>
                ))}
              </select>
            </Field>
          </div>

          <div className="mt-3">
            <label className="mb-1 block text-sm font-medium text-ink-700">{t('En-tête (optionnel)', 'Header (optional)')}</label>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={headerType}
                onChange={(e) => { setHeaderType(e.target.value as 'none' | 'TEXT' | 'IMAGE' | 'VIDEO'); clearHeaderMedia(); }}
                className={`${inputCls} max-w-[150px]`}
              >
                <option value="none">{t('Aucun', 'None')}</option>
                <option value="TEXT">{t('Texte', 'Text')}</option>
                <option value="IMAGE">Image</option>
                <option value="VIDEO">{t('Vidéo', 'Video')}</option>
              </select>
              {headerType === 'TEXT' && (
                <input value={headerText} onChange={(e) => setHeaderText(e.target.value)} maxLength={60} placeholder={t('Titre fixe (60 car. max, sans variable)', 'Fixed title (60 char. max, no variable)')} className={`${inputCls} flex-1`} />
              )}
              {(headerType === 'IMAGE' || headerType === 'VIDEO') && (
                <>
                  <button type="button" onClick={() => headerFileRef.current?.click()} disabled={headerUploading} className="rounded-lg border border-ink-300 px-3 py-2 text-sm text-ink-700 hover:bg-ink-50 disabled:opacity-50">
                    {headerUploading ? 'Upload…' : headerHandle ? t('Remplacer', 'Replace') : headerType === 'IMAGE' ? t('Choisir une image', 'Choose an image') : t('Choisir une vidéo (mp4)', 'Choose a video (mp4)')}
                  </button>
                  {headerFileName && <span className="max-w-[140px] truncate text-xs text-ink-500">{headerFileName} ✓</span>}
                  <input ref={headerFileRef} type="file" accept={headerType === 'IMAGE' ? 'image/png,image/jpeg' : 'video/mp4'} className="hidden" onChange={(e) => onHeaderFile(e.target.files?.[0])} />
                </>
              )}
            </div>
          </div>

          <div className="mt-3">
            <TemplateBodyField
              state={bodyState}
              label={t('Corps du message', 'Message body')}
              placeholder={t('Bonjour [Prénom], voici notre offre 🎉', 'Hello [First name], here is our offer 🎉')}
            />
          </div>

          <div className="mt-3">
            <label className="mb-1 block text-sm font-medium text-ink-700">{t('Pied de page (optionnel)', 'Footer (optional)')}</label>
            <input value={footer} onChange={(e) => setFooter(e.target.value)} maxLength={60} placeholder={t('Petit texte en bas (60 car. max, sans variable)', 'Small text at the bottom (60 char. max, no variable)')} className={inputCls} />
          </div>

          <div className="mt-2">
            <TemplateVariableExamples state={bodyState} />
          </div>

          <div className="mt-3">
            <div className="mb-1 flex items-center justify-between">
              <label className="text-sm font-medium text-ink-700">{t('Boutons', 'Buttons')}</label>
              <div className="flex gap-2 text-xs">
                {/* Un bouton FLOW est EXCLUSIF (contrainte Meta) : on masque les autres si un FLOW est là,
                    et « + Flow » remplace tous les boutons par un unique bouton FLOW. */}
                {!hasFlow && (
                  <>
                    <button type="button" onClick={() => setButtons([...buttons, { type: 'QUICK_REPLY', text: '' }])} className="text-brand-600 hover:underline">{t('+ réponse rapide', '+ quick reply')}</button>
                    <button type="button" onClick={() => setButtons([...buttons, { type: 'URL', text: '', url: '' }])} className="text-brand-600 hover:underline">{t('+ lien', '+ link')}</button>
                    <button type="button" onClick={() => setButtons([{ type: 'FLOW', text: '', flowId: '' }])} className="text-brand-600 hover:underline" title={t('Un bouton formulaire : créer un formulaire inline ou en choisir un déjà publié', 'A form button: create an inline form or choose an already published one')}>+ Flow</button>
                  </>
                )}
              </div>
            </div>
            <div className="space-y-2">
              {buttons.map((b, i) => (
                b.type === 'FLOW' ? (
                  // Bouton FLOW = exclusif : sur sa propre ligne, libellé PLEINE LARGEUR (bien visible) + choix du formulaire dessous.
                  <div key={i} className="space-y-1.5 rounded-lg border border-ink-100 bg-ink-50/50 p-2.5">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-ink-400">{t('Bouton du formulaire', 'Form button')}</span>
                      <button type="button" onClick={() => setButtons(buttons.filter((_, j) => j !== i))} className="text-ink-400 hover:text-red-600" aria-label={t('Retirer', 'Remove')}>×</button>
                    </div>
                    <input
                      value={b.text}
                      onChange={(e) => setButtons(buttons.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))}
                      maxLength={25}
                      className={`${inputCls} w-full`}
                      placeholder={t('Texte affiché sur le bouton (25 car. max)', 'Text shown on the button (25 char. max)')}
                    />
                    <select
                      value={b.flowId ?? ''}
                      onChange={(e) => setButtons(buttons.map((x, j) => (j === i ? { ...x, flowId: e.target.value } : x)))}
                      className={`${inputCls} w-full`}
                    >
                      <option value="">{t('Choisir un formulaire…', 'Choose a form…')}</option>
                      {pubFlows.map((f) => (
                        <option key={f.id} value={f.id}>{f.name}</option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <div key={i} className="flex items-center gap-1.5">
                    <span className="w-16 shrink-0 text-xs text-ink-400">{b.type === 'URL' ? t('lien', 'link') : t('réponse', 'reply')}</span>
                    <input
                      value={b.text}
                      onChange={(e) => setButtons(buttons.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))}
                      maxLength={25}
                      className={`${inputCls} flex-1`}
                      placeholder={t('Texte du bouton (25 car. max)', 'Button text (25 char. max)')}
                    />
                    {b.type === 'URL' && (
                      <input
                        value={b.url ?? ''}
                        onChange={(e) => setButtons(buttons.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))}
                        className={`${inputCls} min-w-0 flex-[2] ${urlKo(b) ? 'border-coral focus:border-coral focus:ring-red-100' : ''}`}
                        title={urlKo(b) ? t('Adresse incomplète : commence par https://', 'Incomplete address: start with https://') : undefined}
                        placeholder="https://exemple.fr/page"
                      />
                    )}
                    <button type="button" onClick={() => setButtons(buttons.filter((_, j) => j !== i))} className="shrink-0 text-ink-400 hover:text-red-600" aria-label={t('Retirer', 'Remove')}>×</button>
                  </div>
                )
              ))}
            </div>

            {/* Bouton FLOW : choisir un formulaire publié OU en créer un inline (publié aussitôt puis attaché). */}
            {hasFlow && (
              <div className="mt-2">
                {!creatingFlow ? (
                  <button type="button" onClick={() => setCreatingFlow(true)} className="text-xs font-medium text-brand-600 hover:underline">
                    {t('＋ Créer un nouveau formulaire', '＋ Create a new form')}
                  </button>
                ) : (
                  <div className="rounded-xl border border-brand-200 bg-brand-50/40 p-4">
                    <div className="mb-3 flex items-center justify-between">
                      <span className="text-sm font-semibold text-ink-900">{t('Nouveau formulaire', 'New form')}</span>
                      <button type="button" onClick={() => setCreatingFlow(false)} className="text-xs text-ink-400 hover:text-ink-700">{t('Annuler', 'Cancel')}</button>
                    </div>
                    <FlowBuilder
                      tenantId={tenantId}
                      autoPublish
                      onCreated={(flow) => {
                        // FlowSummary synthétique (le sélecteur n'utilise que id/name) : screens inconnus ici -> null.
                        setPubFlows((prev) => [{ id: flow.id, name: flow.name, status: 'PUBLISHED', fields: [], screens: null, createdAt: new Date().toISOString() }, ...prev]);
                        setButtons((list) => list.map((x) => (x.type === 'FLOW' ? { ...x, flowId: flow.id } : x)));
                        setCreatingFlow(false);
                      }}
                    />
                  </div>
                )}
              </div>
            )}
          </div>

          {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
          {ok && <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{ok}</p>}

          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className="mt-4 w-full rounded-lg bg-brand-500 px-3 py-2 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-50"
          >
            {busy ? t('Envoi...', 'Sending...') : isEdit ? t('Enregistrer les modifications', 'Save changes') : t('Créer le template', 'Create template')}
          </button>
        </div>

        {/* Colonne aperçu (collante) */}
        <div className="lg:sticky lg:top-4 lg:h-fit">
          <WhatsAppPreview
            body={body}
            examples={bodyState.examples}
            varLabels={bodyState.varLabels}
            buttons={buttons}
            header={
              headerType === 'none'
                ? null
                : headerType === 'TEXT'
                  ? headerText.trim()
                    ? { format: 'TEXT', text: headerText }
                    : null
                  : { format: headerType, ...(headerPreviewUrl ? { mediaUrl: headerPreviewUrl } : {}) }
            }
            footer={footer}
          />
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-3">
      <label className="mb-1 block text-sm font-medium text-ink-700">{label}</label>
      {children}
    </div>
  );
}
