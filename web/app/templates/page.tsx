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
function labelForSource(source: ParamSource, fields: UserFieldDef[]): string {
  if (source.type === 'attribute') return source.key === 'phone' ? 'Téléphone' : 'Nom';
  if (source.type === 'literal') return 'Texte fixe';
  return fields.find((f) => f.key === source.key)?.label ?? source.key ?? 'Champ';
}

function TemplatesInner({ session }: { session: Session }) {
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
      setError(err instanceof Error ? err.message : 'Chargement impossible');
    } finally {
      setLoading(false);
    }
  }, [session.tenantId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function remove(t: TemplateSummary) {
    if (!window.confirm(`Supprimer le template « ${t.name} » ?\nSuppression définitive chez Meta (toutes les langues). Bloquée si une campagne active l'utilise.`)) return;
    setError(null);
    try {
      await deleteTemplate(session.tenantId, t.name);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Suppression impossible');
    }
  }

  return (
    <div className="space-y-6">
      {editing ? (
        <section className="rounded-2xl border border-brand-200 bg-brand-50/40 p-6 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold tracking-tight text-ink-900">Modifier « {editing.name} »</h2>
            <button onClick={() => setEditing(null)} className="text-xs text-ink-400 hover:text-ink-700">Fermer</button>
          </div>
          <p className="mb-4 rounded-lg bg-gold/10 px-3 py-2 text-xs text-gold">Modifier un template le renvoie en validation Meta (statut PENDING) : il est inenvoyable le temps de la re-validation. Le nom et la langue ne sont pas modifiables.</p>
          <CreateForm key={editing.name} tenantId={session.tenantId} onCreated={() => { void reload(); setEditing(null); }} initial={editing} />
        </section>
      ) : creating ? (
        <section className="rounded-2xl border border-brand-200 bg-brand-50/40 p-6 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold tracking-tight text-ink-900">Nouveau template</h2>
            <button onClick={() => setCreating(false)} className="text-xs text-ink-400 hover:text-ink-700">Fermer</button>
          </div>
          <div className="mb-4 inline-flex gap-1 rounded-lg bg-ink-100 p-1 text-xs">
            {(['simple', 'carousel'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`rounded-md px-3 py-1 ${mode === m ? 'bg-white font-medium text-brand-700 shadow-sm' : 'text-ink-500 hover:text-ink-800'}`}
              >
                {m === 'simple' ? 'Template simple' : 'Carousel'}
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
          <h2 className="text-base font-semibold tracking-tight text-ink-900">Templates ({templates.length})</h2>
          <div className="flex items-center gap-3">
            <button onClick={reload} className="text-xs text-brand-600 hover:underline">Rafraîchir</button>
            {!creating && !editing && (
              <button onClick={() => setCreating(true)} className="rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-brand-600">+ Créer un template</button>
            )}
          </div>
        </div>
        {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        {loading ? (
          <p className="text-sm text-ink-500">Chargement...</p>
        ) : templates.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-ink-300 bg-white px-4 py-10 text-center text-sm text-ink-500">
            Aucun template. Clique « + Créer un template » (il passe en revue Meta avant d&apos;être utilisable).
          </div>
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-ink-200 bg-white shadow-sm">
            <table className="w-full min-w-[520px] text-sm">
              <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Nom</th>
                  <th className="px-4 py-2.5 font-medium">Catégorie</th>
                  <th className="px-4 py-2.5 font-medium">Langue</th>
                  <th className="px-4 py-2.5 font-medium">Statut</th>
                  <th className="px-4 py-2.5 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {templates.map((t) => (
                  <tr key={`${t.name}-${t.language}`} className="hover:bg-ink-50">
                    <td className="px-4 py-2.5">
                      <button onClick={() => setPreview(t)} className="font-mono text-xs font-medium text-brand-600 hover:underline" title="Voir l'aperçu">{t.name}</button>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-ink-500">{t.category?.toLowerCase()}</td>
                    <td className="px-4 py-2.5 text-xs">{t.language}</td>
                    <td className="px-4 py-2.5">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS[t.status] ?? 'bg-ink-100 text-ink-600'}`}>
                        {t.status?.toLowerCase()}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <div className="flex items-center justify-end gap-3 text-xs">
                        {t.editable === false ? (
                          <span className="text-ink-300" title={t.isCarousel ? "Édition d'un carousel non supportée" : "Édition non supportée : en-tête ou pied de page (il serait supprimé)"}>Éditer</span>
                        ) : (
                          <button onClick={() => setEditing(t)} className="font-medium text-brand-600 hover:text-brand-700">Éditer</button>
                        )}
                        <button onClick={() => remove(t)} className="font-medium text-coral hover:text-red-700">Supprimer</button>
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
            <p className="font-medium">Template carousel</p>
            <p className="mt-1 text-ink-500">{template.body || 'Message d’introduction non chargé.'}</p>
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
          <p className="mt-2 text-[11px] text-ink-400">En-tête {template.headerFormat.toLowerCase()} (le média réel s&apos;affiche à l&apos;envoi).</p>
        )}
      </div>
    </div>
  );
}

const inputCls =
  'w-full rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';

/** Sélecteur d'emojis : insère au curseur, se ferme au clic extérieur. */
function EmojiPicker({ onPick, onClose }: { onPick: (e: string) => void; onClose: () => void }) {
  return (
    <>
      <button type="button" aria-label="Fermer" className="fixed inset-0 z-40 cursor-default" onClick={onClose} />
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
  return (
    <>
      <button type="button" aria-label="Fermer" className="fixed inset-0 z-40 cursor-default" onClick={onClose} />
      <div className="absolute bottom-11 right-0 z-50 max-h-56 w-56 overflow-y-auto rounded-xl border border-ink-200 bg-white p-1 shadow-lg">
        <div className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-ink-400">Insérer un champ</div>
        {options.map((o, i) => (
          <button type="button" key={`${o.label}-${i}`} onClick={() => onPick(o)} className="block w-full truncate rounded-md px-2 py-1.5 text-left text-sm text-ink-700 hover:bg-brand-50">{o.label}</button>
        ))}
      </div>
    </>
  );
}

function CreateForm({ tenantId, onCreated, initial }: { tenantId: string; onCreated: () => void; initial?: TemplateSummary }) {
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
          for (const h of hints) next[h.position - 1] = { source: h.source, label: labelForSource(h.source, uf) };
          return next;
        });
      }
    })();
    return () => { alive = false; };
  }, [tenantId, initial]);

  const fieldOptions: Array<{ source: ParamSource; label: string; fieldType?: string }> = [
    { source: { type: 'attribute', key: 'name' }, label: 'Nom' },
    { source: { type: 'attribute', key: 'phone' }, label: 'Téléphone' },
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
      setError(err instanceof Error ? err.message : 'Upload du média impossible');
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
        setOk('Modifications envoyées. Le template repasse en validation Meta.');
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
      setOk(`Template soumis (statut : ${res.status}). Il passe en revue Meta.`);
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
      setError(err instanceof Error ? err.message : isEdit ? 'Modification impossible' : 'Création impossible');
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
          <h2 className="text-base font-semibold tracking-tight text-ink-900">Nouveau template</h2>
          <p className="mt-1 text-xs text-ink-500">Soumis à Meta pour validation (quelques minutes à quelques heures).</p>
        </>
      )}

      <div className="mt-4 grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        {/* Colonne formulaire */}
        <div>
          <Field label={isEdit ? 'Nom (non modifiable)' : 'Nom (minuscules, sans espaces)'}>
            <input value={name} onChange={(e) => setName(e.target.value)} disabled={isEdit} className={`${inputCls} disabled:bg-ink-50 disabled:text-ink-400`} placeholder="promo_ete" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Catégorie">
              <select value={category} onChange={(e) => setCategory(e.target.value as 'MARKETING' | 'UTILITY')} className={inputCls}>
                <option value="MARKETING">marketing</option>
                <option value="UTILITY">utility</option>
              </select>
            </Field>
            <Field label={isEdit ? 'Langue (non modifiable)' : 'Langue'}>
              <input value={language} onChange={(e) => setLanguage(e.target.value)} disabled={isEdit} className={`${inputCls} disabled:bg-ink-50 disabled:text-ink-400`} placeholder="fr" />
            </Field>
          </div>

          <div className="mt-3">
            <label className="mb-1 block text-sm font-medium text-ink-700">En-tête (optionnel)</label>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={headerType}
                onChange={(e) => { setHeaderType(e.target.value as 'none' | 'TEXT' | 'IMAGE' | 'VIDEO'); clearHeaderMedia(); }}
                className={`${inputCls} max-w-[150px]`}
              >
                <option value="none">Aucun</option>
                <option value="TEXT">Texte</option>
                <option value="IMAGE">Image</option>
                <option value="VIDEO">Vidéo</option>
              </select>
              {headerType === 'TEXT' && (
                <input value={headerText} onChange={(e) => setHeaderText(e.target.value)} maxLength={60} placeholder="Titre fixe (60 car. max, sans variable)" className={`${inputCls} flex-1`} />
              )}
              {(headerType === 'IMAGE' || headerType === 'VIDEO') && (
                <>
                  <button type="button" onClick={() => headerFileRef.current?.click()} disabled={headerUploading} className="rounded-lg border border-ink-300 px-3 py-2 text-sm text-ink-700 hover:bg-ink-50 disabled:opacity-50">
                    {headerUploading ? 'Upload…' : headerHandle ? 'Remplacer' : headerType === 'IMAGE' ? 'Choisir une image' : 'Choisir une vidéo (mp4)'}
                  </button>
                  {headerFileName && <span className="max-w-[140px] truncate text-xs text-ink-500">{headerFileName} ✓</span>}
                  <input ref={headerFileRef} type="file" accept={headerType === 'IMAGE' ? 'image/png,image/jpeg' : 'video/mp4'} className="hidden" onChange={(e) => onHeaderFile(e.target.files?.[0])} />
                </>
              )}
            </div>
          </div>

          <div className="mt-3">
            <label className="mb-1 block text-sm font-medium text-ink-700">Corps du message</label>
            <div className="relative">
              <VariableBodyEditor
                ref={bodyEditorRef}
                value={body}
                varLabels={varSources.map((v) => v?.label)}
                onChange={setBody}
                placeholder={'Bonjour [Prénom], voici notre offre 🎉'}
                className={`${inputCls} pr-28`}
              />
              <div className="absolute bottom-2 right-2 flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => { setFieldPickerOpen((o) => !o); setEmojiOpen(false); }}
                  className="rounded-md border border-ink-200 bg-white px-2 py-1 text-xs font-medium text-brand-600 hover:bg-brand-50"
                  title="Insérer une variable (champ du contact)"
                >
                  + Variable
                </button>
                <button
                  type="button"
                  onClick={() => { setEmojiOpen((o) => !o); setFieldPickerOpen(false); }}
                  className="rounded-md p-1 text-lg leading-none hover:bg-ink-100"
                  aria-label="Insérer un emoji"
                >
                  😊
                </button>
              </div>
              {emojiOpen && <EmojiPicker onPick={insertEmoji} onClose={() => setEmojiOpen(false)} />}
              {fieldPickerOpen && <FieldPicker options={fieldOptions} onPick={insertVariable} onClose={() => setFieldPickerOpen(false)} />}
            </div>
            <p className="mt-1 text-xs text-ink-400">Clique « + Variable » pour insérer un champ du contact (nom, prénom, email…) : l&apos;exemple exigé par Meta se remplit tout seul.</p>
          </div>

          <div className="mt-3">
            <label className="mb-1 block text-sm font-medium text-ink-700">Pied de page (optionnel)</label>
            <input value={footer} onChange={(e) => setFooter(e.target.value)} maxLength={60} placeholder="Petit texte en bas (60 car. max, sans variable)" className={inputCls} />
          </div>

          {bodyPositions.length > 0 && (
            <div className="mt-2">
              <label className="mb-1 block text-sm font-medium text-ink-700">Exemples de variables (requis par Meta)</label>
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
                      placeholder="ex. Julie"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="mt-3">
            <div className="mb-1 flex items-center justify-between">
              <label className="text-sm font-medium text-ink-700">Boutons</label>
              <div className="flex gap-2 text-xs">
                {/* Un bouton FLOW est EXCLUSIF (contrainte Meta) : on masque les autres si un FLOW est là,
                    et « + Flow » remplace tous les boutons par un unique bouton FLOW. */}
                {!hasFlow && (
                  <>
                    <button type="button" onClick={() => setButtons([...buttons, { type: 'QUICK_REPLY', text: '' }])} className="text-brand-600 hover:underline">+ réponse rapide</button>
                    <button type="button" onClick={() => setButtons([...buttons, { type: 'URL', text: '', url: '' }])} className="text-brand-600 hover:underline">+ lien</button>
                    <button type="button" onClick={() => setButtons([{ type: 'FLOW', text: '', flowId: '' }])} className="text-brand-600 hover:underline" title="Un bouton formulaire : créer un formulaire inline ou en choisir un déjà publié">+ Flow</button>
                  </>
                )}
              </div>
            </div>
            <div className="space-y-2">
              {buttons.map((b, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <span className="w-16 shrink-0 text-xs text-ink-400">{b.type === 'URL' ? 'lien' : b.type === 'FLOW' ? 'flow' : 'réponse'}</span>
                  <input
                    value={b.text}
                    onChange={(e) => setButtons(buttons.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))}
                    className={`${inputCls} flex-1`}
                    placeholder="Texte du bouton"
                  />
                  {b.type === 'URL' && (
                    <input
                      value={b.url ?? ''}
                      onChange={(e) => setButtons(buttons.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))}
                      className={`${inputCls} w-28`}
                      placeholder="https://..."
                    />
                  )}
                  {b.type === 'FLOW' && (
                    <select
                      value={b.flowId ?? ''}
                      onChange={(e) => setButtons(buttons.map((x, j) => (j === i ? { ...x, flowId: e.target.value } : x)))}
                      className={`${inputCls} w-40`}
                    >
                      <option value="">Choisir un formulaire…</option>
                      {pubFlows.map((f) => (
                        <option key={f.id} value={f.id}>{f.name}</option>
                      ))}
                    </select>
                  )}
                  <button type="button" onClick={() => setButtons(buttons.filter((_, j) => j !== i))} className="shrink-0 text-ink-400 hover:text-red-600" aria-label="Retirer">×</button>
                </div>
              ))}
            </div>

            {/* Bouton FLOW : choisir un formulaire publié OU en créer un inline (publié aussitôt puis attaché). */}
            {hasFlow && (
              <div className="mt-2">
                {!creatingFlow ? (
                  <button type="button" onClick={() => setCreatingFlow(true)} className="text-xs font-medium text-brand-600 hover:underline">
                    ＋ Créer un nouveau formulaire
                  </button>
                ) : (
                  <div className="rounded-xl border border-brand-200 bg-brand-50/40 p-4">
                    <div className="mb-3 flex items-center justify-between">
                      <span className="text-sm font-semibold text-ink-900">Nouveau formulaire</span>
                      <button type="button" onClick={() => setCreatingFlow(false)} className="text-xs text-ink-400 hover:text-ink-700">Annuler</button>
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
            {busy ? 'Envoi...' : isEdit ? 'Enregistrer les modifications' : 'Créer le template'}
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
