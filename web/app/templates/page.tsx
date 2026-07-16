'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { WhatsAppPreview } from '@/components/WhatsAppPreview';
import { VariableBodyEditor, type VariableBodyEditorHandle } from '@/components/VariableBodyEditor';
import { CarouselForm } from '@/components/CarouselForm';
import { FlowBuilder } from '@/components/FlowBuilder';
import type { Session } from '@/lib/session';
import { listTemplates, createTemplate, updateTemplate, deleteTemplate, listFlows, uploadMedia, listUserFields, getTemplateHints, type TemplateSummary, type TemplateButtonInput, type TemplateHeaderInput, type FlowSummary, type UserFieldDef, type ParamSource, type TemplateParamHint } from '@/lib/api';
import { resizeToDataUrl, fileToDataUrl } from '@/lib/image';
import { useT } from '@/lib/i18n';

export default function TemplatesPage() {
  return <AppShell active="templates">{(session) => <TemplatesInner session={session} />}</AppShell>;
}

const STATUS: Record<string, string> = {
  APPROVED: 'bg-emerald-50 text-emerald-700',
  PENDING: 'bg-amber-50 text-amber-700',
  REJECTED: 'bg-red-50 text-red-700',
};

// Emojis courants pour messages business (insérés au curseur dans le corps).
const EMOJIS = [
  '😀','😊','😉','😍','🥳','🤩','😎','🙌','👋','👍','🙏','🤝','💪','👏','🔥','✨',
  '⭐','🌟','💯','✅','✔️','☑️','❌','⚡','🎉','🎊','🎁','🎈','🥂','🍾','❤️','🧡',
  '💛','💚','💙','💜','💖','💥','💡','📣','📢','🔔','📅','⏰','🕐','⌛','📍','📌',
  '🏷️','🛍️','🛒','💳','💰','🤑','📦','🚚','🚀','🎯','📈','📊','💬','💭','📞','📲',
  '✉️','📧','📝','🔗','➡️','👉','👀','🤗',
];

/** Une variable {{n}} rattachée à un champ (via le sélecteur) : source (pour l'indice) + libellé (chip). */
interface VarSource { source: ParamSource; label: string }

/** Exemple déterministe (jamais vide) exigé par Meta, selon le champ choisi. Zéro IA : valeur plausible par
 *  clé connue, sinon par type de champ. */
function deterministicExample(source: ParamSource, fieldType?: string): string {
  if (source.type === 'attribute') return source.key === 'phone' ? '+33 6 12 34 56 78' : 'Marie Martin';
  if (source.type === 'literal') return source.value?.trim() || 'exemple';
  const key = (source.key ?? '').toLowerCase();
  const byKey: Record<string, string> = {
    prenom: 'Marie', firstname: 'Marie', nom: 'Martin', lastname: 'Martin',
    email: 'marie@exemple.fr', mail: 'marie@exemple.fr', ville: 'Lyon', city: 'Lyon',
    societe: 'Dupont SARL', entreprise: 'Dupont SARL', company: 'Dupont SARL',
    telephone: '+33 6 12 34 56 78', tel: '+33 6 12 34 56 78',
  };
  if (byKey[key]) return byKey[key]!;
  switch (fieldType) {
    case 'number': return '42';
    case 'date': return '2026-01-15';
    case 'url': return 'https://exemple.fr';
    case 'boolean': return 'oui';
    default: return 'Marie';
  }
}

/** Libellé lisible d'une source (pour le chip d'aperçu + restauration à l'édition). */
function labelForSource(source: ParamSource, fields: UserFieldDef[], t: (fr: string, en?: string) => string): string {
  if (source.type === 'attribute') return source.key === 'phone' ? t('Téléphone', 'Phone') : t('Nom du profil WhatsApp', 'WhatsApp profile name');
  if (source.type === 'literal') return t('Texte fixe', 'Fixed text');
  return fields.find((f) => f.key === source.key)?.label ?? source.key ?? t('Champ', 'Field');
}

function TemplatesInner({ session }: { session: Session }) {
  const t = useT();
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'simple' | 'carousel'>('simple');
  const [editing, setEditing] = useState<TemplateSummary | null>(null);
  const [creating, setCreating] = useState(false);
  const [preview, setPreview] = useState<TemplateSummary | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      setTemplates((await listTemplates(session.tenantId)).templates);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Chargement impossible', 'Unable to load'));
    } finally {
      setLoading(false);
    }
  }, [session.tenantId, t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function remove(tpl: TemplateSummary) {
    if (!window.confirm(`${t('Supprimer le template', 'Delete template')} « ${tpl.name} » ?\n${t("Suppression définitive chez Meta (toutes les langues). Bloquée si une campagne active l'utilise.", 'Permanent deletion at Meta (all languages). Blocked if an active campaign uses it.')}`)) return;
    setError(null);
    try {
      await deleteTemplate(session.tenantId, tpl.name);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Suppression impossible', 'Unable to delete'));
    }
  }

  return (
    <div className="space-y-6">
      {editing ? (
        <section className="rounded-2xl border border-brand-200 bg-brand-50/40 p-6 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold tracking-tight text-ink-900">{t('Modifier', 'Edit')} « {editing.name} »</h2>
            <button onClick={() => setEditing(null)} className="text-xs text-ink-400 hover:text-ink-700">{t('Fermer', 'Close')}</button>
          </div>
          <p className="mb-4 rounded-lg bg-gold/10 px-3 py-2 text-xs text-gold">{t('Modifier un template le renvoie en validation Meta (statut PENDING) : il est inenvoyable le temps de la re-validation. Le nom et la langue ne sont pas modifiables.', 'Editing a template sends it back to Meta for review (PENDING status): it stays unsendable until re-approval. Name and language cannot be changed.')}</p>
          <CreateForm key={editing.name} tenantId={session.tenantId} onCreated={() => { void reload(); setEditing(null); }} initial={editing} />
        </section>
      ) : creating ? (
        <section className="rounded-2xl border border-brand-200 bg-brand-50/40 p-6 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold tracking-tight text-ink-900">{t('Nouveau template', 'New template')}</h2>
            <button onClick={() => setCreating(false)} className="text-xs text-ink-400 hover:text-ink-700">{t('Fermer', 'Close')}</button>
          </div>
          <div className="mb-4 inline-flex gap-1 rounded-lg bg-ink-100 p-1 text-xs">
            {(['simple', 'carousel'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`rounded-md px-3 py-1 ${mode === m ? 'bg-white font-medium text-brand-700 shadow-sm' : 'text-ink-500 hover:text-ink-800'}`}
              >
                {m === 'simple' ? t('Template simple', 'Simple template') : 'Carousel'}
              </button>
            ))}
          </div>
          {mode === 'simple' ? (
            <CreateForm tenantId={session.tenantId} onCreated={() => { void reload(); setCreating(false); }} />
          ) : (
            <CarouselForm tenantId={session.tenantId} onCreated={() => { void reload(); setCreating(false); }} />
          )}
        </section>
      ) : null}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold tracking-tight text-ink-900">{t('Templates', 'Templates')} ({templates.length})</h2>
          <div className="flex items-center gap-3">
            <button onClick={reload} className="text-xs text-brand-600 hover:underline">{t('Rafraîchir', 'Refresh')}</button>
            {!creating && !editing && (
              <button onClick={() => setCreating(true)} className="rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-brand-600">{t('+ Créer un template', '+ Create a template')}</button>
            )}
          </div>
        </div>
        {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        {loading ? (
          <p className="text-sm text-ink-500">{t('Chargement...', 'Loading...')}</p>
        ) : templates.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-ink-300 bg-white px-4 py-10 text-center text-sm text-ink-500">
            {t("Aucun template. Clique « + Créer un template » (il passe en revue Meta avant d'être utilisable).", 'No templates yet. Click « + Create a template » (it goes through Meta review before it can be used).')}
          </div>
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-ink-200 bg-white shadow-sm">
            <table className="w-full min-w-[520px] text-sm">
              <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
                <tr>
                  <th className="px-4 py-2.5 font-medium">{t('Nom', 'Name')}</th>
                  <th className="px-4 py-2.5 font-medium">{t('Catégorie', 'Category')}</th>
                  <th className="px-4 py-2.5 font-medium">{t('Langue', 'Language')}</th>
                  <th className="px-4 py-2.5 font-medium">{t('Statut', 'Status')}</th>
                  <th className="px-4 py-2.5 text-right font-medium">{t('Actions', 'Actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {templates.map((tpl) => (
                  <tr key={`${tpl.name}-${tpl.language}`} className="hover:bg-ink-50">
                    <td className="px-4 py-2.5">
                      <button onClick={() => setPreview(tpl)} className="font-mono text-xs font-medium text-brand-600 hover:underline" title={t("Voir l'aperçu", 'View preview')}>{tpl.name}</button>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-ink-500">{tpl.category?.toLowerCase()}</td>
                    <td className="px-4 py-2.5 text-xs">{tpl.language}</td>
                    <td className="px-4 py-2.5">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS[tpl.status] ?? 'bg-ink-100 text-ink-600'}`}>
                        {tpl.status?.toLowerCase()}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <div className="flex items-center justify-end gap-3 text-xs">
                        {tpl.editable === false ? (
                          <span className="text-ink-300" title={tpl.isCarousel ? t("Édition d'un carousel non supportée", 'Editing a carousel is not supported') : t("Édition non supportée : en-tête ou pied de page (il serait supprimé)", 'Editing not supported: header or footer (it would be removed)')}>{t('Éditer', 'Edit')}</span>
                        ) : (
                          <button onClick={() => setEditing(tpl)} className="font-medium text-brand-600 hover:text-brand-700">{t('Éditer', 'Edit')}</button>
                        )}
                        <button onClick={() => remove(tpl)} className="font-medium text-coral hover:text-red-700">{t('Supprimer', 'Delete')}</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {preview && <TemplatePreviewModal template={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}

/** Aperçu WhatsApp d'un template au clic sur son nom (corps + boutons ; carousel/média = note). */
function TemplatePreviewModal({ template, onClose }: { template: TemplateSummary; onClose: () => void }) {
  const t = useT();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/30 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-start justify-between">
          <div>
            <h3 className="font-mono text-sm font-semibold text-ink-900">{template.name}</h3>
            <p className="text-xs text-ink-400">{template.category?.toLowerCase()} · {template.language} · {template.status?.toLowerCase()}</p>
          </div>
          <button onClick={onClose} className="text-2xl leading-none text-ink-400 hover:text-ink-700">×</button>
        </div>
        {template.isCarousel ? (
          <div className="rounded-lg bg-ink-50 px-3 py-4 text-sm text-ink-600">
            <p className="font-medium">{t('Template carousel', 'Carousel template')}</p>
            <p className="mt-1 text-ink-500">{template.body || t('Message d’introduction non chargé.', 'Introduction message not loaded.')}</p>
          </div>
        ) : (
          <WhatsAppPreview
            body={template.body ?? ''}
            examples={template.example ?? []}
            buttons={template.buttons ?? []}
            header={template.headerFormat ? { format: template.headerFormat, text: template.headerText } : null}
            footer={template.footer}
            hideNote
          />
        )}
        {template.headerFormat && template.headerFormat !== 'TEXT' && !template.isCarousel && (
          <p className="mt-2 text-[11px] text-ink-400">{t('En-tête', 'Header')} {template.headerFormat.toLowerCase()} {t("(le média réel s'affiche à l'envoi).", '(the actual media is shown when sending).')}</p>
        )}
      </div>
    </div>
  );
}

const inputCls =
  'w-full rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';

/** Sélecteur d'emojis : insère au curseur, se ferme au clic extérieur. */
function EmojiPicker({ onPick, onClose }: { onPick: (e: string) => void; onClose: () => void }) {
  const t = useT();
  return (
    <>
      <button type="button" aria-label={t('Fermer', 'Close')} className="fixed inset-0 z-40 cursor-default" onClick={onClose} />
      <div className="absolute bottom-11 right-0 z-50 w-64 rounded-xl border border-ink-200 bg-white p-2 shadow-lg">
        <div className="grid grid-cols-8 gap-0.5">
          {EMOJIS.map((e) => (
            <button type="button" key={e} onClick={() => onPick(e)} className="rounded p-1 text-lg leading-none hover:bg-ink-100" aria-label={e}>
              {e}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

/** Sélecteur de champ : insère une variable rattachée au champ choisi (nom/téléphone + champs perso). */
function FieldPicker({ options, onPick, onClose }: {
  options: Array<{ source: ParamSource; label: string; fieldType?: string }>;
  onPick: (o: { source: ParamSource; label: string; fieldType?: string }) => void;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <>
      <button type="button" aria-label={t('Fermer', 'Close')} className="fixed inset-0 z-40 cursor-default" onClick={onClose} />
      <div className="absolute bottom-11 right-0 z-50 max-h-56 w-56 overflow-y-auto rounded-xl border border-ink-200 bg-white p-1 shadow-lg">
        <div className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-ink-400">{t('Insérer un champ', 'Insert a field')}</div>
        {options.map((o, i) => (
          <button type="button" key={`${o.label}-${i}`} onClick={() => onPick(o)} className="block w-full truncate rounded-md px-2 py-1.5 text-left text-sm text-ink-700 hover:bg-brand-50">{o.label}</button>
        ))}
      </div>
    </>
  );
}

function CreateForm({ tenantId, onCreated, initial }: { tenantId: string; onCreated: () => void; initial?: TemplateSummary }) {
  const t = useT();
  const isEdit = !!initial;
  const [name, setName] = useState(initial?.name ?? '');
  const [category, setCategory] = useState<'MARKETING' | 'UTILITY'>((initial?.category?.toUpperCase() as 'MARKETING' | 'UTILITY') ?? 'MARKETING');
  const [language, setLanguage] = useState(initial?.language ?? 'fr');
  const [body, setBody] = useState(initial?.body ?? '');
  const [examples, setExamples] = useState<string[]>(initial?.example ?? []);
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
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [fieldPickerOpen, setFieldPickerOpen] = useState(false);
  const bodyEditorRef = useRef<VariableBodyEditorHandle>(null);
  const [pubFlows, setPubFlows] = useState<FlowSummary[]>([]);
  const [creatingFlow, setCreatingFlow] = useState(false);
  const hasFlow = buttons.some((b) => b.type === 'FLOW');
  // Champs dispo dans le sélecteur de variable + source par variable ({{n}} -> varSources[n-1]).
  const [userFields, setUserFields] = useState<UserFieldDef[]>([]);
  const [varSources, setVarSources] = useState<Array<VarSource | undefined>>([]);

  useEffect(() => {
    listFlows(tenantId)
      .then(({ flows }) => setPubFlows(flows.filter((f) => f.status === 'PUBLISHED')))
      .catch(() => setPubFlows([]));
  }, [tenantId]);

  // Champs perso (pour le sélecteur) + restauration des indices variable->champ à l'édition (chips + re-save).
  useEffect(() => {
    let alive = true;
    (async () => {
      const [uf, hints] = await Promise.all([
        listUserFields(tenantId).then((r) => r.fields).catch(() => [] as UserFieldDef[]),
        initial ? getTemplateHints(tenantId, initial.name, initial.language).then((r) => r.hints).catch(() => [] as TemplateParamHint[]) : Promise.resolve([] as TemplateParamHint[]),
      ]);
      if (!alive) return;
      setUserFields(uf);
      if (hints.length > 0) {
        setVarSources((prev) => {
          const next = [...prev];
          for (const h of hints) next[h.position - 1] = { source: h.source, label: labelForSource(h.source, uf, t) };
          return next;
        });
      }
    })();
    return () => { alive = false; };
  }, [tenantId, initial, t]);

  // « Nom du profil WhatsApp » = le profile_name (souvent vide en import CSV) -> clairement distinct des champs
  // Prénom / Nom importés (qui apparaissent ci-dessous via userFields). Fin de la confusion « Nom / Nom et prénom ».
  const fieldOptions: Array<{ source: ParamSource; label: string; fieldType?: string }> = [
    { source: { type: 'attribute', key: 'name' }, label: t('Nom du profil WhatsApp', 'WhatsApp profile name') },
    { source: { type: 'attribute', key: 'phone' }, label: t('Téléphone', 'Phone') },
    ...userFields.map((f) => ({ source: { type: 'field', key: f.key } as ParamSource, label: f.label, fieldType: f.type })),
  ];

  // Positions de variables réellement présentes dans le corps (distinctes, triées). Après suppression d'une
  // variable du milieu le corps n'est plus forcément 1..N contigu -> on pilote la numérotation, les exemples et
  // les indices là-dessus (pas sur un simple compte, qui provoquerait des collisions de {{n}}).
  const bodyPositions = useMemo(
    () => [...new Set([...body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1])))].sort((a, b) => a - b),
    [body],
  );

  function insertEmoji(emoji: string) {
    // Insertion au curseur dans l'éditeur riche (chips) -> onChange met à jour `body`.
    bodyEditorRef.current?.insertToken(emoji);
  }

  // Insère une NOUVELLE variable au curseur (chip lisible), rattachée au champ choisi, exemple pré-rempli. Numéro =
  // MAX des positions présentes + 1 (jamais le simple compte : après suppression d'un {{1}}, réutiliser 2 créerait
  // une collision {{2}}/{{2}}). La canonicalisation au submit compacte ensuite les trous.
  function insertVariable(opt: { source: ParamSource; label: string; fieldType?: string }) {
    const next = (bodyPositions.length ? Math.max(...bodyPositions) : 0) + 1;
    bodyEditorRef.current?.insertToken(`{{${next}}}`, opt.label);
    setVarSources((vs) => { const c = [...vs]; c[next - 1] = { source: opt.source, label: opt.label }; return c; });
    setExamples((ex) => { const c = [...ex]; c[next - 1] = deterministicExample(opt.source, opt.fieldType); return c; });
    setFieldPickerOpen(false);
  }

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
      // Canonicalise les variables du corps : renumérote en 1..N contigu par ordre d'apparition (au cas où une
      // variable du milieu a été supprimée -> Meta EXIGE une suite sans trou) et réaligne sources + exemples.
      const order: number[] = [];
      const seen = new Set<number>();
      for (const mm of body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) {
        const p = Number(mm[1]);
        if (!seen.has(p)) { seen.add(p); order.push(p); }
      }
      const remap = new Map(order.map((old, i) => [old, i + 1]));
      const canonBody = body.replace(/\{\{\s*(\d+)\s*\}\}/g, (_s, d) => `{{${remap.get(Number(d))}}}`);
      const canonSources = order.map((old) => varSources[old - 1]);
      const canonExamples = order.map((old) => examples[old - 1] ?? '');

      // Décision « forcer le sélecteur » : toute variable {{n}} doit être rattachée à un champ via « + Variable ».
      // Une variable tapée à la main (sans source) partirait vide à l'envoi et se ferait rejeter par Meta -> on bloque ici.
      const unmapped = canonSources.map((v, i) => (v ? null : i + 1)).filter((p): p is number => p !== null);
      if (unmapped.length > 0) {
        setError(`${t('Chaque variable doit être rattachée à un champ via « + Variable ». Non rattachée(s) :', 'Each variable must be linked to a field via « + Variable ». Not linked:')} ${unmapped.map((p) => `{{${p}}}`).join(', ')}. ${t('Supprime-les puis réinsère-les avec le sélecteur.', 'Delete them then reinsert them with the picker.')}`);
        setBusy(false);
        return;
      }

      const example = order.length > 0 ? canonExamples.map((e) => e || 'exemple') : undefined;
      // Indices variable->champ (seulement les variables rattachées à un champ via le sélecteur), positions canoniques.
      const paramHints: TemplateParamHint[] = canonSources
        .map((v, i): TemplateParamHint | null => (v ? { position: i + 1, source: v.source } : null))
        .filter((h): h is TemplateParamHint => h !== null);
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
      const res = await createTemplate(tenantId, {
        name: name.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_'),
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
      setBody('');
      setExamples([]);
      setVarSources([]);
      setButtons([]);
      setHeaderType('none');
      setHeaderText('');
      clearHeaderMedia();
      setFooter('');
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : isEdit ? t('Modification impossible', 'Update failed') : t('Création impossible', 'Creation failed'));
    } finally {
      setBusy(false);
    }
  }

  // Chaque bouton doit être complet : texte + (URL pour un lien / formulaire choisi pour un FLOW).
  const buttonsComplete = buttons.every((b) => b.text.trim() !== '' && (b.type !== 'URL' || (b.url ?? '').trim() !== '') && (b.type !== 'FLOW' || (b.flowId ?? '') !== ''));
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
              <input value={language} onChange={(e) => setLanguage(e.target.value)} disabled={isEdit} className={`${inputCls} disabled:bg-ink-50 disabled:text-ink-400`} placeholder="fr" />
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
            <label className="mb-1 block text-sm font-medium text-ink-700">{t('Corps du message', 'Message body')}</label>
            <div className="relative">
              <VariableBodyEditor
                ref={bodyEditorRef}
                value={body}
                varLabels={varSources.map((v) => v?.label)}
                onChange={setBody}
                placeholder={t('Bonjour [Prénom], voici notre offre 🎉', 'Hello [First name], here is our offer 🎉')}
                className={`${inputCls} pr-28`}
              />
              <div className="absolute bottom-2 right-2 flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => { setFieldPickerOpen((o) => !o); setEmojiOpen(false); }}
                  className="rounded-md border border-ink-200 bg-white px-2 py-1 text-xs font-medium text-brand-600 hover:bg-brand-50"
                  title={t('Insérer une variable (champ du contact)', 'Insert a variable (contact field)')}
                >
                  + Variable
                </button>
                <button
                  type="button"
                  onClick={() => { setEmojiOpen((o) => !o); setFieldPickerOpen(false); }}
                  className="rounded-md p-1 text-lg leading-none hover:bg-ink-100"
                  aria-label={t('Insérer un emoji', 'Insert an emoji')}
                >
                  😊
                </button>
              </div>
              {emojiOpen && <EmojiPicker onPick={insertEmoji} onClose={() => setEmojiOpen(false)} />}
              {fieldPickerOpen && <FieldPicker options={fieldOptions} onPick={insertVariable} onClose={() => setFieldPickerOpen(false)} />}
            </div>
            <p className="mt-1 text-xs text-ink-400">{t("Clique « + Variable » pour insérer un champ du contact (nom, prénom, email…) : l'exemple exigé par Meta se remplit tout seul.", 'Click « + Variable » to insert a contact field (name, first name, email…): the example required by Meta fills in automatically.')}</p>
          </div>

          <div className="mt-3">
            <label className="mb-1 block text-sm font-medium text-ink-700">{t('Pied de page (optionnel)', 'Footer (optional)')}</label>
            <input value={footer} onChange={(e) => setFooter(e.target.value)} maxLength={60} placeholder={t('Petit texte en bas (60 car. max, sans variable)', 'Small text at the bottom (60 char. max, no variable)')} className={inputCls} />
          </div>

          {bodyPositions.length > 0 && (
            <div className="mt-2">
              <label className="mb-1 block text-sm font-medium text-ink-700">{t('Exemples de variables (requis par Meta)', 'Variable examples (required by Meta)')}</label>
              <div className="space-y-2">
                {/* Piloté par les positions RÉELLES du corps (index pos-1), pas un compte séquentiel : après
                    suppression d'une variable du milieu, chaque ligne reste alignée avec sa source/exemple. */}
                {bodyPositions.map((pos) => (
                  <div key={pos} className="flex items-center gap-2">
                    <span className="flex w-28 shrink-0 items-center gap-1 text-xs text-ink-400">
                      {`{{${pos}}}`}
                      {varSources[pos - 1] && <span className="truncate rounded bg-brand-50 px-1 text-brand-600">{varSources[pos - 1]!.label}</span>}
                    </span>
                    <input
                      value={examples[pos - 1] ?? ''}
                      onChange={(e) => setExamples((x) => { const c = [...x]; c[pos - 1] = e.target.value; return c; })}
                      className={`${inputCls} flex-1`}
                      placeholder={t('ex. Julie', 'e.g. Julie')}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

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
                        className={`${inputCls} w-28`}
                        placeholder="https://..."
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
                        setPubFlows((prev) => [{ id: flow.id, name: flow.name, status: 'PUBLISHED', fields: [], createdAt: new Date().toISOString() }, ...prev]);
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
            examples={examples}
            varLabels={varSources.map((v) => v?.label)}
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
