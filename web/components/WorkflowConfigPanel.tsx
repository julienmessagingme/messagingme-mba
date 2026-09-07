'use client';

import type { TemplateSummary, FlowSummary, TagCount, UserFieldDef, EmailAccount, EmailTemplate, RcsMessage, WorkflowNodeType } from '@/lib/api';
import type { AgentResume } from '@/lib/api-agent';
import { useT } from '@/lib/i18n';
import { MAX_DESTINATAIRES_EMAIL, nodeMetaOf } from '@/lib/nodeMeta';
import { emailResolvableFields } from '@/lib/fields';
import { isCampaignEligible } from '@/lib/campaign-eligibility';
import { carouselOutputs } from '@/lib/carousel-outputs';
import { versBrouillonRcs, maxTexteRcs, MAX_BOUTONS_CARTE, MAX_BOUTONS_RCS } from '@/lib/rcs';
import { boutonsDepuisNode } from '@/lib/rcs-boutons';
import { RcsButtonsEditor } from '@/components/RcsButtonsEditor';
import { ChampImageHebergee } from '@/components/ChampImageHebergee';
import { RcsPreview } from '@/components/RcsPreview';
import { ChampCorpsVariables } from '@/components/ChampCorpsVariables';
import { ConditionBuilder, type ConditionGroup } from '@/components/ConditionBuilder';
import { sortiesDuBloc, type EmailRecipientData, type RFNode } from '@/lib/workflow-canevas';

/**
 * Le panneau de DROITE : la configuration du bloc sélectionné, un cas par nature de bloc.
 *
 * Sorti de `WorkflowBuilder.tsx` le 2026-09-01 (lot 7), et c'est la moitié du fichier qui part. Le découpage
 * est sûr parce que la frontière existait DÉJÀ : ce panneau ne touche pas au canevas, il reçoit le bloc et
 * rend un patch de `data` par `onPatch`. Rien de l'état du builder n'a eu à voyager en paramètre.
 */

const cls = 'w-full rounded-lg border border-ink-300 px-2.5 py-1.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';

/**
 * Choix d'un tag, avec suggestions. Partagé par le bloc Action et par le bloc `tag` LEGACY (retiré de la
 * palette mais rendu à vie pour les anciens graphes) : les deux en portaient une copie, et elles avaient déjà
 * commencé à diverger.
 *
 * `onCommit` n'est fourni que pour un AJOUT : quitter le champ crée alors le tag dans Contenu > Tags. Sur un
 * retrait, il n'y a rien à créer.
 */
function TagPicker({ label, value, tags, onChange, onCommit }: {
  label: string;
  value: string;
  tags: TagCount[];
  onChange: (v: string) => void;
  onCommit?: (v: string) => void;
}) {
  const t = useT();
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-ink-600">{label}</label>
      <input
        list="wf-tags"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => onCommit?.(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onCommit?.((e.target as HTMLInputElement).value); } }}
        className={cls}
        placeholder={t('vip, prospect…', 'vip, prospect…')}
      />
      <datalist id="wf-tags">{tags.map((tg) => <option key={tg.tag} value={tg.tag} />)}</datalist>
      {onCommit && <p className="mt-1 text-[11px] text-ink-400">{t('L’étiquette est ajoutée à Contenu > Bibliothèque > Étiquettes dès que tu quittes le champ.', 'The tag is added to Content > Library > Tags as soon as you leave the field.')}</p>}
    </div>
  );
}

/**
 * Choix d'un champ de contact, et (si `avecValeur`) de la valeur à y poser : fixe, ou l'instant du passage.
 * Partagé par le bloc Action (`set_field` / `clear_field`) et par le bloc `field` LEGACY.
 */
function FieldValueEditor({ d, fields, onPatch, avecValeur }: {
  d: Record<string, unknown>;
  fields: UserFieldDef[];
  onPatch: (p: Record<string, unknown>) => void;
  avecValeur: boolean;
}) {
  const t = useT();
  return (
    <div className="space-y-2">
      <div>
        <label className="mb-1 block text-xs font-medium text-ink-600">{t('Champ', 'Field')}</label>
        <select
          value={(d.fieldKey as string) ?? ''}
          onChange={(e) => { const f = fields.find((x) => x.key === e.target.value); onPatch({ fieldKey: e.target.value, fieldLabel: f?.label ?? '' }); }}
          className={`${cls} bg-white`}
        >
          <option value="">{t('Choisir…', 'Choose…')}</option>
          {fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
        </select>
      </div>
      {avecValeur && (
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-600">{t('Valeur', 'Value')}</label>
          <select
            data-testid="champ-valeur-nature"
            value={d.valueKind === 'now' || d.valueKind === 'derniere_saisie' ? String(d.valueKind) : 'fixed'}
            onChange={(e) => onPatch({ valueKind: e.target.value })}
            className={`${cls} bg-white`}
          >
            <option value="fixed">{t('valeur fixe', 'fixed value')}</option>
            <option value="now">{t('maintenant (date + heure)', 'now (date + time)')}</option>
            <option value="derniere_saisie">{t('dernier message du contact', 'contact’s last message')}</option>
          </select>
          {d.valueKind === 'now' ? (
            <p className="mt-1.5 text-[11px] text-ink-400">{t('Pose la date et l’heure du moment où le contact atteint ce bloc, dans votre fuseau, utile pour une condition « avant / après ».', 'Sets the date and time when the contact reaches this block, in your time zone, useful for a “before / after” condition.')}</p>
          ) : d.valueKind === 'derniere_saisie' ? (
            <p className="mt-1.5 text-[11px] text-ink-400">{t('Recopie dans ce champ le dernier message écrit par le contact. Rien n’est écrit s’il n’a encore rien dit.', 'Copies the contact’s last written message into this field. Nothing is written if they haven’t said anything yet.')}</p>
          ) : (
            <input value={(d.value as string) ?? ''} onChange={(e) => onPatch({ value: e.target.value })} className={`${cls} mt-1.5`} placeholder={t('valeur à poser', 'value to set')} />
          )}
        </div>
      )}
    </div>
  );
}

export function ConfigPanel({
  node, tenantId, isRoot, campaignEligible, onPatch, onDelete, templates, flows, tags, fields, usageChamps, emailAccounts, emailTemplates, rcsMessages, agents, onCommitTag,
}: {
  node: RFNode;
  /** Workspace courant : le champ visuel du bloc RCS téléverse dans SA médiathèque. */
  tenantId: string;
  /** Ce bloc est-il la RACINE du scénario (sans arête entrante) ? C'est lui que la règle campagne regarde. */
  isRoot: boolean;
  /** Le scénario est-il lançable en campagne broadcast (ce qui OUVRE doit être un template configuré) ? */
  campaignEligible: boolean;
  onPatch: (p: Record<string, unknown>) => void; onDelete: () => void;
  templates: TemplateSummary[]; flows: FlowSummary[]; tags: TagCount[]; fields: UserFieldDef[];
  /** Relévé « champ rempli sur N fiches ». null = indisponible -> le sélecteur s'affiche sans compteur. */
  usageChamps: { total: number; parChamp: Record<string, number> } | null;
  emailAccounts: EmailAccount[]; emailTemplates: EmailTemplate[]; rcsMessages: RcsMessage[];
  /** Agents IA actifs, pour le sélecteur du bloc agent. `null` = liste pas encore chargée : on ne peut alors
   *  pas AFFIRMER qu'un agent a disparu. */
  agents: AgentResume[] | null;
  onCommitTag: (tag: string) => void;
}) {
  const t = useT();
  const d = node.data as Record<string, unknown>;
  const wfType = (d.wfType as WorkflowNodeType) ?? 'template';
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-ink-900">{nodeMetaOf(wfType).emoji} {t(...nodeMetaOf(wfType).label)}</span>
        <button onClick={onDelete} className="text-xs text-coral hover:underline">{t('Supprimer', 'Delete')}</button>
      </div>

      {/* Lot D : ouvrir sur autre chose qu'un template est désormais AUTORISÉ (l'enregistrement passe). Ce n'est
          plus une erreur mais une CONSÉQUENCE à connaître : le scénario sort du champ des campagnes broadcast.
          L'avertissement se pose sur la RACINE et suit la MÊME règle que le sélecteur de campagne
          (`isCampaignEligible`), donc il couvre aussi « tag -> template » et un template sans nom choisi. */}
      {isRoot && !campaignEligible && (
        <p className="rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-2 text-[11px] leading-snug text-amber-800">
          {wfType === 'template'
            ? t('Choisis le template de ce bloc : tant qu’il est vide, ce scénario ne pourra pas être lancé en campagne.',
                'Pick this block’s template: while it is empty, this scenario cannot be launched as a campaign.')
            : t('Ce scénario ne pourra pas être lancé en campagne : une campagne part sur une audience froide, donc le PREMIER message envoyé doit être un template. Une étiquette, une action ou une condition avant lui ne posent aucun problème. Il reste utilisable quand le contact vient d’écrire.', 'This scenario cannot be launched as a campaign: a campaign targets a cold audience, so the FIRST message sent must be a template. A tag, an action or a condition before it is fine. It stays usable when the contact has just written.')}
        </p>
      )}

      <div>
        <label className="mb-1 block text-xs font-medium text-ink-600">{t('Nom du bloc', 'Block name')}</label>
        <input value={(d.name as string) ?? ''} maxLength={64} onChange={(e) => onPatch({ name: e.target.value })} className={cls} placeholder={t('optionnel (ex. « Relance J+3 »)', 'optional (e.g. “Follow-up D+3”)')} />
      </div>

      {/* La NATURE d'un bloc se choisit à sa CRÉATION (palette, ou liste proposée quand on tire une flèche) et
          ne se change plus ici : ce panneau ne sert qu'à configurer. Changer le type d'un bloc déjà relié
          laissait derrière lui de la config d'un autre type et des sorties devenues fausses. */}
      <div className="flex items-center gap-2">
        <span className="text-xs">{nodeMetaOf(wfType).emoji}</span>
        <span className="text-xs font-medium text-ink-600">{t(...nodeMetaOf(wfType).label)}</span>
        {typeof d.code === 'string' && d.code !== '' && (
          <span className="ml-auto font-mono text-[10px] text-ink-300" title={t('Code public (API) du bloc, posé au 1er enregistrement', 'Public code (API) of the block, set on first save')}>{d.code}</span>
        )}
      </div>

      {wfType === 'wait' && (
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-600">{t('Attendre avant le bloc suivant', 'Wait before the next block')}</label>
          <div className="flex gap-2">
            <input
              type="number"
              min={1}
              value={Number(d.delay ?? 1)}
              onChange={(e) => onPatch({ delay: Math.max(1, Math.floor(Number(e.target.value) || 1)) })}
              className={`${cls} w-24`}
            />
            <select value={String(d.unit ?? 'hours')} onChange={(e) => onPatch({ unit: e.target.value })} className={`${cls} bg-white`}>
              <option value="minutes">{t('minutes', 'minutes')}</option>
              <option value="hours">{t('heures', 'hours')}</option>
              <option value="days">{t('jours', 'days')}</option>
            </select>
          </div>
          <p className="mt-1 text-[11px] text-ink-400">
            {t("Le délai est tenu à la minute près environ (le réveil des parcours se fait par balayage). Maximum 30 jours.", 'The delay is accurate to about a minute (parcours are woken by a sweep). Maximum 30 days.')}
          </p>
          <p className="mt-1 text-[11px] text-amber-700">
            {t("Après une attente, seul un envoi de TEMPLATE peut encore partir : la fenêtre de 24 h aura le plus souvent expiré. Un message rapide ou un formulaire placé après ne partira pas.", 'After a wait, only a TEMPLATE can still be sent: the 24h window will usually have expired. A quick message or a form placed after will not be sent.')}
          </p>
        </div>
      )}

      {wfType === 'rcs_message' && (() => {
        // Les boutons d'un bloc sont du JSON libre dans `node.data` : `boutonsDepuisNode` les relit de façon
        // DÉFENSIVE (une forme inconnue redevient un bouton « Réponse » réparable en un clic) et rend la même
        // structure typée que les deux autres écrans, qui partagent l'éditeur ci-dessous.
        const boutons = boutonsDepuisNode(d.suggestions);
        // 🔴 D'où vient le message : de la BIBLIOTHÈQUE, ou composé ICI. Demandé par Julien le 2026-08-26 :
        // afficher l'image et le texte à modifier sous un message pris en bibliothèque n'a pas de sens, on
        // vient justement de choisir un message tout fait.
        //
        // Défaut « composé ici » : les blocs DÉJÀ construits n'ont pas ce marqueur et doivent garder leurs
        // champs éditables. Le contenu reste COPIÉ dans le bloc dans les deux cas, c'est de l'affichage.
        const source = d.rcsSource === 'bibliotheque' ? 'bibliotheque' : 'libre';
        const composeIci = source === 'libre';
        return (
          <div className="space-y-3">
            <div className="flex gap-1 rounded-lg bg-ink-50 p-1" role="group">
              {([['bibliotheque', t('Message enregistré', 'Saved message')], ['libre', t('Composer ici', 'Compose here')]] as const).map(([v, libelle]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => onPatch({ rcsSource: v })}
                  data-testid={`rcs-node-source-${v}`}
                  className={`flex-1 rounded-md px-2 py-1 text-xs font-medium transition ${source === v ? 'bg-white text-ink-900 shadow-sm' : 'text-ink-500 hover:text-ink-700'}`}
                >
                  {libelle}
                </button>
              ))}
            </div>
            <div className={composeIci ? 'hidden' : undefined}>
              <label className="mb-1 block text-xs font-medium text-ink-600">{t('Partir d’un message enregistré', 'Start from a saved message')}</label>
              <select
                value=""
                onChange={(e) => {
                  const m = rcsMessages.find((x) => x.id === e.target.value);
                  // COPIE, pas référence : le bloc devient autonome. Modifier la bibliothèque ensuite ne
                  // réécrit donc PAS les scénarios déjà construits, et un message supprimé ne casse rien.
                  const b = versBrouillonRcs(m?.content ?? null);
                  if (b) onPatch({ text: b.text, imageUrl: b.imageUrl, suggestions: b.suggestions });
                }}
                className={`${cls} bg-white`}
                data-testid="rcs-node-library"
              >
                <option value="">{rcsMessages.length === 0 ? t('Aucun message enregistré', 'No saved message') : t('Choisir…', 'Choose…')}</option>
                {rcsMessages.filter((m) => versBrouillonRcs(m.content) !== null).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
              <p className="mt-1 text-[11px] text-ink-400">
                {t('Le message est COPIÉ dans ce bloc : le modifier ici ne touche pas la bibliothèque, et modifier la bibliothèque ne touche pas ce bloc.', 'The message is COPIED into this block: editing it here does not touch the library, and editing the library does not touch this block.')}
              </p>
            </div>

            {!composeIci && (
              // Ce qui a été copié, montré tel que le contact le verra. Sans ça, masquer les champs laisserait
              // un panneau qui ne dit RIEN du message choisi. Même composant que l'aperçu de l'inbox.
              <div data-testid="rcs-node-apercu">
                <RcsPreview
                  brouillon={{ text: (d.text as string) ?? '', imageUrl: (d.imageUrl as string) ?? '', suggestions: boutons }}
                  vide={t('Choisis un message enregistré ci-dessus.', 'Pick a saved message above.')}
                />
              </div>
            )}

            <div className={composeIci ? undefined : 'hidden'}>
              <label className="mb-1 block text-xs font-medium text-ink-600">{t('Image d’en-tête (facultatif)', 'Header image (optional)')}</label>
              <ChampImageHebergee
                tenantId={tenantId}
                valeur={(d.imageUrl as string) ?? ''}
                onChange={(imageUrl) => onPatch({ imageUrl })}
                testIdPrefix="rcs-node"
                compact
              />
              <p className="mt-1 text-[11px] text-ink-400">
                {t('JPEG, PNG ou GIF, 2 Mo maximum. Avec un visuel, le texte est limité à 2000 caractères et les boutons passent en liste.', 'JPEG, PNG or GIF, 2 MB maximum. With a visual, the text is capped at 2000 characters and the buttons switch to a list.')}
              </p>
            </div>

            <div className={composeIci ? undefined : 'hidden'}>
              <ChampCorpsVariables
                valeur={(d.text as string) ?? ''}
                onChange={(text) => onPatch({ text })}
                fields={fields}
                label={t('Message RCS', 'RCS message')}
                testId="rcs-node-text"
                max={maxTexteRcs(String(d.imageUrl ?? ''))}
                compact
              />
              <p className="mt-1 text-[11px] text-ink-400">
                {t('« + Variable » insère un champ du contact, remplacé à l’envoi par sa fiche.', '“+ Variable” inserts a contact field, filled in from their record at send time.')}
              </p>
            </div>

            <div className={composeIci ? undefined : 'hidden'}>
              <label className="mb-1 block text-xs font-medium text-ink-600">{t('Boutons', 'Buttons')}</label>
              <RcsButtonsEditor
                boutons={boutons}
                onChange={(suggestions) => onPatch({ suggestions })}
                // Même règle que les deux autres écrans : un visuel fait passer les boutons DANS la carte,
                // où ils s'affichent en liste pleine largeur, et où le protocole en accepte 4.
                max={String(d.imageUrl ?? '').trim() !== '' ? MAX_BOUTONS_CARTE : MAX_BOUTONS_RCS}
                dateFields={fields}
                compact
                testIdPrefix="rcs-node"
              />
            </div>
          </div>
        );
      })()}

      {wfType === 'template' && (
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-600">{t('Template à envoyer', 'Template to send')}</label>
          <select value={(d.templateName as string) ?? ''} onChange={(e) => { const tpl = templates.find((x) => x.name === e.target.value); onPatch({ templateName: e.target.value, language: tpl?.language ?? 'fr', templateButtons: tpl?.buttons ?? [], templateCards: carouselOutputs(tpl) }); }} className={`${cls} bg-white`}>
            <option value="">{t('Choisir…', 'Choose…')}</option>
            {templates.map((tpl) => <option key={tpl.id || tpl.name} value={tpl.name}>{tpl.name}</option>)}
          </select>
          {Array.isArray(d.templateCards) && (d.templateCards as unknown[]).length > 0 ? (
            <p className="mt-1 text-[11px] text-ink-400">{t('Carousel : chaque réponse rapide de chaque carte devient une ', 'Carousel: each quick reply on each card becomes an ')}<b>{t('sortie', 'output')}</b>{t(' à relier (point à droite du bloc, « C1 » = carte 1). Les boutons lien ne se relient pas : ils ouvrent le navigateur et ne renvoient rien.', ' to connect (dot on the right of the block, “C1” = card 1). Link buttons cannot be connected: they open the browser and send nothing back.')}</p>
          ) : Array.isArray(d.templateButtons) && (d.templateButtons as unknown[]).length > 0 ? (
            <p className="mt-1 text-[11px] text-ink-400">{t('Chaque bouton de réponse rapide devient une ', 'Each quick-reply button becomes an ')}<b>{t('sortie', 'output')}</b>{t(' à relier (point à droite du bloc). Les boutons lien/formulaire ne se relient pas.', ' to connect (dot on the right of the block). Link/form buttons cannot be connected.')}</p>
          ) : null}
        </div>
      )}
      {wfType === 'question' && (() => {
        // Lecture DÉFENSIVE : `data` est du JSON libre, un scénario enregistré par une version antérieure ne
        // doit jamais faire tomber le panneau. Une forme inattendue donne une ligne vide, pas un crash.
        const rows: Array<{ title: string; description: string }> = Array.isArray(d.rows)
          ? (d.rows as Array<{ title?: unknown; description?: unknown }>).map((r) => ({
            title: String(r?.title ?? ''), description: String(r?.description ?? ''),
          }))
          : [];
        const patchRows = (next: Array<{ title: string; description: string }>) => onPatch({ rows: next });
        const delai = Number(d.timeoutValue ?? 0);
        return (
          <div className="space-y-3">
            {/* MÊME composant d'insertion de variables que partout ailleurs (bloc RCS, corps d'un template) :
                jamais un champ nu où il faudrait recopier des accolades à la main. */}
            <div>
              <ChampCorpsVariables
                valeur={(d.body as string) ?? ''}
                onChange={(body) => onPatch({ body })}
                fields={fields}
                label={t('La question', 'The question')}
                testId="question-node-body"
                max={4096}
                compact
              />
            </div>

            {/* AVANT les réponses, dans l'ordre où le contact le voit : la question, le bouton qui ouvre la
                liste, puis la liste. Le champ reste affiché même sans réponse : le faire apparaître à la
                première réponse ajoutée décalerait vers le bas la ligne qu'on est en train de taper. Un
                libellé vide part en « Choisir ». */}
            <div>
              <label className="mb-1 block text-xs font-medium text-ink-600">{t('Bouton qui ouvre le menu', 'Button that opens the menu')}</label>
              <input
                value={(d.buttonLabel as string) ?? ''}
                maxLength={20}
                onChange={(e) => onPatch({ buttonLabel: e.target.value })}
                data-testid="question-node-button"
                className={cls}
                placeholder={t('Choisir', 'Choose')}
              />
              {rows.length === 0 && (
                <p className="mt-1 text-[11px] text-ink-400">
                  {t('Ce bouton n’apparaît que si tu proposes des réponses ci-dessous.', 'This button only appears if you offer answers below.')}
                </p>
              )}
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-ink-600">{t('Réponses proposées (menu)', 'Offered answers (menu)')}</label>
              <div className="space-y-1.5">
                {rows.map((r, i) => (
                  <div key={i} className="rounded-lg border border-ink-200 p-1.5">
                    <div className="flex items-center gap-1.5">
                      <input
                        value={r.title}
                        maxLength={24}
                        onChange={(e) => { const next = [...rows]; next[i] = { ...r, title: e.target.value }; patchRows(next); }}
                        data-testid={`question-row-title-${i}`}
                        className={cls}
                        placeholder={`${t('Réponse', 'Answer')} ${i + 1}`}
                      />
                      {/* 🔴 Passe par le PARENT : retirer une ligne décale les sorties `row:<i>` suivantes,
                          donc il faut remapper les arêtes en même temps. `patchRows` ne voit pas les arêtes. */}
                      <button type="button" onClick={() => window.dispatchEvent(new CustomEvent('wf-row-delete', { detail: { nodeId: node.id, index: i } }))} data-testid={`question-row-del-${i}`} className="shrink-0 text-ink-400 hover:text-coral" aria-label={t('Retirer', 'Remove')}>×</button>
                    </div>
                    <input
                      value={r.description}
                      maxLength={72}
                      onChange={(e) => { const next = [...rows]; next[i] = { ...r, description: e.target.value }; patchRows(next); }}
                      data-testid={`question-row-desc-${i}`}
                      className={`${cls} mt-1 text-[11px]`}
                      placeholder={t('Précision (facultatif)', 'Detail (optional)')}
                    />
                  </div>
                ))}
              </div>
              {rows.length < 10 && (
                <button type="button" onClick={() => patchRows([...rows, { title: '', description: '' }])} data-testid="question-add-row" className="mt-1.5 text-xs text-brand-600 hover:underline">
                  {t('+ réponse', '+ answer')}
                </button>
              )}
              <p className="mt-1 text-[11px] text-ink-400">
                {t('Maximum 10 réponses, 24 caractères chacune. Chaque réponse devient une sortie à relier. Sans aucune réponse, la question part en texte simple et attend une réponse écrite.', 'Maximum 10 answers, 24 characters each. Each answer becomes an output to connect. With no answer at all, the question goes out as plain text and waits for a written reply.')}
              </p>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-ink-600">{t('Si le contact ne répond pas', 'If the contact does not reply')}</label>
              <div className="flex gap-2">
                <input
                  type="number"
                  min={0}
                  value={Number.isFinite(delai) ? delai : 0}
                  onChange={(e) => onPatch({ timeoutValue: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
                  data-testid="question-node-timeout"
                  className={`${cls} w-24`}
                />
                <select value={String(d.timeoutUnit ?? 'hours')} onChange={(e) => onPatch({ timeoutUnit: e.target.value })} data-testid="question-node-timeout-unit" className={`${cls} bg-white`}>
                  <option value="minutes">{t('minutes', 'minutes')}</option>
                  <option value="hours">{t('heures', 'hours')}</option>
                  <option value="days">{t('jours', 'days')}</option>
                </select>
              </div>
              <p className="mt-1 text-[11px] text-ink-400">
                {t('0 = on attend sans limite. Au-delà de 0, une sortie « Pas de réponse » apparaît sur le bloc : relie-la pour prévoir ce cas. Maximum 30 jours.', '0 = wait with no limit. Above 0, a “No reply” output appears on the block: connect it to handle that case. Maximum 30 days.')}
              </p>
            </div>

            <p className="text-[11px] text-amber-700">
              {t('Ce bloc part sur WhatsApp uniquement, et exige que le contact ait écrit dans les 24 h : il ne peut donc pas ouvrir une campagne.', 'This block goes out on WhatsApp only, and requires the contact to have written within 24 hours: it cannot open a campaign.')}
            </p>
          </div>
        );
      })()}
      {wfType === 'quick_message' && (() => {
        const qr = Array.isArray(d.quickReplies) ? (d.quickReplies as string[]) : [];
        return (
          <div className="space-y-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-ink-600">{t('Message', 'Message')}</label>
              <textarea value={(d.body as string) ?? ''} onChange={(e) => onPatch({ body: e.target.value })} rows={3} className={cls} placeholder={t('Ton message…', 'Your message…')} />
            </div>
            {/* MÊME composant et MÊME champ (`imageUrl`) que le bloc RCS : un seul téléversement, un seul
                format de stockage, et le visuel sert aux DEUX canaux. En WhatsApp il devient l'en-tête du
                message interactif ; sur un parcours RCS, la carte du message. */}
            <div>
              <label className="mb-1 block text-xs font-medium text-ink-600">{t('Image (facultatif)', 'Image (optional)')}</label>
              <ChampImageHebergee
                tenantId={tenantId}
                valeur={(d.imageUrl as string) ?? ''}
                onChange={(imageUrl) => onPatch({ imageUrl })}
                testIdPrefix="quick-node"
                compact
              />
              <p className="mt-1 text-[11px] text-ink-400">
                {t('JPEG, PNG ou GIF, 2 Mo maximum. Le message part alors avec le visuel en en-tête. Sans aucune réponse rapide, il part en image légendée.', 'JPEG, PNG or GIF, 2 MB maximum. The message then goes out with the visual as its header. With no quick reply at all, it goes out as a captioned image.')}
              </p>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-ink-600">{t('Réponses rapides', 'Quick replies')}</label>
              <div className="space-y-1.5">
                {qr.map((r, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <input value={r} maxLength={20} onChange={(e) => { const next = [...qr]; next[i] = e.target.value; onPatch({ quickReplies: next }); }} className={cls} placeholder={`${t('Réponse', 'Reply')} ${i + 1}`} />
                    <button type="button" onClick={() => onPatch({ quickReplies: qr.filter((_, j) => j !== i) })} className="shrink-0 text-ink-400 hover:text-coral" aria-label={t('Retirer', 'Remove')}>×</button>
                  </div>
                ))}
              </div>
              {qr.length < 3 && (
                <button type="button" onClick={() => onPatch({ quickReplies: [...qr, ''] })} className="mt-1.5 text-xs text-brand-600 hover:underline">{t('+ réponse rapide', '+ quick reply')}</button>
              )}
              <p className="mt-1 text-[11px] text-ink-400">{t('Max 3, 20 caractères. Chaque réponse devient une sortie à relier (point à droite du bloc).', 'Max 3, 20 characters. Each reply becomes an output to connect (dot on the right of the block).')}</p>
            </div>
          </div>
        );
      })()}
      {wfType === 'flow' && (
        <div className="space-y-2">
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-600">{t('Formulaire (publié)', 'Form (published)')}</label>
            {/* La sélection pré-remplit le libellé du bouton avec le cta du formulaire (modifiable ensuite). */}
            <select value={(d.flowId as string) ?? ''} onChange={(e) => { const f = flows.find((x) => x.id === e.target.value); onPatch({ flowId: e.target.value, flowName: f?.name ?? '', cta: (f?.cta ?? '') || 'Envoyer' }); }} className={`${cls} bg-white`}>
              <option value="">{t('Choisir…', 'Choose…')}</option>
              {flows.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
            {flows.length === 0 && <p className="mt-1 text-[11px] text-ink-400">{t('Aucun formulaire publié. Crée-en un dans Contenu > Formulaires.', 'No published form. Create one in Content > Forms.')}</p>}
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-600">{t('Texte d’accroche', 'Message text')}</label>
            <textarea value={(d.body as string) ?? ''} onChange={(e) => onPatch({ body: e.target.value })} rows={2} className={cls} placeholder={t('Défaut : « Formulaire : <nom> »', 'Default: “Form: <name>”')} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-600">{t('Libellé du bouton', 'Button label')}</label>
            <input value={(d.cta as string) ?? ''} maxLength={30} onChange={(e) => onPatch({ cta: e.target.value })} className={cls} placeholder={t('Envoyer', 'Send')} />
          </div>
        </div>
      )}
      {/* Blocs `tag` et `field` : LEGACY (hors palette depuis le bloc Action), mais rendus à vie pour les
          graphes déjà enregistrés. Ils réutilisent les sous-formulaires du bloc Action, sans quoi toute
          correction devrait être faite deux fois. */}
      {wfType === 'tag' && (
        <TagPicker
          label={t('Étiquette à ajouter', 'Tag to add')}
          value={(d.tag as string) ?? ''}
          tags={tags}
          onChange={(v) => onPatch({ tag: v })}
          onCommit={onCommitTag}
        />
      )}
      {wfType === 'field' && <FieldValueEditor d={d} fields={fields} onPatch={onPatch} avecValeur />}
      {wfType === 'action' && (() => {
        const kind = (d.actionKind as string) ?? 'add_tag';
        const isTag = kind === 'add_tag' || kind === 'remove_tag';
        // Le consentement n'a RIEN à configurer : le sens est dans le choix de l'action. Pas de second champ,
        // donc pas de bloc « incomplet » possible, contrairement à un tag ou un champ laissé vide.
        const isConsentement = kind === 'set_optin' || kind === 'set_optout';
        return (
          <div className="space-y-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-ink-600">{t('Action', 'Action')}</label>
              <select value={kind} onChange={(e) => onPatch({ actionKind: e.target.value })} data-testid="action-kind" className={`${cls} bg-white`}>
                <option value="add_tag">{t('Ajouter une étiquette', 'Add a tag')}</option>
                <option value="remove_tag">{t('Retirer une étiquette', 'Remove a tag')}</option>
                <option value="set_field">{t('Mettre à jour un champ', 'Update a field')}</option>
                <option value="clear_field">{t('Vider un champ', 'Clear a field')}</option>
                <option value="set_optin">{t('Passer en opt-in', 'Mark as opted in')}</option>
                <option value="set_optout">{t('Passer en opt-out', 'Mark as opted out')}</option>
              </select>
            </div>
            {isConsentement ? (
              <p className="text-[11px] leading-snug text-ink-500">
                {kind === 'set_optin'
                  ? t(
                    "Le contact devient destinataire des campagnes marketing. À placer après une étape où il a donné son accord, pas au hasard d'un parcours.",
                    'The contact becomes eligible for marketing campaigns. Place it after a step where they agreed, not anywhere in a flow.',
                  )
                  : t(
                    "Le contact est exclu de toute campagne, y compris de celles déjà programmées. C'est ce qu'il faut derrière un mot-clé de désinscription.",
                    'The contact is excluded from every campaign, including already scheduled ones. This is what belongs behind an unsubscribe keyword.',
                  )}
              </p>
            ) : isTag ? (
              <TagPicker
                label={kind === 'add_tag' ? t('Étiquette à ajouter', 'Tag to add') : t('Étiquette à retirer', 'Tag to remove')}
                value={(d.tag as string) ?? ''}
                tags={tags}
                onChange={(v) => onPatch({ tag: v })}
                {...(kind === 'add_tag' ? { onCommit: onCommitTag } : {})}
              />
            ) : (
              <FieldValueEditor d={d} fields={fields} onPatch={onPatch} avecValeur={kind === 'set_field'} />
            )}
          </div>
        );
      })()}
      {wfType === 'condition' && (
        <div className="space-y-2">
          <p className="text-[11px] leading-snug text-ink-400">{t('Le contact tire le fil « Si réunie » (vert) quand la condition est vraie, sinon « Sinon » (rouge). Relie chaque sortie à un bloc.', 'The contact follows “If met” (green) when the condition is true, otherwise “Otherwise” (red). Connect each output to a block.')}</p>
          <ConditionBuilder
            group={{ match: (d.match as 'all' | 'any') ?? 'all', clauses: Array.isArray(d.clauses) ? (d.clauses as ConditionGroup['clauses']) : [] }}
            onChange={(g) => onPatch({ match: g.match, clauses: g.clauses })}
            fields={fields}
            tags={tags.map((tg) => tg.tag)}
          />
        </div>
      )}
      {wfType === 'inbox' && (
        <p className="text-xs leading-relaxed text-ink-500">
          {t(
            "Le fil passe à un humain : le scénario s'arrête ici et la conversation apparaît dans « À traiter » dans l'Inbox. À placer APRÈS le message qui annonce le conseiller, c'est lui qui fait taire l'agent automatique.",
            "The thread goes to a human: the scenario stops here and the conversation shows up under “To handle” in the Inbox. Place it AFTER the message announcing the advisor, that message is what silences the automatic agent.",
          )}
        </p>
      )}
      {wfType === 'agent' && (
        <div className="flex flex-col gap-2">
          <label className="text-xs font-medium text-ink-700">{t('Quel agent tient la conversation', 'Which agent holds the conversation')}</label>
          <select
            data-testid="agent-node-select"
            className={`${cls} bg-white`}
            value={String(d.agentId ?? '')}
            onChange={(e) => {
              const choisi = (agents ?? []).find((a) => a.id === e.target.value);
              // Les sorties sont COPIÉES ici. C'est ce qui rend le graphe auto-suffisant : le moteur route
              // sur les handles du graphe, sans relire la fiche de l'agent. Aucun agent choisi -> on efface
              // aussi les sorties, sinon le bloc garderait des branches sans rien derrière.
              onPatch(choisi
                ? { agentId: choisi.id, agentLabel: choisi.label, sorties: choisi.sorties }
                : { agentId: '', agentLabel: '', sorties: [] });
              // Et les ARÊTES des anciennes sorties partent avec elles : les garder laisserait des branches
              // fantômes, enregistrées mais sans poignée pour les voir.
              window.dispatchEvent(new CustomEvent('wf-agent-change', {
                detail: { nodeId: node.id, codes: (choisi?.sorties ?? []).map((s) => s.code) },
              }));
            }}
          >
            <option value="">{t('choisir un agent IA…', 'choose an AI agent…')}</option>
            {(agents ?? []).map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
          </select>
          {/* Un agent choisi puis DÉSACTIVÉ disparaît de la liste : le bloc garde son libellé mais le
              sélecteur retomberait sur « choisir… » sans rien dire. On le dit. */}
          {/* `agents !== null` : sur une liste pas encore arrivée (ou une lecture en échec), affirmer que
              l'agent n'est plus actif serait un mensonge sur un bloc parfaitement configuré. */}
          {agents !== null && String(d.agentId ?? '') !== '' && !agents.some((a) => a.id === d.agentId) && (
            <p data-testid="agent-node-absent" className="rounded-lg bg-amber-50 px-2 py-1.5 text-[11px] leading-relaxed text-amber-800">
              {t(
                `L’agent « ${String(d.agentLabel ?? '')} » n’est plus actif : ce bloc ne répondra pas tant qu’il ne l’est pas de nouveau.`,
                `The agent “${String(d.agentLabel ?? '')}” is no longer active: this block will not answer until it is again.`,
              )}
            </p>
          )}
          <p className="text-xs leading-relaxed text-ink-500">
            {t(
              'L’agent tient la conversation sur plusieurs tours : tant qu’il l’a, les réponses du contact lui reviennent et le scénario n’avance pas. Il n’en ressort que par une des sorties du bloc.',
              'The agent holds the conversation over several turns: while it does, the contact’s replies go to it and the scenario does not advance. It only leaves through one of the block’s outputs.',
            )}
          </p>
          {/* 🔴 La copie est FIGÉE au moment du choix. Une règle d'arrêt ajoutée sur la fiche APRÈS coup
              n'apparaît donc pas toute seule ici, et resterait incâblable : le seul symptôme en production
              serait une escalade en inbox sur une sortie parfaitement légitime. On le dit, et on propose de
              rafraîchir. Jamais automatiquement : ça déclencherait une sauvegarde que personne n'a demandée,
              et ça pourrait élaguer des arêtes sans prévenir. */}
          {(() => {
            const fiche = (agents ?? []).find((a) => a.id === d.agentId);
            if (!fiche) return null;
            const ici = sortiesDuBloc(d).map((s) => s.code).join('|');
            const surLaFiche = fiche.sorties.map((s) => s.code).join('|');
            if (ici === surLaFiche) return null;
            return (
              <div data-testid="agent-node-sorties-obsoletes" className="flex flex-col gap-1.5 rounded-lg bg-brand-50 px-2 py-1.5">
                <p className="text-[11px] leading-relaxed text-ink-700">
                  {t(
                    'Les règles d’arrêt de cet agent ont changé depuis que ce bloc a été configuré.',
                    'This agent’s stop rules have changed since this block was configured.',
                  )}
                </p>
                <button
                  data-testid="agent-node-sorties-maj"
                  className="self-start rounded-md border border-brand-300 bg-white px-2 py-1 text-[11px] text-brand-700 hover:bg-brand-100"
                  onClick={() => {
                    onPatch({ agentLabel: fiche.label, sorties: fiche.sorties });
                    window.dispatchEvent(new CustomEvent('wf-agent-change', {
                      detail: { nodeId: node.id, codes: fiche.sorties.map((s) => s.code) },
                    }));
                  }}
                >
                  {t('Mettre à jour les sorties du bloc', 'Update the block’s outputs')}
                </button>
              </div>
            );
          })()}
          {sortiesDuBloc(d).length === 0 && String(d.agentId ?? '') !== '' && (
            <p className="text-xs leading-relaxed text-ink-500">
              {t(
                'Cet agent n’a aucune règle d’arrêt : il ne sortira que par les sorties automatiques ci-dessous. Les règles d’arrêt se déclarent sur sa fiche, dans le menu AI Agent.',
                'This agent has no stop rule: it will only leave through the automatic outputs below. Stop rules are declared on its card, in the AI Agent menu.',
              )}
            </p>
          )}
        </div>
      )}
      {wfType === 'email' && (() => {
        // ⚠️ `data.to` porte DEUX formes : un OBJET pour les blocs créés avant le 2026-08-25, une LISTE depuis.
        // Rien ne renormalise les anciens graphes, donc la lecture doit tolérer les deux ici comme côté moteur
        // (`emailRecipientsOf`) : n'accepter que la liste afficherait un panneau VIDE sur un bloc qui envoie.
        const destinataires: EmailRecipientData[] = Array.isArray(d.to)
          ? (d.to as EmailRecipientData[])
          : [(d.to as EmailRecipientData | undefined) ?? { kind: 'literal', value: '' }];
        // Écrit TOUJOURS la forme liste : un bloc touché est migré au passage, sans traitement de masse.
        const patchDest = (maj: EmailRecipientData[]) => onPatch({ to: maj });
        const majLigne = (i: number, v: EmailRecipientData) => patchDest(destinataires.map((x, j) => (j === i ? v : x)));
        // Champs proposés comme destinataire « variable » : ceux qui résolvent réellement à l'envoi (le
        // node fait feu au premier échec silencieux si le champ choisi ne tient jamais d'adresse, ex. « Nom »).
        const recipientFields = emailResolvableFields(fields);
        return (
          <div className="space-y-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-ink-600">{t('Boîte d’envoi', 'Sending mailbox')}</label>
              <select
                data-testid="email-account-select"
                value={(d.emailAccountId as string) ?? ''}
                onChange={(e) => onPatch({ emailAccountId: e.target.value })}
                className={`${cls} bg-white`}
              >
                <option value="">{t('Choisir…', 'Choose…')}</option>
                {emailAccounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
              </select>
              {emailAccounts.length === 0 && (
                <p className="mt-1 text-[11px] text-ink-400">{t('Aucune boîte connectée. Connecte-en une depuis le menu Compte > Boîtes email.', 'No mailbox connected yet. Connect one from the Account menu > Email accounts.')}</p>
              )}
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-ink-600">{t('Modèle', 'Template')}</label>
              <select
                data-testid="email-template-select"
                value={(d.templateId as string) ?? ''}
                onChange={(e) => onPatch({ templateId: e.target.value })}
                className={`${cls} bg-white`}
              >
                <option value="">{t('Choisir…', 'Choose…')}</option>
                {emailTemplates.map((tpl) => <option key={tpl.id} value={tpl.id}>{tpl.name}</option>)}
              </select>
              {emailTemplates.length === 0 && (
                <p className="mt-1 text-[11px] text-ink-400">{t('Aucun modèle. Crée-en un dans Contenu > Modèles d’email.', 'No template yet. Create one in Content > Email templates.')}</p>
              )}
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-ink-600">
                {t('Destinataires', 'Recipients')} <span className="font-normal text-ink-400">({destinataires.length}/{MAX_DESTINATAIRES_EMAIL})</span>
              </label>
              {destinataires.map((r, i) => (
                <div key={i} data-testid={`email-recipient-row-${i}`} className="mb-2 rounded-lg border border-ink-100 p-1.5">
                  <div className="mb-1.5 flex items-center justify-between gap-2">
                    {/* Le mode est PAR LIGNE : partagé, changer celui de la 2e adresse remettrait les trois à zéro. */}
                    <div className="inline-flex overflow-hidden rounded-lg border border-ink-200 text-xs">
                      <button
                        type="button"
                        data-testid={`email-recipient-kind-literal-${i}`}
                        onClick={() => majLigne(i, { kind: 'literal', value: '' })}
                        className={`px-2 py-1 font-medium transition ${r.kind !== 'field' ? 'bg-brand-500 text-white' : 'text-ink-600 hover:bg-ink-50'}`}
                      >
                        {t('Adresse fixe', 'Fixed address')}
                      </button>
                      <button
                        type="button"
                        data-testid={`email-recipient-kind-field-${i}`}
                        onClick={() => majLigne(i, { kind: 'field', field: '' })}
                        className={`px-2 py-1 font-medium transition ${r.kind === 'field' ? 'bg-brand-500 text-white' : 'text-ink-600 hover:bg-ink-50'}`}
                      >
                        {t('Variable', 'Variable')}
                      </button>
                    </div>
                    {/* Le 1er destinataire n'est pas supprimable : il porte le « À », les suivants sont en copie
                        cachée. Une liste vidée rendrait le bloc silencieusement inerte côté moteur. */}
                    {i > 0 && (
                      <button
                        type="button"
                        data-testid={`email-recipient-remove-${i}`}
                        onClick={() => patchDest(destinataires.filter((_, j) => j !== i))}
                        className="rounded-md px-1.5 py-0.5 text-xs text-ink-400 hover:bg-coral/10 hover:text-coral"
                        aria-label={t('Retirer ce destinataire', 'Remove this recipient')}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                  {r.kind === 'field' ? (
                    <select
                      data-testid={`email-recipient-field-${i}`}
                      value={r.field ?? ''}
                      onChange={(e) => majLigne(i, { kind: 'field', field: e.target.value })}
                      className={`${cls} bg-white`}
                    >
                      <option value="">{t('Choisir un champ…', 'Choose a field…')}</option>
                      {/* 🔴 Le compteur, et pas seulement le libellé. Le 2026-08-25, deux champs voisins
                          (« Email » rempli, « Mail » vide) étaient présentés à l'identique : le bloc a été
                          branché sur le vide, et aucun mail n'est parti. Le nombre de fiches concernées est
                          ce qui distingue les deux d'un coup d'œil. */}
                      {recipientFields.map((f) => (
                        <option key={f.key} value={f.key}>
                          {f.label}{usageChamps ? ` (${usageChamps.parChamp[f.key] ?? 0}/${usageChamps.total} ${t('fiches', 'records')})` : ''}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      data-testid={`email-recipient-value-${i}`}
                      type="email"
                      value={r.value ?? ''}
                      onChange={(e) => majLigne(i, { kind: 'literal', value: e.target.value })}
                      className={cls}
                      placeholder={t('destinataire@exemple.fr', 'recipient@example.com')}
                    />
                  )}
                  {i === 0 && destinataires.length > 1 && (
                    <p className="mt-1 text-[11px] text-ink-400">{t('En « À ». Les suivants sont en copie cachée.', 'In “To”. The others are blind-copied.')}</p>
                  )}
                </div>
              ))}
              {destinataires.length < MAX_DESTINATAIRES_EMAIL && (
                <button
                  type="button"
                  data-testid="email-recipient-add"
                  onClick={() => patchDest([...destinataires, { kind: 'literal', value: '' }])}
                  className="text-xs text-brand-600 hover:underline"
                >
                  {t('+ destinataire', '+ recipient')}
                </button>
              )}
              <p className="mt-1 text-[11px] text-ink-400">
                {t(
                  'En mode variable, le champ choisi doit contenir une adresse email valide sur la fiche du contact (ex. le champ « Email »). Une adresse qui ne résout à rien est ignorée, les autres partent quand même.',
                  'In variable mode, the chosen field must hold a valid email address on the contact (e.g. the “Email” field). An address that resolves to nothing is skipped, the others are still sent.',
                )}
              </p>
            </div>
            <p className="text-[11px] leading-snug text-ink-400">
              {t(
                "L'envoi est best-effort : un échec (boîte injoignable, adresse invalide…) est journalisé mais n'arrête jamais le parcours du contact.",
                'The send is best-effort: a failure (unreachable mailbox, invalid address…) is logged but never stops the contact’s journey.',
              )}
            </p>
          </div>
        );
      })()}
    </div>
  );
}
