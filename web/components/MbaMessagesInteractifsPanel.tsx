'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useLocale, useT } from '@/lib/i18n';
import { inputCls } from '@/lib/ui';
import { MbaNotice } from './MbaNotice';
import { Bouton } from '@/components/Bouton';
import { BoutonConfirme } from '@/components/Confirmation';
import { Icone } from '@/components/Icone';
import { Squelette } from '@/components/Squelette';
import { Toggle } from '@/components/Toggle';
import { ChoixMessageInteractif } from '@/components/mba-messages/ChoixMessageInteractif';
import {
  createMbaMessageInteractif, deleteMbaMessageInteractif, listMbaMessagesInteractifs, updateMbaMessageInteractif,
  type MbaMessageInteractif, type MbaStatus,
} from '@/lib/api-mba';
import { listFlows } from '@/lib/api/scenarios';
import { isValidSkillTitle, slugSkillTitle, slugSkillTitleFrappe, SKILL_TITLE_MAX } from '@/lib/mba-skills';
import {
  CONSIGNE_MESSAGE_MAX, TYPES, composerConsigne, octets, separerConsigne, type TypeMessageInteractif,
} from '@/lib/messages-interactifs';

/**
 * LES MESSAGES INTERACTIFS DE L'AGENT DE META (spec `docs/superpowers/specs/2026-10-07-messages-interactifs-design.md`).
 *
 * L'agent compose lui-même un composant WhatsApp (boutons, liste, lien, formulaire...) quand la situation décrite se
 * présente, et GARDE la conversation : c'est ce qui le distingue des outils maison « Envoyer un bloc » et « Lancer un
 * scénario », qui la passent à un scénario. L'ajout se fait comme l'ajout d'un outil : une grille, puis une fiche.
 */

type Formulaires = Array<{ id: string; nom: string }> | null | 'erreur';
type Mode =
  | { vue: 'liste' }
  | { vue: 'choix' }
  | { vue: 'fiche'; type: TypeMessageInteractif; message: MbaMessageInteractif | null };

export function MbaMessagesInteractifsPanel({ tenantId, phoneNumberId, status, isAdmin }: {
  tenantId: string;
  phoneNumberId: string;
  status: MbaStatus | null;
  isAdmin: boolean;
}) {
  const t = useT();
  const [messages, setMessages] = useState<MbaMessageInteractif[] | null>(null);
  const [lectureRatee, setLectureRatee] = useState<string | null>(null);
  const [formulaires, setFormulaires] = useState<Formulaires>(null);
  const [mode, setMode] = useState<Mode>({ vue: 'liste' });
  const [erreur, setErreur] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const chargerMessages = useCallback(async (): Promise<void> => {
    try {
      const r = await listMbaMessagesInteractifs(tenantId, phoneNumberId);
      setMessages(Array.isArray(r.messages) ? r.messages : []);
      setLectureRatee(null);
    } catch (e) {
      setLectureRatee(e instanceof Error ? e.message : String(e));
    }
  }, [tenantId, phoneNumberId]);

  const chargerFormulaires = useCallback(async (): Promise<void> => {
    setFormulaires(null);
    try {
      const r = await listFlows(tenantId);
      setFormulaires((r.flows ?? []).filter((f) => f.status === 'PUBLISHED').map((f) => ({ id: f.id, nom: f.name })));
    } catch {
      setFormulaires('erreur');
    }
  }, [tenantId]);

  useEffect(() => { void chargerMessages(); void chargerFormulaires(); }, [chargerMessages, chargerFormulaires]);

  async function agir(action: () => Promise<unknown>): Promise<boolean> {
    setBusy(true);
    setErreur(null);
    try {
      await action();
      await chargerMessages();
      return true;
    } catch (e) {
      setErreur(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  // Comme les consignes : un message interactif s'écrit sur la configuration de l'agent, qui doit exister chez Meta.
  if (status !== null && !status.onboarded) {
    return (
      <MbaNotice kind="warning" testid="mba-messages-no-agent">
        {t(
          'Les messages interactifs attendent que Meta ait créé la configuration de votre agent. Les informations business, la FAQ, les fichiers et les sites sont déjà modifiables en attendant.',
          'Interactive messages wait for Meta to create your agent configuration. Business info, FAQ, files and websites can already be edited in the meantime.',
        )}
      </MbaNotice>
    );
  }

  const nombreFormulaires = formulaires === null || formulaires === 'erreur' ? formulaires : formulaires.length;

  return (
    <section data-testid="mba-messages" className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-ink-900">{t('Messages interactifs', 'Interactive messages')}</h2>
          <p className="mt-1 text-xs text-ink-500" data-testid="mba-messages-intro">
            {t(
              'L’agent de Meta envoie lui-même ce composant (boutons, liste, lien, formulaire…) quand la situation que vous décrivez se présente, et il garde la conversation. « Envoyer un bloc » et « Lancer un scénario », dans l’onglet Outils, la passent au contraire à l’un de vos scénarios.',
              'Meta’s agent sends this component itself (buttons, list, link, form…) when the situation you describe comes up, and it keeps the conversation. “Send a block” and “Start a scenario”, in the Tools tab, hand it over to one of your scenarios instead.',
            )}
          </p>
        </div>
        {isAdmin && mode.vue === 'liste' && (
          <Bouton type="button" data-testid="mba-messages-ajouter" onClick={() => setMode({ vue: 'choix' })}>
            <Icone nom="ajouter" />{t('Ajouter un message interactif', 'Add an interactive message')}
          </Bouton>
        )}
      </div>

      {erreur !== null && <MbaNotice kind="error" testid="mba-messages-erreur">{erreur}</MbaNotice>}

      {mode.vue === 'choix' && (
        <ChoixMessageInteractif
          formulairesPublies={nombreFormulaires}
          onRelireFormulaires={() => { void chargerFormulaires(); }}
          onAnnuler={() => setMode({ vue: 'liste' })}
          onChoisir={(type) => setMode({ vue: 'fiche', type, message: null })}
        />
      )}

      {mode.vue === 'fiche' && (
        // 🔴 LA CLÉ N'EST PAS DÉCORATIVE (relecture de la livraison B) : sans elle, React réutilise la fiche ouverte et
        // ses champs pour un autre message, et « Enregistrer » écrit le texte de l'un dans l'autre, sans trace.
        <Fiche
          key={mode.message?.id ?? `nouveau-${mode.type}`}
          type={mode.type}
          titresPris={(messages ?? []).map((m) => m.titre)}
          message={mode.message}
          formulaires={Array.isArray(formulaires) ? formulaires : []}
          busy={busy}
          onAnnuler={() => { setErreur(null); setMode({ vue: 'liste' }); }}
          onEnregistrer={async (corps) => {
            const fait = await agir(() => (mode.message === null
              ? createMbaMessageInteractif(tenantId, phoneNumberId, { type: mode.type, ...corps })
              : updateMbaMessageInteractif(tenantId, phoneNumberId, mode.message.id, { titre: corps.titre, consigne: corps.consigne })));
            if (fait) setMode({ vue: 'liste' });
          }}
        />
      )}

      {lectureRatee !== null && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-danger" data-testid="mba-messages-lecture-ratee">
          <span>{t('Lecture impossible chez Meta : ', 'Could not read from Meta: ')}{lectureRatee}</span>
          <Bouton variante="secondaire" taille="petite" type="button" data-testid="mba-messages-relire" onClick={() => { void chargerMessages(); }}>
            {t('Relire', 'Retry')}
          </Bouton>
        </div>
      )}

      {messages === null && lectureRatee === null && <Squelette forme="lignes" />}

      {messages !== null && (
        <ul className="divide-y divide-ink-100 rounded-carte border border-ink-200 bg-white" data-testid="mba-messages-liste">
          {messages.map((m) => {
            const x = TYPES[m.type];
            const verrou = busy || mode.vue !== 'liste';
            return (
              <li key={m.id} data-testid={`mba-message-${m.id}`} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <span className="flex items-center gap-1.5 text-xs text-ink-500" data-testid={`mba-message-type-${m.id}`}>
                    <Icone nom={x.icone} taille="petite" className="text-ink-500" />{t(x.nom[0], x.nom[1])}
                  </span>
                  <p className="mt-0.5 truncate font-mono text-sm font-medium text-ink-900">{m.titre}</p>
                  <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap text-xs text-ink-500">{m.consigne}</p>
                </div>
                {isAdmin && (
                  <div className="flex shrink-0 items-center gap-3">
                    <Toggle
                      checked={m.actif}
                      disabled={verrou}
                      testid={`mba-message-actif-${m.id}`}
                      libelle={t(`Message « ${m.titre} » actif`, `Message “${m.titre}” active`)}
                      title={m.actif ? t('Actif : l’agent peut l’envoyer', 'Active: the agent may send it') : t('Inactif : l’agent ne l’envoie pas', 'Inactive: the agent does not send it')}
                      onChange={() => { void agir(() => updateMbaMessageInteractif(tenantId, phoneNumberId, m.id, { actif: !m.actif })); }}
                    />
                    <button type="button" disabled={verrou}
                      className="text-xs font-medium text-brand-600 hover:text-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
                      data-testid={`mba-message-modifier-${m.id}`}
                      onClick={() => setMode({ vue: 'fiche', type: m.type, message: m })}>
                      {t('Modifier', 'Edit')}
                    </button>
                    <BoutonConfirme
                      className="text-xs font-medium text-danger-700 hover:text-danger-800"
                      disabled={verrou}
                      testId={`mba-message-supprimer-${m.id}`}
                      question={t(`Supprimer « ${m.titre} » ?`, `Delete “${m.titre}”?`)}
                      libelleConfirmer={t('Supprimer', 'Delete')}
                      onConfirme={() => { void agir(() => deleteMbaMessageInteractif(tenantId, phoneNumberId, m.id)); }}
                    >
                      {t('Supprimer', 'Delete')}
                    </BoutonConfirme>
                  </div>
                )}
              </li>
            );
          })}
          {messages.length === 0 && (
            <li className="px-4 py-3 text-sm text-ink-500" data-testid="mba-messages-vide">
              {t('Aucun message interactif pour l’instant.', 'No interactive message yet.')}
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

/** La fiche d'un message : « Quand l'envoyer » d'abord, puis le contenu, le titre et, pour un formulaire, lequel. */
function Fiche({ type, message, titresPris, formulaires, busy, onAnnuler, onEnregistrer }: {
  type: TypeMessageInteractif;
  message: MbaMessageInteractif | null;
  titresPris: readonly string[];
  formulaires: Array<{ id: string; nom: string }>;
  busy: boolean;
  onAnnuler: () => void;
  onEnregistrer: (corps: { titre: string; consigne: string; formulaireId?: string }) => Promise<void>;
}) {
  const t = useT();
  const { locale } = useLocale();
  const x = TYPES[type];
  const depart = message === null ? { quand: '', contenu: t(x.canevas[0], x.canevas[1]) } : separerConsigne(message.consigne);
  const [quand, setQuand] = useState(depart.quand);
  const [contenu, setContenu] = useState(depart.contenu);
  const [titre, setTitre] = useState(message?.titre ?? titreLibre(x.titre, titresPris));
  const [formulaireId, setFormulaireId] = useState<string>(message?.formulaireId ?? formulaires[0]?.id ?? '');

  // Comme une consigne : mis en forme pendant la frappe, et la forme DÉFINITIVE est celle qu'on valide et qu'on envoie.
  const titreEnvoye = slugSkillTitle(titre);
  const titreValide = isValidSkillTitle(titreEnvoye);
  const consigne = composerConsigne(quand, contenu, locale === 'en' ? 'en' : 'fr');
  const taille = octets(consigne);
  const consigneValide = quand.trim() !== '' && contenu.trim() !== '' && taille <= CONSIGNE_MESSAGE_MAX;
  const formulaireValide = type !== 'flow' || message !== null || formulaireId !== '';

  return (
    <section className="rounded-carte border border-ink-200 bg-white p-4" data-testid="mba-message-fiche">
      <p className="flex items-center gap-2 text-sm font-semibold text-ink-900" data-testid="mba-message-fiche-type">
        <Icone nom={x.icone} className="text-ink-400" />{t(x.nom[0], x.nom[1])}
      </p>
      {message !== null && (
        <p className="mt-1 text-xs text-ink-500" data-testid="mba-message-fiche-type-fige">
          {t('Pour changer de type ou de formulaire, supprimez ce message et recréez-le.', 'To change the type or the form, delete this message and create it again.')}
        </p>
      )}

      <label className="mt-4 block">
        <span className="text-sm font-medium text-ink-900">{t('Quand l’envoyer', 'When to send it')}</span>
        <span className="mt-0.5 block text-xs text-ink-500">
          {t('La situation, en une phrase. Ex. « quand le client demande à réserver ».', 'The situation, in one sentence. E.g. “when the customer asks to book”.')}
        </span>
        <input className={`${inputCls} mt-1.5`} data-testid="mba-message-quand" value={quand} onChange={(e) => setQuand(e.target.value)} />
        {quand.trim() === '' && (
          <span className="mt-1 block text-xs text-alerte-800" data-testid="mba-message-quand-invite">
            {t('Précisez quand l’envoyer : sans cette phrase, l’agent ne sait pas dans quelle situation l’utiliser.',
              'Say when to send it: without this sentence, the agent does not know in which situation to use it.')}
          </span>
        )}
      </label>

      <label className="mt-4 block">
        <span className="text-sm font-medium text-ink-900">{t('Ce que contient le message', 'What the message contains')}</span>
        <span className="mt-0.5 block text-xs text-ink-500">
          {t('Complétez chaque ligne avec un contenu fixe.', 'Fill in each line with fixed content.')}
        </span>
        {/* Mesuré le 2026-10-08 : une liste remplie par la réponse d'un outil MCP n'est jamais partie (quatre essais,
            trois consignes), et l'échec a gâché les réponses suivantes de la conversation. */}
        <span className="mt-1 block text-xs text-alerte-800" data-testid="mba-message-contenu-avertissement">
          {t('Évitez un contenu rempli par la réponse d’un outil : essayé sur une liste remplie par un outil MCP, l’envoi a échoué à chaque fois, et l’agent a répondu « Je ne peux pas vous aider avec cela », parfois aussi aux messages suivants.',
            'Avoid content filled from a tool’s answer: tried on a list filled by an MCP tool, sending failed every time, and the agent replied “I can’t help you with that”, sometimes for the following messages too.')}
        </span>
        <textarea className={`${inputCls} mt-1.5 font-mono text-xs`} rows={7} data-testid="mba-message-contenu" value={contenu}
          onChange={(e) => setContenu(e.target.value)} />
        <span className={`mt-1 block text-right text-xs ${taille > CONSIGNE_MESSAGE_MAX ? 'text-danger' : 'text-ink-500'}`} data-testid="mba-message-octets">
          {taille.toLocaleString(locale)} / {CONSIGNE_MESSAGE_MAX.toLocaleString(locale)} {t('octets (un caractère accentué en compte deux)', 'bytes (an accented character counts as two)')}
        </span>
      </label>

      {type === 'flow' && message !== null && (
        <p className="mt-2 text-xs text-ink-500" data-testid="mba-message-formulaire-fige">
          {t('Formulaire : ', 'Form: ')}{formulaires.find((f) => f.id === message.formulaireId)?.nom ?? message.formulaireId ?? t('inconnu', 'unknown')}
        </p>
      )}

      {type === 'flow' && message === null && (
        <label className="mt-4 block">
          <span className="text-sm font-medium text-ink-900">{t('Le formulaire', 'The form')}</span>
          {formulaires.length === 0 ? (
            <Link href="/flows" className="mt-1 block text-xs text-brand-600 underline" data-testid="mba-message-formulaire-lien">
              {t('Aucun formulaire publié : Contenu > Formulaires', 'No published form: Content > Forms')}
            </Link>
          ) : (
            <select className={`${inputCls} mt-1.5`} data-testid="mba-message-formulaire" value={formulaireId} onChange={(e) => setFormulaireId(e.target.value)}>
              {formulaires.map((f) => <option key={f.id} value={f.id}>{f.nom}</option>)}
            </select>
          )}
        </label>
      )}

      <label className="mt-4 block">
        <span className="text-sm font-medium text-ink-900">{t('Nom', 'Name')}</span>
        <span className="mt-0.5 block text-xs text-ink-500">
          {t('En minuscules, avec des tirets. Il est mis en forme pendant la saisie.', 'Lowercase with dashes. It is formatted as you type.')}
        </span>
        <input className={`${inputCls} mt-1.5 font-mono`} maxLength={SKILL_TITLE_MAX} data-testid="mba-message-titre" value={titre}
          onChange={(e) => setTitre(slugSkillTitleFrappe(e.target.value))} onBlur={() => setTitre(titreEnvoye)} />
        {titreEnvoye !== '' && !titreValide && (
          <span className="mt-1 block text-xs text-danger-600" data-testid="mba-message-titre-erreur">
            {t('Nom invalide : minuscules, chiffres et tirets uniquement.', 'Invalid name: lowercase, digits and dashes only.')}
          </span>
        )}
      </label>

      <div className="mt-5 flex justify-end gap-2">
        <Bouton variante="secondaire" type="button" data-testid="mba-message-annuler" onClick={onAnnuler}>{t('Annuler', 'Cancel')}</Bouton>
        <Bouton
          type="button"
          data-testid="mba-message-enregistrer"
          disabled={busy || !titreValide || !consigneValide || !formulaireValide}
          onClick={() => {
            void onEnregistrer({
              titre: titreEnvoye,
              consigne,
              ...(type === 'flow' && message === null ? { formulaireId } : {}),
            });
          }}
        >
          {t('Enregistrer', 'Save')}
        </Bouton>
      </div>
    </section>
  );
}

/** Le titre de départ, suffixé s'il est déjà pris : deux messages au même nom rendraient la liste et la suppression ambiguës. */
function titreLibre(base: string, pris: readonly string[]): string {
  if (!pris.includes(base)) return base;
  for (let i = 2; ; i += 1) if (!pris.includes(`${base}-${i}`)) return `${base}-${i}`;
}
