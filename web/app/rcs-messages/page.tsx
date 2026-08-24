'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import type { Session } from '@/lib/session';
import {
  listRcsMessages, createRcsMessage, updateRcsMessage, deleteRcsMessage, listUserFields,
  type RcsMessage, type RcsSuggestion, type UserFieldDef,
} from '@/lib/api';
import {
  versMessageRcs, versBrouillonRcs, maxTexteRcs, EMOJIS_RCS, MAX_BOUTONS_RCS,
  type BrouillonRcs,
} from '@/lib/rcs';
import { emailResolvableFields } from '@/lib/fields';
import { useT } from '@/lib/i18n';
import { inputCls } from '@/lib/ui';

/**
 * Contenu > Messages RCS : la bibliothèque des messages réutilisables du canal RCS.
 *
 * Différence de fond avec les templates WhatsApp, et c'est ce qui change tout à l'usage : un message RCS
 * n'est soumis à PERSONNE. Pas de validation, pas d'attente. On écrit, on enregistre, on envoie. La
 * bibliothèque sert donc à réutiliser un message sur plusieurs campagnes et scénarios, pas à le faire
 * approuver.
 *
 * Trois choses se composent ici : le texte (avec ses variables `{{champ}}` et ses emojis), un visuel
 * d'en-tête facultatif, et jusqu'à 11 boutons. Le format envoyé se DÉDUIT de la saisie : TEXTE sans visuel,
 * CARTE dès qu'il y en a un (`web/lib/rcs.ts`). Le CARROUSEL n'a pas de composeur ; un message de ce format
 * est listé, signalé, et non éditable ici plutôt qu'ouvert à moitié.
 */
export default function RcsMessagesPage() {
  return <AppShell active="rcs-messages">{(session) => <RcsMessagesInner session={session} />}</AppShell>;
}

type Brouillon = BrouillonRcs & { name: string };
const VIDE: Brouillon = { name: '', text: '', imageUrl: '', suggestions: [] };

/** Extensions acceptées par le provider pour l'image d'une carte. Contrôlé ICI parce qu'un `.webp` ou un
 *  `.svg` passe la validation d'URL et se fait refuser à l'ENVOI, c'est-à-dire devant un client. */
const IMAGE_RE = /\.(jpe?g|png|gif)(\?.*)?$/i;

function RcsMessagesInner({ session }: { session: Session }) {
  const t = useT();
  const [items, setItems] = useState<RcsMessage[]>([]);
  const [fields, setFields] = useState<UserFieldDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<Brouillon>(VIDE);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [busy, setBusy] = useState(false);
  const [emojisOuverts, setEmojisOuverts] = useState(false);
  const texteRef = useRef<HTMLTextAreaElement>(null);

  const reload = useCallback(async () => {
    try {
      const r = await listRcsMessages(session.tenantId);
      setItems(r.messages);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('Chargement impossible', 'Loading failed'));
    } finally {
      setLoading(false);
    }
  }, [session.tenantId, t]);

  useEffect(() => { void reload(); }, [reload]);
  // `?? []` : une réponse sans `fields` (route absente, câblage de test) mettrait `undefined` dans l'état, et
  // le rendu suivant planterait sur `.filter`. Même garde que partout ailleurs sur une liste distante.
  useEffect(() => { listUserFields(session.tenantId).then((r) => setFields(r.fields ?? [])).catch(() => {}); }, [session.tenantId]);

  // Mêmes variables que les modèles d'email, et ce n'est pas une coïncidence : les deux canaux passent par la
  // MÊME table de substitution côté serveur (`contactVars`). Proposer ici une clé qu'elle ne connaît pas
  // afficherait du vide sur le téléphone du contact.
  const variables = emailResolvableFields(fields);
  const maxTexte = maxTexteRcs(form.imageUrl);
  const imageDouteuse = form.imageUrl.trim() !== '' && !IMAGE_RE.test(form.imageUrl.trim());

  // Un bouton lien sans URL, ou un bouton appel sans numéro, partirait chez le provider et serait refusé.
  // On bloque l'enregistrement plutôt que de laisser découvrir l'erreur au moment de l'envoi.
  const pret = form.name.trim() !== '' && form.text.trim() !== '' && form.text.length <= maxTexte
    && form.suggestions.every((s) => s.text.trim() !== ''
      && (s.kind !== 'openUrl' || s.url.trim() !== '')
      && (s.kind !== 'dial' || s.phoneNumber.trim() !== ''));

  /** Insère du texte à la position du curseur du champ Message, et y garde le focus juste après. */
  function inserer(jeton: string) {
    const zone = texteRef.current;
    if (!zone) return;
    const debut = zone.selectionStart ?? zone.value.length;
    const fin = zone.selectionEnd ?? zone.value.length;
    const suite = zone.value.slice(0, debut) + jeton + zone.value.slice(fin);
    setForm((f) => ({ ...f, text: suite }));
    const curseur = debut + jeton.length;
    requestAnimationFrame(() => { zone.focus(); zone.setSelectionRange(curseur, curseur); });
  }

  async function enregistrer() {
    if (!pret || editing === null) return;
    setBusy(true);
    setError(null);
    try {
      const contenu = versMessageRcs(form);
      if (editing === 'new') await createRcsMessage(session.tenantId, form.name.trim(), contenu);
      else await updateRcsMessage(session.tenantId, editing, form.name.trim(), contenu);
      setEditing(null);
      setForm(VIDE);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('Enregistrement impossible', 'Save failed'));
    } finally {
      setBusy(false);
    }
  }

  async function supprimer(m: RcsMessage) {
    if (!window.confirm(t(`Supprimer « ${m.name} » ?`, `Delete "${m.name}"?`))) return;
    setError(null);
    try {
      await deleteRcsMessage(session.tenantId, m.id);
      if (editing === m.id) { setEditing(null); setForm(VIDE); }
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('Suppression impossible', 'Delete failed'));
    }
  }

  function majBouton(i: number, patch: Partial<RcsSuggestion>) {
    setForm((f) => ({
      ...f,
      suggestions: f.suggestions.map((s, j) => (j === i ? ({ ...s, ...patch } as RcsSuggestion) : s)),
    }));
  }

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-4 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-ink-900">{t('Messages RCS', 'RCS messages')}</h1>
          <p className="mt-0.5 text-sm text-ink-500">
            {t("Aucune validation à obtenir : un message RCS part tel qu'il est écrit, sous votre agent de marque.", 'No approval needed: an RCS message goes out as written, under your brand agent.')}
          </p>
        </div>
        <button
          onClick={() => { setEditing('new'); setForm(VIDE); }}
          data-testid="rcs-message-new"
          className="shrink-0 rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-brand-600"
        >
          + {t('Nouveau message', 'New message')}
        </button>
      </div>

      {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {editing !== null && (
        <div className="mb-6 rounded-xl border border-ink-200 p-4">
          <div className="mb-3">
            <label className="mb-1 block text-xs font-medium text-ink-600">{t('Nom (interne)', 'Name (internal)')}</label>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              maxLength={120}
              data-testid="rcs-message-name"
              className={`${inputCls} max-w-md`}
              placeholder={t('Offre du jour', 'Daily offer')}
            />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-ink-600">{t('Image d’en-tête (facultatif)', 'Header image (optional)')}</label>
              <input
                value={form.imageUrl}
                onChange={(e) => setForm({ ...form, imageUrl: e.target.value })}
                data-testid="rcs-message-image"
                className={inputCls}
                placeholder="https://…/visuel.jpg"
              />
              <p className="mt-1 text-[11px] text-ink-400">
                {t('Une adresse publique, en .jpg .png ou .gif. Le message devient une carte : l’image s’affiche au-dessus du texte.', 'A public URL, .jpg .png or .gif. The message becomes a card: the image shows above the text.')}
              </p>
              {imageDouteuse && (
                <p className="mt-1 text-[11px] text-amber-700" data-testid="rcs-message-image-warn">
                  {t('Cette adresse ne finit pas par .jpg, .png ou .gif : l’opérateur refusera l’envoi.', 'This URL does not end in .jpg, .png or .gif: the carrier will refuse the send.')}
                </p>
              )}

              <div className="mb-1 mt-3 flex items-center justify-between gap-2">
                <label className="block text-xs font-medium text-ink-600">{t('Message', 'Message')}</label>
                <span className={`text-[11px] ${form.text.length > maxTexte ? 'font-medium text-coral' : 'text-ink-400'}`}>
                  {form.text.length} / {maxTexte}
                </span>
              </div>
              <textarea
                ref={texteRef}
                value={form.text}
                onChange={(e) => setForm({ ...form, text: e.target.value })}
                rows={5}
                data-testid="rcs-message-text"
                className={inputCls}
                placeholder={t('Votre message…', 'Your message…')}
              />

              {/* Insertions au curseur : variables du contact, puis emojis. Même geste que les modèles d'email. */}
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {variables.map((f) => (
                  <button
                    key={f.key}
                    type="button"
                    data-testid={`rcs-message-var-${f.key}`}
                    onClick={() => inserer(`{{${f.key}}}`)}
                    title={f.label}
                    className="rounded-full border border-ink-200 bg-ink-50 px-2 py-0.5 text-[11px] font-medium text-ink-700 hover:bg-brand-50 hover:text-brand-700"
                  >
                    {`{{${f.key}}}`}
                  </button>
                ))}
                <button
                  type="button"
                  data-testid="rcs-message-emoji-toggle"
                  onClick={() => setEmojisOuverts((v) => !v)}
                  className="rounded-full border border-ink-200 bg-ink-50 px-2 py-0.5 text-[11px] font-medium text-ink-700 hover:bg-brand-50"
                >
                  🙂 {t('Emoji', 'Emoji')}
                </button>
              </div>
              {emojisOuverts && (
                <div className="mt-1.5 flex flex-wrap gap-0.5 rounded-lg border border-ink-200 bg-white p-1.5" data-testid="rcs-message-emojis">
                  {EMOJIS_RCS.map((e) => (
                    <button
                      key={e}
                      type="button"
                      onClick={() => inserer(e)}
                      className="rounded px-1.5 py-0.5 text-base leading-none hover:bg-ink-100"
                      aria-label={e}
                    >
                      {e}
                    </button>
                  ))}
                </div>
              )}
              <p className="mt-1 text-[11px] text-ink-400">
                {t('Les variables sont remplacées par la fiche du contact à l’envoi. Sans valeur, elles laissent un blanc.', 'Variables are filled in from the contact at send time. With no value, they leave a blank.')}
              </p>

              <label className="mb-1 mt-3 block text-xs font-medium text-ink-600">{t('Boutons', 'Buttons')}</label>
              <div className="space-y-2">
                {form.suggestions.map((s, i) => (
                  <div key={i} className="rounded-lg border border-ink-200 p-2">
                    <div className="flex items-center gap-1.5">
                      <select
                        value={s.kind}
                        onChange={(e) => {
                          const kind = e.target.value as RcsSuggestion['kind'];
                          const base = { text: s.text, postbackData: s.postbackData };
                          majBouton(i, kind === 'reply' ? { ...base, kind }
                            : kind === 'openUrl' ? { ...base, kind, url: '' }
                              : { ...base, kind, phoneNumber: '' });
                        }}
                        className={`${inputCls} max-w-[9rem] bg-white`}
                      >
                        <option value="reply">{t('Réponse', 'Reply')}</option>
                        <option value="openUrl">{t('Lien', 'Link')}</option>
                        <option value="dial">{t('Appel', 'Call')}</option>
                      </select>
                      <input
                        value={s.text}
                        maxLength={25}
                        onChange={(e) => majBouton(i, { text: e.target.value })}
                        className={inputCls}
                        placeholder={t('Libellé du bouton', 'Button label')}
                      />
                      <button
                        type="button"
                        onClick={() => setForm({ ...form, suggestions: form.suggestions.filter((_, j) => j !== i) })}
                        className="shrink-0 text-ink-400 hover:text-coral"
                        aria-label={t('Retirer', 'Remove')}
                      >
                        ×
                      </button>
                    </div>
                    {s.kind === 'openUrl' && (
                      <input value={s.url} onChange={(e) => majBouton(i, { url: e.target.value })} className={`${inputCls} mt-1.5`} placeholder="https://" />
                    )}
                    {s.kind === 'dial' && (
                      <input value={s.phoneNumber} onChange={(e) => majBouton(i, { phoneNumber: e.target.value })} className={`${inputCls} mt-1.5`} placeholder="+33…" />
                    )}
                  </div>
                ))}
              </div>
              {form.suggestions.length < MAX_BOUTONS_RCS && (
                <button
                  type="button"
                  data-testid="rcs-message-add-button"
                  onClick={() => setForm({ ...form, suggestions: [...form.suggestions, { kind: 'reply', text: '', postbackData: '' }] })}
                  className="mt-1.5 text-xs text-brand-600 hover:underline"
                >
                  + {t('bouton', 'button')}
                </button>
              )}
              <p className="mt-1 text-[11px] text-ink-400">
                {t('Maximum 11 boutons, 25 caractères chacun (les variables n’y sont pas remplacées). Un bouton « Réponse » devient une sortie à relier dans un scénario ; les boutons lien et appel sortent de la conversation.', 'Up to 11 buttons, 25 characters each (variables are not substituted there). A "Reply" button becomes an output to connect in a scenario; link and call buttons leave the conversation.')}
              </p>
            </div>

            {/* Aperçu : la bulle telle que le contact la verra. Mint, comme le canal RCS dans l'inbox. */}
            <div>
              <label className="mb-1 block text-xs font-medium text-ink-600">{t('Aperçu', 'Preview')}</label>
              <div className="rounded-xl bg-ink-50 p-3">
                <div className="max-w-[85%] overflow-hidden rounded-2xl bg-mint-100">
                  {form.imageUrl.trim() !== '' && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={form.imageUrl.trim()}
                      alt={t('Aperçu de l’image', 'Image preview')}
                      referrerPolicy="no-referrer"
                      data-testid="rcs-preview-image"
                      className="aspect-video w-full bg-ink-100 object-cover"
                    />
                  )}
                  <div data-testid="rcs-preview-text" className="whitespace-pre-wrap px-3 py-2 text-sm text-ink-800">
                    {form.text.trim() || <span className="italic text-ink-400">{t('Votre message…', 'Your message…')}</span>}
                  </div>
                </div>
                <div data-testid="rcs-preview-buttons" className="mt-2 flex flex-wrap gap-1.5">
                  {form.suggestions.filter((s) => s.text.trim() !== '').map((s, i) => (
                    <span key={i} className="rounded-full border border-mint-500 bg-white px-3 py-1 text-xs text-mint-700">
                      {s.kind === 'openUrl' ? '🔗 ' : s.kind === 'dial' ? '📞 ' : ''}{s.text}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="mt-4 flex items-center gap-2">
            <button
              onClick={() => void enregistrer()}
              disabled={!pret || busy}
              data-testid="rcs-message-save"
              className="rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-40"
            >
              {busy ? t('Enregistrement…', 'Saving…') : t('Enregistrer', 'Save')}
            </button>
            <button onClick={() => { setEditing(null); setForm(VIDE); }} className="text-sm text-ink-500 hover:underline">
              {t('Annuler', 'Cancel')}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-ink-400">{t('Chargement…', 'Loading…')}</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-ink-500">{t('Aucun message pour le moment.', 'No message yet.')}</p>
      ) : (
        <div className="divide-y divide-ink-100 rounded-xl border border-ink-200" data-testid="rcs-message-list">
          {items.map((m) => {
            const b = versBrouillonRcs(m.content);
            return (
              <div key={m.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink-800">
                    {b?.imageUrl ? '🖼️ ' : ''}{m.name}
                  </p>
                  <p className="truncate text-xs text-ink-500">
                    {b ? b.text : <span className="text-amber-700">{t('Format non éditable ici (carrousel, ou carte à titre)', 'Format not editable here (carousel, or titled card)')}</span>}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  {b && (
                    <button onClick={() => { setEditing(m.id); setForm({ name: m.name, ...b }); }} className="text-sm text-brand-600 hover:underline">
                      {t('Modifier', 'Edit')}
                    </button>
                  )}
                  <button onClick={() => void supprimer(m)} className="text-sm text-ink-400 hover:text-coral">
                    {t('Supprimer', 'Delete')}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
