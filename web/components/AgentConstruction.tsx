'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '@/lib/i18n';
import { cardCls, inputCls } from '@/lib/ui';
import { MbaNotice } from '@/components/MbaNotice';
import {
  parlerAuConstructeur, lireEntretien, effacerEntretien, joindrePiece, restreindreProposition,
  TAILLE_DOCUMENT_MAX, TAILLE_IMAGE_MAX,
  type Changement, type PropositionConstruction, type TourConstruction,
} from '@/lib/api-agent-setup';
import { Bouton } from '@/components/Bouton';
import { Icone } from '@/components/Icone';
import { useConfirmation } from '@/components/Confirmation';
import { Squelette } from '@/components/Squelette';

/**
 * L'onglet CONSTRUCTION : l'assistant qui règle l'agent en discutant.
 *
 * 🔴 IL PROPOSE, LE CLIENT CORRIGE, ET RIEN NE S'ÉCRIT SANS UN CLIC. C'est le seul point de cet écran qui ne
 * se négocie pas. Le client sait dire son métier et ce qu'on lui demande ; il ne sait pas dire son périmètre
 * de refus, ses règles d'arrêt, ni écrire la description d'un outil, et c'est là que se joue la qualité de
 * l'agent. L'assistant déduit donc plutôt qu'il n'interroge, et chaque proposition passe par un diff que le
 * client garde ou jette. L'inverse (écrire en silence, comme le fait le GPT Builder) ferait un réglage que
 * personne ne peut relire ni défaire.
 *
 * La conversation EST persistée côté serveur depuis le 2026-08-31 : on la rouvre là où on l'avait laissée, et
 * c'est le serveur qui conduit l'entretien (il choisit le point du tour et décide de ce qui est couvert).
 * Cet écran ne fait qu'envoyer un message et afficher ce qui revient. Tout ce que la conversation produit
 * atterrit dans les autres onglets, éditable champ par champ.
 */
export function AgentConstruction({ tenantId, agentId, onApplique }: {
  tenantId: string;
  agentId: string;
  /** Applique la proposition. Rendu par l'écran parent : c'est LUI qui porte le verrou de version. */
  onApplique: (p: PropositionConstruction) => Promise<void>;
}) {
  const t = useT();
  const confirmer = useConfirmation();
  const [tours, setTours] = useState<TourConstruction[]>([]);
  /**
   * QUI a écrit chaque tour, parallèle à `tours` (migration 0147). Le fil est PARTAGÉ entre les admins d'un
   * espace : « qui a demandé ça ? » doit avoir une réponse, et c'est la seule qui existe.
   */
  const [auteurs, setAuteurs] = useState<Array<string | null>>([]);
  const [saisie, setSaisie] = useState('');
  const [busy, setBusy] = useState(false);
  const [charge, setCharge] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [changements, setChangements] = useState<Changement[] | null>(null);
  const [proposition, setProposition] = useState<PropositionConstruction | null>(null);
  const [resteACouvrir, setResteACouvrir] = useState(0);
  const [total, setTotal] = useState(0);
  // Chaque réponse ouvre un nouveau lot : ce numéro sert de clé au diff, pour que les choix « garder / jeter »
  // du lot précédent ne survivent pas à une proposition qui ne porte plus les mêmes lignes.
  const [lot, setLot] = useState(0);
  const filRef = useRef<HTMLDivElement>(null);

  /** L'entretien déjà tenu. Sans cette relecture, changer d'onglet effacerait la conversation. */
  useEffect(() => {
    let vivant = true;
    void (async () => {
      try {
        const r = await lireEntretien(tenantId, agentId);
        if (!vivant) return;
        // Défensif sur la FORME : cette réponse traverse un proxy et un cache, et un corps inattendu ne doit
        // pas casser l'écran là où une page blanche suffit.
        setTours(Array.isArray(r?.messages) ? r.messages : []);
        setAuteurs(Array.isArray(r?.auteurs) ? r.auteurs : []);
        setResteACouvrir(r?.couverture?.manquants?.length ?? 0);
        setTotal(r?.couverture?.total ?? 0);
      } catch {
        // Un entretien illisible n'est pas une panne d'écran : on repart d'une page blanche, l'assistant
        // reposera ses questions. Bloquer ici priverait le client du seul chemin de réparation.
      } finally {
        if (vivant) setCharge(true);
      }
    })();
    return () => { vivant = false; };
  }, [tenantId, agentId]);

  // Le fil descend tout seul, comme dans n'importe quel tchat : sans ça, la réponse arrive HORS DE L'ÉCRAN et
  // on croit que rien ne s'est passé.
  useEffect(() => {
    filRef.current?.scrollTo({ top: filRef.current.scrollHeight, behavior: 'smooth' });
  }, [tours, busy]);

  const envoyer = useCallback(async (texte: string) => {
    const propre = texte.trim();
    if (propre === '' || busy) return;
    setTours((avant) => [...avant, { role: 'user', content: propre }]);
    // ⚠️ L'AUTEUR SUIT LE MESSAGE, sinon les deux tableaux se décalent et chaque tour affiche le nom du
    // précédent. `null` pour l'optimiste : le serveur rendra notre adresse à la relecture, et l'afficher tout
    // de suite sur la phrase qu'on vient de taper n'apprend rien.
    setAuteurs((avant) => [...avant, null]);
    setSaisie('');
    setBusy(true);
    setErreur(null);
    setChangements(null);
    setProposition(null);
    try {
      const r = await parlerAuConstructeur(tenantId, agentId, propre);
      setTours((avant) => [...avant, { role: 'assistant', content: r.message }]);
      setAuteurs((avant) => [...avant, null]);
      setProposition(r.proposition);
      setChangements(r.changements);
      setResteACouvrir(r.couverture?.manquants.length ?? 0);
      setTotal(r.couverture?.total ?? 0);
      setLot((n) => n + 1);
    } catch (err) {
      // Le message du client reste affiché : le serveur ne l'a pas enregistré (l'écriture n'a lieu qu'après
      // une réponse valide du modèle), donc le retirer de l'écran ferait croire qu'il est parti quelque part.
      setErreur(err instanceof Error ? err.message : t('L’assistant n’a pas répondu', 'The assistant did not answer'));
    } finally {
      setBusy(false);
    }
  }, [busy, tenantId, agentId, t]);

  /**
   * Joint un document ou une image. Le serveur en tire du texte et l'écrit en fiches de connaissance ; on
   * enchaîne ensuite un message ORDINAIRE pour que l'assistant en tienne compte, plutôt que d'ajouter un
   * chemin spécial dans la boucle de conversation.
   */
  async function joindre(fichier: File) {
    if (busy) return;
    const image = fichier.type.startsWith('image/');
    const plafond = image ? TAILLE_IMAGE_MAX : TAILLE_DOCUMENT_MAX;
    // Contrôle LOCAL du poids, en plus de celui du serveur : téléverser 30 Mo pour se faire refuser après
    // l'attente est une mauvaise expérience, et le corps est bloqué en amont par la limite de la route.
    if (fichier.size > plafond) {
      setErreur(t(
        `« ${fichier.name} » est trop lourd (${Math.round(plafond / 1024 / 1024)} Mo maximum).`,
        `“${fichier.name}” is too large (${Math.round(plafond / 1024 / 1024)} MB maximum).`,
      ));
      return;
    }
    setBusy(true);
    setErreur(null);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const lecteur = new FileReader();
        lecteur.onerror = () => reject(new Error('lecture impossible'));
        lecteur.onload = () => resolve(String(lecteur.result));
        lecteur.readAsDataURL(fichier);
      });
      // Le nom du fichier SANS son extension : il devient le titre par défaut des fiches, et « guide.pdf »
      // ferait un titre qui parle de format plutôt que de contenu.
      const nom = fichier.name.replace(/\.[a-z0-9]{1,8}$/i, '').trim() || fichier.name;
      const r = await joindrePiece(tenantId, agentId, nom, dataUrl);
      setBusy(false);
      await envoyer(t(
        `J’ai joint « ${nom} » : ${r.fiches} fiche${r.fiches > 1 ? 's' : ''} ajoutée${r.fiches > 1 ? 's' : ''} à la base de connaissance (${r.titres.slice(0, 5).join(', ')}).`,
        `I attached “${nom}”: ${r.fiches} card${r.fiches > 1 ? 's' : ''} added to the knowledge base (${r.titres.slice(0, 5).join(', ')}).`,
      ));
    } catch (err) {
      setErreur(err instanceof Error ? err.message : t('Pièce jointe refusée', 'Attachment refused'));
      setBusy(false);
    }
  }

  async function recommencer() {
    if (busy) return;
    if (!(await confirmer({ titre: t('Recommencer l’entretien', 'Restart the interview'), message: t(
      'Recommencer l’entretien ? La conversation est effacée et l’assistant repose ses questions depuis le début. Ce qui a déjà été enregistré dans les autres onglets n’est pas touché.',
      'Restart the interview? The conversation is erased and the assistant asks its questions again from the start. What was already saved in the other tabs is untouched.',
    ), confirmer: t('Recommencer', 'Restart') }))) return;
    setBusy(true);
    setErreur(null);
    try {
      const r = await effacerEntretien(tenantId, agentId);
      setTours([]);
    setAuteurs([]);
      setChangements(null);
      setProposition(null);
      setResteACouvrir(r.couverture.manquants.length);
      setTotal(r.couverture.total);
    } catch (err) {
      setErreur(err instanceof Error ? err.message : t('Impossible de recommencer', 'Unable to restart'));
    } finally {
      setBusy(false);
    }
  }

  async function garder(gardees: Map<string, string>) {
    if (!proposition || !changements || busy) return;
    setBusy(true);
    setErreur(null);
    try {
      await onApplique(restreindreProposition(proposition, changements, gardees));
      setChangements(null);
      setProposition(null);
      setTours((t0) => [...t0, { role: 'assistant', content: t('C’est enregistré.', 'Saved.') }]);
    } catch (err) {
      setErreur(err instanceof Error ? err.message : t('Enregistrement impossible', 'Unable to save'));
    } finally {
      setBusy(false);
    }
  }

  const faits = total > 0 ? Math.max(0, total - resteACouvrir) : 0;

  return (
    <div className="flex flex-col gap-4">
      {erreur && <MbaNotice kind="error" testid="setup-erreur">{erreur}</MbaNotice>}

      {/* 🔴 UN FIL, PAS UN FORMULAIRE. Julien, 2026-08-31 : « on ne dirait pas vraiment un tchat, ça n'engage
          pas nécessairement à prendre la parole et discuter ». D'où l'en-tête qui nomme un interlocuteur, la
          hauteur FIXE qui fait exister une conversation (une pile qui pousse la page vers le bas n'en est pas
          une), la descente automatique, et une zone de saisie qui a l'air d'attendre une phrase. */}
      <div className={`${cardCls} flex flex-col gap-0 p-0 overflow-hidden`}>
        <div className="flex items-center justify-between gap-3 border-b border-ink-200 px-4 py-3">
          <div className="flex items-center gap-3">
            <span aria-hidden className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-50 text-brand-600"><Icone nom="message" /></span>
            <div>
              <p className="text-sm font-medium text-ink-900">{t('Assistant de construction', 'Setup assistant')}</p>
              <p className="text-xs text-ink-500">
                {resteACouvrir > 0 && total > 0
                  ? t(`Entretien : ${faits} point${faits > 1 ? 's' : ''} sur ${total}`, `Interview: ${faits} of ${total} points`)
                  : t('Il propose, vous gardez ou vous corrigez. Il n’écrit jamais tout seul.', 'It proposes, you keep or edit. It never writes on its own.')}
              </p>
            </div>
          </div>
          {tours.length > 0 && (
            <Bouton variante="secondaire" taille="petite"
              data-testid="setup-recommencer"
              disabled={busy}
              onClick={() => void recommencer()}
              className="shrink-0"
            >
              {t('Recommencer', 'Restart')}
            </Bouton>
          )}
        </div>

        <div ref={filRef} className="flex h-[420px] flex-col gap-3 overflow-y-auto bg-ink-50/40 px-4 py-4">
          {!charge && <Squelette forme="carte" />}

          {charge && tours.length === 0 && (
            <div data-testid="setup-vide" className="flex flex-col gap-3">
              {/* Une première bulle DE L'ASSISTANT, pas un mode d'emploi. C'est ce qui donne envie de répondre :
                  une page qui explique se lit, une phrase qui interroge se répond. */}
              <div className="max-w-[85%] self-start rounded-carte rounded-bl-none bg-white px-3.5 py-2.5 text-sm text-ink-900">
                {t(
                  'Réglons votre agent en discutant : une question à la fois, et je vous montre ce que j’ai compris avant d’écrire quoi que ce soit. Pour commencer, à quoi sert votre agent, au-delà de répondre ?',
                  'Let’s set up your agent by talking: one question at a time, and I show you what I understood before writing anything. To start, what is your agent for, beyond answering?',
                )}
              </div>
              <div className="flex flex-wrap gap-2 self-end">
                {[
                  t('Il répond aux questions sur nos séjours et prend des rendez-vous.', 'It answers questions about our stays and books appointments.'),
                  t('Il qualifie les demandes de devis, puis passe la main à un commercial.', 'It qualifies quote requests, then hands over to a salesperson.'),
                ].map((exemple) => (
                  <button
                    key={exemple}
                    data-testid="setup-exemple"
                    disabled={busy}
                    onClick={() => void envoyer(exemple)}
                    className="rounded-full border border-brand-300 bg-white px-3 py-1.5 text-left text-xs text-brand-700 hover:bg-brand-50 disabled:opacity-40"
                  >
                    {exemple}
                  </button>
                ))}
              </div>
            </div>
          )}

          {tours.map((tour, i) => (
            <div
              key={`${i}-${tour.content.slice(0, 24)}`}
              data-testid={`setup-tour-${tour.role}`}
              className={tour.role === 'user'
                ? 'max-w-[85%] self-end whitespace-pre-wrap rounded-carte rounded-br-none bg-brand-600 px-3.5 py-2.5 text-sm text-white'
                : 'max-w-[85%] self-start whitespace-pre-wrap rounded-carte rounded-bl-none bg-white px-3.5 py-2.5 text-sm text-ink-900'}
            >
              {tour.content}
              {/* 🔴 L'AUTEUR, SUR LES TOURS DU CLIENT ET SEULEMENT QUAND ON LE CONNAIT. Le fil est PARTAGE
                  entre les admins d'un espace : « qui a demande ca ? » doit avoir une reponse. Un tour sans
                  auteur (un message d'avant la migration 0147, ou un compte supprime) n'en affiche aucun :
                  inventer un nom serait faux. Les reponses de l'assistant n'en ont par definition pas. */}
              {tour.role === 'user' && auteurs[i] && (
                <span className="mt-1 block text-xs text-white/70">{auteurs[i]}</span>
              )}
            </div>
          ))}

          {busy && (
            <div className="flex max-w-[85%] items-center gap-1.5 self-start rounded-carte rounded-bl-none bg-white px-3.5 py-3">
              <span className="sr-only">{t('L’assistant réfléchit…', 'The assistant is thinking…')}</span>
              {[0, 150, 300].map((d) => (
                <span
                  key={d}
                  aria-hidden
                  style={{ animationDelay: `${d}ms` }}
                  className="h-1.5 w-1.5 animate-bounce rounded-full bg-ink-400"
                />
              ))}
            </div>
          )}
        </div>

        <div className="flex items-end gap-2 border-t border-ink-200 px-3 py-3">
          {/* Le TROMBONE. Un client arrive avec ses procédures déjà écrites ; les retaper fiche par fiche est
              exactement le travail qu'on lui promet d'éviter. Ce qu'il joint devient de la connaissance, et
              reste relisible dans l'onglet Base de connaissance. */}
          <label
            data-testid="setup-joindre"
            title={t('Joindre un document ou une image (il rejoint la base de connaissance)', 'Attach a document or image (it joins the knowledge base)')}
            className={`mb-0.5 grid h-[42px] w-[42px] shrink-0 cursor-pointer place-items-center rounded-controle border border-ink-300 text-base text-ink-500 hover:bg-ink-50 ${busy || !charge ? 'pointer-events-none opacity-40' : ''}`}
          >
            <Icone nom="piece" />
            <span className="sr-only">{t('Joindre un fichier', 'Attach a file')}</span>
            <input
              data-testid="setup-fichier"
              type="file"
              className="hidden"
              accept=".txt,.md,.csv,.pdf,.docx,text/plain,text/csv,text/markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/png,image/jpeg,image/gif,image/webp"
              disabled={busy || !charge}
              onChange={(e) => {
                const f = e.target.files?.[0];
                // Le champ est REMIS À ZÉRO : sans ça, rejoindre deux fois le même fichier ne déclencherait
                // aucun `change` la seconde fois, et le client croirait l'écran bloqué.
                e.target.value = '';
                if (f) void joindre(f);
              }}
            />
          </label>
          {/* Une zone de texte, pas un champ d'une ligne : on décrit son métier en trois phrases, pas en six
              mots. Entrée envoie, Maj+Entrée va à la ligne, comme partout ailleurs. */}
          <textarea
            data-testid="setup-saisie"
            rows={2}
            className={`${inputCls} max-h-40 min-h-[44px] flex-1 resize-y py-2.5`}
            value={saisie}
            disabled={busy || !charge}
            onChange={(e) => setSaisie(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void envoyer(saisie); }
            }}
            placeholder={t('Écrivez votre réponse… (Entrée pour envoyer, Maj+Entrée pour aller à la ligne)', 'Write your answer… (Enter to send, Shift+Enter for a new line)')}
          />
          <Bouton
            data-testid="setup-envoyer"
            disabled={busy || !charge || saisie.trim() === ''}
            onClick={() => void envoyer(saisie)}
            aria-label={t('Envoyer', 'Send')}
            className="mb-0.5 shrink-0"
          >
            {t('Envoyer', 'Send')}
          </Bouton>
        </div>
      </div>

      {/* 🔴 TANT QUE LE PÉRIMÈTRE N'EST PAS COUVERT, IL N'Y A RIEN À MONTRER, et il faut le DIRE. Le serveur
          retient le diff pendant l'entretien (`src/http/agent-setup.ts`) ; sans cette ligne, l'écran serait
          simplement muet et le client croirait que l'assistant ne comprend rien à ce qu'il raconte. */}
      {resteACouvrir > 0 && changements !== null && (
        <p data-testid="setup-entretien" className="text-sm text-ink-500">
          {t(
            `On fait d’abord le tour du sujet : encore ${resteACouvrir} point${resteACouvrir > 1 ? 's' : ''} à voir avant que je vous montre ce que j’ai compris.`,
            `Let’s cover the ground first: ${resteACouvrir} more point${resteACouvrir > 1 ? 's' : ''} before I show you what I understood.`,
          )}
        </p>
      )}
      {changements !== null && resteACouvrir === 0 && (
        <Diff key={lot} changements={changements} busy={busy} onGarder={garder} onJeter={() => { setChangements(null); setProposition(null); }} />
      )}
    </div>
  );
}

/**
 * Le diff. C'est LE garde-fou de cette surface : rien ne s'écrit sans qu'il ait été montré.
 *
 * 🔴 ET IL SE TRAITE RÈGLE PAR RÈGLE. Julien, 2026-08-28 : « il n'y a qu'un seul bouton Garder ou Jeter à la
 * fin, alors que potentiellement le mec ne veut en changer qu'une et le reste lui convient ». Un lot
 * indivisible force à tout refuser pour corriger une ligne, donc à relancer la conversation en espérant que le
 * modèle ne défasse pas au passage les cinq autres qui convenaient. Chaque ligne se garde, se corrige sur
 * place, ou se jette.
 *
 * ⚠️ Une ligne JETÉE n'est pas une ligne absente : voir `restreindreProposition`, elle réécrit la valeur
 * actuelle. Les deux textes d'un outil partent dans le même enregistrement, et omettre celui qu'on a jeté le
 * laisserait prendre la valeur proposée, c'est-à-dire exactement celle qu'on venait de refuser.
 *
 * ⚠️ La ligne des règles d'arrêt se garde ou se jette, mais ne se corrige pas ici : c'est un texte qui porte
 * PLUSIEURS règles, et le relire pour reconstruire la liste ferait dépendre un enregistrement d'un format que
 * le client peut casser en tapant. L'onglet Objectif a les bons champs pour ça.
 */
function Diff({ changements, busy, onGarder, onJeter }: {
  changements: Changement[];
  busy: boolean;
  onGarder: (gardees: Map<string, string>) => void;
  onJeter: () => void;
}) {
  const t = useT();
  // Tout est gardé au départ, avec le texte proposé : le geste courant est d'accepter, et le client ne doit
  // pas avoir à cocher six cases pour l'exprimer.
  const [gardees, setGardees] = useState<Map<string, string>>(
    () => new Map(changements.map((c) => [c.champ, c.apres])),
  );
  const editable = (champ: string) => champ !== 'fiche.sorties';

  if (changements.length === 0) {
    return (
      <p data-testid="setup-sans-changement" className="text-sm text-ink-500">
        {t('Rien à changer pour l’instant.', 'Nothing to change for now.')}
      </p>
    );
  }

  const corriger = (champ: string, texte: string) => setGardees((m) => new Map(m).set(champ, texte));
  const basculer = (champ: string, apres: string) => setGardees((m) => {
    const suite = new Map(m);
    if (suite.has(champ)) suite.delete(champ); else suite.set(champ, apres);
    return suite;
  });

  return (
    <div data-testid="setup-diff" className={`${cardCls} flex flex-col gap-3`}>
      <p className="text-sm font-medium text-ink-900">{t('Ce que ça changerait', 'What this would change')}</p>
      {changements.map((c) => {
        const garde = gardees.has(c.champ);
        return (
          <div
            key={c.champ}
            data-testid={`setup-diff-${c.champ}`}
            className={`flex flex-col gap-1 rounded-controle border px-3 py-2 ${garde ? 'border-ink-200' : 'border-ink-200 bg-ink-50 opacity-60'}`}
          >
            <div className="flex items-start justify-between gap-2">
              <p className="text-xs font-medium text-ink-900">{c.label}</p>
              <button
                data-testid={`setup-bascule-${c.champ}`}
                disabled={busy}
                aria-pressed={garde}
                onClick={() => basculer(c.champ, c.apres)}
                className={`shrink-0 rounded-controle border px-2 py-1 text-xs disabled:opacity-40 ${garde
                  ? 'border-brand-600 bg-brand-50 text-brand-700'
                  : 'border-ink-300 text-ink-500 hover:bg-white'}`}
              >
                {garde ? t('Gardée', 'Kept') : t('Jetée', 'Dropped')}
              </button>
            </div>
            {c.avant !== '' && (
              <p className="whitespace-pre-wrap text-xs text-ink-500 line-through">{c.avant}</p>
            )}
            {garde && editable(c.champ) ? (
              <textarea
                data-testid={`setup-texte-${c.champ}`}
                className={`${inputCls} min-h-[64px] text-sm`}
                disabled={busy}
                value={gardees.get(c.champ) ?? ''}
                onChange={(e) => corriger(c.champ, e.target.value)}
              />
            ) : (
              <p className="whitespace-pre-wrap text-sm text-ink-900">{garde ? gardees.get(c.champ) : c.apres}</p>
            )}
          </div>
        );
      })}
      <div className="flex flex-wrap items-center gap-2">
        <Bouton
          data-testid="setup-garder"
          disabled={busy || gardees.size === 0}
          onClick={() => onGarder(gardees)}
        >
          {gardees.size === changements.length
            ? t('Enregistrer', 'Save')
            : t(`Enregistrer les ${gardees.size} gardées`, `Save the ${gardees.size} kept`)}
        </Bouton>
        <Bouton variante="secondaire"
          data-testid="setup-jeter"
          disabled={busy}
          onClick={onJeter}
        >
          {t('Tout jeter', 'Drop all')}
        </Bouton>
      </div>
    </div>
  );
}
