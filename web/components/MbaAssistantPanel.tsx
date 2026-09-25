'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '@/lib/i18n';
import { cardCls, inputCls } from '@/lib/ui';
import { MbaNotice } from './MbaNotice';
import {
  appliquerAssistantMba, effacerFilAssistantMba, lireFilAssistantMba, parlerAssistantMba,
  type OperationAssistantMba, type ResultatApplicationMba, type TourAssistantMba,
} from '@/lib/api-mba';
import { Bouton } from '@/components/Bouton';
import { Icone } from '@/components/Icone';
import { useConfirmation } from '@/components/Confirmation';
import { Squelette } from '@/components/Squelette';

/**
 * L'ASSISTANT DU META BUSINESS AGENT : on lui parle, il propose, on accepte.
 *
 * 🔴 L'ACCEPTATION DU DIFF SUFFIT, PAS DE SECONDE CONFIRMATION (décision de Julien du 2026-09-14). Une
 * confirmation qui suit une acceptation n'ajoute pas de sécurité, elle apprend à cliquer sans lire. Ce qui
 * protège, c'est que le diff NOMME ce qu'il va faire, une ligne par opération.
 *
 * 🔴 UN ONGLET PARMI LES AUTRES, pas un panneau latéral ni la porte d'entrée : on sait toujours où le
 * retrouver, et les repères de ceux qui utilisent déjà l'écran ne bougent pas.
 *
 * ⚠️ IL N'EST JAMAIS LE SEUL CHEMIN. Tout ce qu'il fait reste faisable dans les autres onglets, à la main.
 * C'est la leçon du « Create » d'OpenAI : le jour où cet onglet a disparu, des GPT sont devenus non
 * modifiables du jour au lendemain.
 */
/** Les exemples proposés quand le fil est vide. Trois gestes que l'assistant sait vraiment faire. */
const EXEMPLES: readonly (readonly [string, string])[] = [
  ['Ajoute mes horaires du samedi', 'Add my Saturday hours'],
  ['Ajoute une question fréquente sur les délais de livraison', 'Add an FAQ about delivery times'],
  ['Dis-lui de ne jamais promettre de remise', 'Tell it to never promise a discount'],
];

export function MbaAssistantPanel({ tenantId, etapesRestantes = null }: {
  tenantId: string;
  /**
   * Combien d'étapes restent à finir, ou `null` si on ne le sait pas encore.
   *
   * ⚠️ TOUTES LES ÉTAPES `a_faire`, FACULTATIVES COMPRISES, exactement comme l'en-tête de l'écran. Ce
   * n'est pas un oubli : deux comptes différents sur le même écran se contredisent, et le lecteur ne
   * sait alors lequel croire. C'est pour ça que le libellé dit « à finir » et jamais « obligatoires ».
   *
   * 🔴 IL VIENT DE LA COMPLÉTION RÉELLE, IL NE S'INVENTE PAS. L'assistant d'un agent IA affiche « Entretien :
   * X points sur Y » parce qu'il MÈNE un entretien en neuf points ; celui-ci ne mène aucun entretien, il
   * exécute des demandes. Lui coller une barre de progression fabriquée aurait donné l'air d'un parcours
   * guidé sans en être un. Ce chiffre-ci est celui que l'en-tête de l'écran affiche déjà, donc les deux ne
   * peuvent pas se contredire.
   *
   * ⚠️ `null` N'EST PAS ZÉRO : la complétion peut n'avoir pas encore été lue, ou avoir échoué. Zéro veut dire
   * « tout est réglé », ce qui est une affirmation.
   */
  etapesRestantes?: number | null;
}) {
  const t = useT();
  const confirmer = useConfirmation();
  const [messages, setMessages] = useState<TourAssistantMba[]>([]);
  const [accueil, setAccueil] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [saisie, setSaisie] = useState('');
  const [diff, setDiff] = useState<OperationAssistantMba[]>([]);
  const [resultat, setResultat] = useState<ResultatApplicationMba | null>(null);
  const [chargement, setChargement] = useState(true);
  const [busy, setBusy] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [budgetEpuise, setBudgetEpuise] = useState(false);
  const finDuFil = useRef<HTMLDivElement>(null);

  const charger = useCallback(async () => {
    setChargement(true);
    try {
      const f = await lireFilAssistantMba(tenantId);
      setMessages(f.messages);
      setAccueil(f.accueil);
      setTotal(f.total);
      setBudgetEpuise(f.budgetEpuise);
    } catch (e) {
      setErreur(e instanceof Error ? e.message : t('Assistant indisponible', 'Assistant unavailable'));
    } finally {
      setChargement(false);
    }
  }, [tenantId, t]);

  useEffect(() => { void charger(); }, [charger]);
  // ⚠️ On suit la fin du fil à chaque message : sans ça, la réponse arrive hors de l'écran et l'assistant
  // a l'air muet.
  useEffect(() => { finDuFil.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages.length, diff.length]);

  async function envoyer() {
    const texte = saisie.trim();
    if (texte === '' || busy) return;
    setBusy(true);
    setErreur(null);
    setResultat(null);
    // Optimiste : le message de l'utilisateur apparaît tout de suite, sinon l'écran a l'air figé.
    setMessages((m) => [...m, { role: 'user', content: texte }]);
    setSaisie('');
    try {
      const r = await parlerAssistantMba(tenantId, texte);
      setMessages((m) => [...m, { role: 'assistant', content: r.message }]);
      setDiff(r.operations);
      if (r.budgetEpuise) setBudgetEpuise(true);
    } catch (e) {
      setErreur(e instanceof Error ? e.message : t('Réponse impossible', 'Unable to answer'));
    } finally {
      setBusy(false);
    }
  }

  /**
   * DÉPOSER UN DOCUMENT.
   *
   * 🔴 LE DÉPÔT N'ENVOIE RIEN CHEZ META : il ajoute une ligne au diff, comme une proposition de l'assistant.
   * C'est ce qui fait qu'aucun geste de cette conversation n'agit avant d'avoir été relu.
   *
   * ⚠️ LE NOM GARDE SON EXTENSION, contrairement à la pièce jointe de l'agent IA qui la RETIRE. Là-bas le nom
   * devient le titre d'une fiche ; ici c'est le `file_name` que Meta garde, et il doit correspondre au
   * contenu, sinon l'ingestion échoue en silence.
   */
  async function appliquer() {
    if (diff.length === 0 || busy) return;
    setBusy(true);
    setErreur(null);
    try {
      const r = await appliquerAssistantMba(tenantId, diff);
      setResultat(r);
      // 🔴 LE DIFF DISPARAÎT MÊME EN CAS D'ÉCHEC PARTIEL : le reproposer tel quel ferait réappliquer ce qui
      // est déjà passé. C'est l'assistant qui repropose, à partir de l'état relu.
      setDiff([]);
    } catch (e) {
      setErreur(e instanceof Error ? e.message : t('Application impossible', 'Unable to apply'));
    } finally {
      setBusy(false);
    }
  }

  async function repartir() {
    if (!(await confirmer({ titre: t('Effacer la conversation', 'Clear the conversation'), message: t('Effacer cette conversation ? Rien de ce qui a déjà été appliqué ne sera annulé.',
      'Clear this conversation? Nothing already applied will be undone.'), confirmer: t('Effacer', 'Clear') }))) return;
    await effacerFilAssistantMba(tenantId);
    setMessages([]); setDiff([]); setResultat(null);
    await charger();
  }

  if (chargement) return <Squelette forme="carte" />;

  return (
    <div className={cardCls}>
      {/*
        🔴 UN EN-TÊTE DE CONVERSATION, PAS UN TITRE DE SECTION (Julien, 2026-09-24 : « fais en sorte que ça
        ressemble vraiment à un bot d'aide à la construction ET à la mise à jour »). L'écart avec l'assistant
        d'un agent IA n'était pas une question de fonction, les deux proposent un diff qu'on accepte : c'était
        que l'un a l'air d'une messagerie et l'autre d'un formulaire. Le cadre, l'icône et la ligne d'état
        sont ce qui fait la différence, et ils ne changent rien à ce que l'assistant SAIT faire.
      */}
      <div className="flex items-start justify-between gap-3 border-b border-ink-100 pb-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-600">
            <Icone nom="message" />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-ink-900">{t('Assistant de configuration', 'Setup assistant')}</h3>
            {/* 🔴 LE CHIFFRE VIENT DE LA COMPLÉTION, ET IL DIT LE MÊME QUE L'EN-TÊTE DE L'ÉCRAN. `null` ne
                rend rien du tout plutôt qu'un « 0 étape » que personne n'a mesuré. */}
            <p className="mt-0.5 text-xs text-ink-500" data-testid="mba-assistant-etat">
              {etapesRestantes === null
                ? t('Dites-lui ce que vous voulez régler ou changer. Il propose, vous acceptez.',
                  'Tell it what to set up or change. It proposes, you accept.')
                : etapesRestantes === 0
                  ? t('Tout est réglé. Dites-lui ce que vous voulez changer.', 'Everything is set. Tell it what you want to change.')
                  /*
                     🔴 PAS LE MOT « OBLIGATOIRES », ET C'EST UN CORRECTIF (relecture à froid du 2026-09-24).
                     Ce compte est celui de l'en-tête, donc il inclut les étapes FACULTATIVES qui restent à
                     faire (`fichiers` et `sites` sont `requise: false` dans `src/mba/completion.ts`). Un
                     espace dont tout l'obligatoire est réglé, sans fichier de connaissance ni site déclaré,
                     lisait « il reste 2 étapes obligatoires » alors qu'il n'en restait aucune.
                     ⚠️ ET LE CORRECTIF N'EST PAS DE FILTRER SUR `requise`, C'EST DE RETIRER LE MOT. Filtrer
                     ferait diverger ce chiffre de celui de l'en-tête, donc DEUX comptes différents sur le
                     même écran, ce qui est pire que le mot faux. Le même compte, le même registre que
                     l'en-tête (« n étapes à finir »), et la contradiction ne peut pas exister.
                  */
                  : t(`Il reste ${etapesRestantes} étape(s) à finir. Dites-lui de s'en occuper, ou réglez-les dans les onglets.`,
                    `${etapesRestantes} step(s) left to finish. Ask it to handle them, or do it in the tabs.`)}
            </p>
          </div>
        </div>
        {messages.length > 0 && (
          <button onClick={() => { void repartir(); }} className="shrink-0 text-xs text-ink-500 hover:text-ink-900">
            {t('Repartir de zéro', 'Start over')}
          </button>
        )}
      </div>

      {erreur && <MbaNotice kind="error">{erreur}</MbaNotice>}

      {/* 🔴 LE PLAFOND SE DIT, ET IL DIT AUSSI QUE LES ONGLETS RESTENT : une limite volontaire qu'on
          présenterait comme une panne se retournerait contre nous le jour où ça se sait. */}
      {budgetEpuise && (
        <MbaNotice kind="warning">
          {t('L’assistant a atteint sa limite pour ce mois-ci. Tous les onglets restent utilisables.',
            'The assistant reached its limit for this month. Every tab remains usable.')}
        </MbaNotice>
      )}

      {/* ⚠️ Le total est dit quand il dépasse ce qui est affiché : sans ça, l'écran laisserait croire que le
          reste de la conversation n'existe plus. */}
      {total > messages.length && (
        <p className="mt-3 text-xs text-ink-500">
          {t(`${total} messages au total, les ${messages.length} derniers sont affichés.`,
            `${total} messages in total, showing the last ${messages.length}.`)}
        </p>
      )}

      {/*
        🔴 UNE HAUTEUR FIXE ET UN FOND, COMME L'ASSISTANT D'UN AGENT IA. Un `max-h` laisse la zone grandir
        avec la conversation : le champ de saisie descend a chaque echange, et l'ecran n'a jamais l'air d'une
        messagerie. La hauteur fixe est ce qui fait qu'on reconnait une conversation avant de lire un mot.
      */}
      <div className="mt-4 h-[420px] space-y-3 overflow-y-auto rounded-carte bg-ink-50/40 p-3" data-testid="mba-assistant-fil">
        {messages.length === 0 && accueil && <Bulle role="assistant">{accueil}</Bulle>}
        {/*
          🔴 L'ETAT VIDE PROPOSE, IL NE SE CONTENTE PAS D'ATTENDRE. Un champ vide devant un bot ne dit pas ce
          qu'on a le droit de lui demander, et le premier reflexe est de ne rien ecrire. Les trois exemples
          sont des gestes que l'assistant sait vraiment faire : les inventer serait pire que ne rien proposer.
          ⚠️ Ils REMPLISSENT le champ, ils n'envoient pas : on relit avant que ca parte au modele, et ca reste
          modifiable, ce qui est le but d'un exemple.
        */}
        {messages.length === 0 && (
          <div className="flex flex-wrap gap-2 pt-1" data-testid="mba-assistant-exemples">
            {EXEMPLES.map(([fr, en]) => (
              <button
                key={fr}
                type="button"
                disabled={busy || budgetEpuise}
                onClick={() => setSaisie(t(fr, en))}
                className="rounded-full border border-ink-200 bg-white px-3 py-1 text-xs text-ink-500 hover:border-brand-300 hover:text-brand-700 disabled:opacity-50"
              >
                {t(fr, en)}
              </button>
            ))}
          </div>
        )}
        {messages.map((m, i) => (
          // eslint-disable-next-line react/no-array-index-key
          <Bulle key={i} role={m.role}>{m.content}</Bulle>
        ))}
        {/*
          ⚠️ L'INDICATEUR NE S'AFFICHE QUE QUAND C'EST A L'ASSISTANT DE PARLER. `busy` couvre aussi
          l'application d'un diff, qui n'appelle aucun modele : trois points qui rebondissent a ce moment-la
          feraient croire qu'il reflechit alors qu'il ecrit chez Meta.
        */}
        {busy && messages.length > 0 && messages[messages.length - 1]!.role === 'user' && (
          <div className="flex justify-start" data-testid="mba-assistant-ecrit">
            <div className="flex gap-1 rounded-carte rounded-bl-none bg-white px-3.5 py-2.5">
              {[0, 150, 300].map((d) => (
                <span key={d} className="h-1.5 w-1.5 animate-bounce rounded-full bg-ink-300"
                  style={{ animationDelay: `${d}ms` }} />
              ))}
            </div>
          </div>
        )}
        <div ref={finDuFil} />
      </div>

      {diff.length > 0 && <Diff operations={diff} busy={busy} onAppliquer={() => { void appliquer(); }} />}
      {resultat && <Resultat resultat={resultat} />}

      {/*
        🔴 LE BOUTON « JOINDRE » EST PARTI (Julien, 2026-09-24). Il ne perdait aucune capacite : l'onglet
        Fichiers depose un document chez Meta par sa propre route, sans passer par le magasin en memoire de
        l'assistant. Ce qu'il coutait, c'etait la place : il occupait le coin gauche de la zone de saisie, la
        ou l'oeil cherche le champ, et il faisait ressembler la conversation a un formulaire d'envoi.
        ⚠️ CONSEQUENCE A ASSUMER, PAS A DECOUVRIR : la route `POST .../mba/assistant/piece-jointe` n'a plus
        aucun appelant cote ecran. Elle n'est pas OFFERTE et inerte, elle est simplement inutilisee ; la
        retirer est une decision a part, notee dans `todo.md`.
      */}
      <div className="mt-4 flex items-end gap-2">
        {/*
          🔴 UN `textarea`, PLUS UN `input`, ET CE N'EST PAS COSMETIQUE. Le code gerait deja Maj+Entree pour
          aller a la ligne, mais un `input` HTML ne peut PAS afficher deux lignes : la fonction existait et
          son effet etait invisible. Or on decrit ici ce qu'on veut changer, en plusieurs phrases parfois.
        */}
        <textarea
          className={`${inputCls} min-h-[42px] resize-y`}
          rows={2}
          data-testid="mba-assistant-saisie"
          value={saisie}
          disabled={busy || budgetEpuise}
          placeholder={t('Par exemple : ajoute mes horaires du samedi. Entrée pour envoyer, Maj+Entrée pour aller à la ligne.',
            'For example: add my Saturday hours. Enter to send, Shift+Enter for a new line.')}
          onChange={(e) => setSaisie(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void envoyer(); } }}
        />
        <Bouton enCours={busy}
          onClick={() => { void envoyer(); }}
          disabled={busy || budgetEpuise || saisie.trim() === ''}
          data-testid="mba-assistant-envoyer"
          className="shrink-0"
        >
          {busy ? t('…', '…') : t('Envoyer', 'Send')}
        </Bouton>
      </div>
    </div>
  );
}

function Bulle({ role, children }: { role: 'user' | 'assistant'; children: React.ReactNode }) {
  const moi = role === 'user';
  return (
    <div className={`flex ${moi ? 'justify-end' : 'justify-start'}`}>
      {/* ⚠️ LA QUEUE (`rounded-br-none` / `rounded-bl-none`) EST CE QUI FAIT LIRE « MESSAGERIE », et le fond
          blanc des bulles de l'assistant les detache du fond teinte du fil, qui est desormais gris. */}
      <div className={`max-w-[85%] whitespace-pre-wrap rounded-carte px-3.5 py-2 text-sm ${
        moi ? 'rounded-br-none bg-brand-600 text-white' : 'rounded-bl-none bg-white text-ink-900'
      }`}>
        {children}
      </div>
    </div>
  );
}

/**
 * LE DIFF : une ligne par opération, déjà rédigée par le serveur.
 *
 * 🔴 UN SEUL BOUTON, ET PAS DE SECONDE CONFIRMATION. Ce qui protège n'est pas un second clic, c'est que
 * chaque ligne NOMME ce qu'elle va faire. Une suppression est signalée à part, parce qu'elle est la seule
 * chose qu'on ne peut pas défaire : Meta n'a pas de corbeille.
 */
function Diff({ operations, busy, onAppliquer }: {
  operations: OperationAssistantMba[];
  busy: boolean;
  onAppliquer: () => void;
}) {
  const t = useT();
  return (
    <div className="mt-4 rounded-carte border border-ink-200 p-4" data-testid="mba-assistant-diff">
      <p className="text-sm font-medium text-ink-900">{t('Ce que je vais faire', 'What I will do')}</p>
      <ul className="mt-2 space-y-1.5">
        {operations.map((o, i) => {
          const suppression = o.type.endsWith('.supprimer');
          return (
            // eslint-disable-next-line react/no-array-index-key
            <li key={i} className={`text-sm ${suppression ? 'text-danger' : 'text-ink-900'}`}>
              {suppression ? '− ' : '+ '}{o.libelle}
              {suppression && (
                <span className="ml-1 text-xs text-ink-500">
                  {t('(définitif : Meta ne garde pas de copie)', '(permanent: Meta keeps no copy)')}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <Bouton
        onClick={onAppliquer}
        disabled={busy}
        data-testid="mba-assistant-appliquer"
        className="mt-3"
      >
        {t('Appliquer', 'Apply')}
      </Bouton>
    </div>
  );
}

/**
 * CE QUI S'EST PASSÉ : passé, échoué, non tenté.
 *
 * 🔴 LES TROIS LISTES SONT MONTRÉES TELLES QUELLES. Meta n'offre aucune transaction : quand une opération
 * échoue, les précédentes sont déjà passées. Afficher un simple « échec » ferait croire que rien n'a bougé.
 */
function Resultat({ resultat }: { resultat: ResultatApplicationMba }) {
  const t = useT();
  return (
    <div className="mt-4 rounded-carte border border-ink-200 p-4 text-sm" data-testid="mba-assistant-resultat">
      {resultat.passees.length > 0 && (
        <>
          <p className="font-medium text-ink-900">{t('Fait', 'Done')}</p>
          <ul className="mt-1 space-y-0.5 text-ink-500">
            {resultat.passees.map((l) => <li key={l} className="flex items-start gap-1.5"><Icone nom="valide" taille="petite" className="mt-0.5 text-succes-700" />{l}</li>)}
          </ul>
        </>
      )}
      {resultat.echec && (
        <div className="mt-3 rounded-controle bg-danger-50 px-3 py-2">
          <p className="font-medium text-danger-800">{t('Arrêté sur', 'Stopped at')} : {resultat.echec.libelle}</p>
          <p className="mt-0.5 text-danger-700">{resultat.echec.message}</p>
        </div>
      )}
      {resultat.nonTentees.length > 0 && (
        <>
          <p className="mt-3 font-medium text-ink-900">{t('Non tenté', 'Not attempted')}</p>
          <ul className="mt-1 space-y-0.5 text-ink-500">
            {resultat.nonTentees.map((l) => <li key={l}>· {l}</li>)}
          </ul>
        </>
      )}
    </div>
  );
}
