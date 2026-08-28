'use client';

import { useState } from 'react';
import { useT } from '@/lib/i18n';
import { cardCls, inputCls } from '@/lib/ui';
import { MbaNotice } from '@/components/MbaNotice';
import {
  parlerAuConstructeur, restreindreProposition,
  type Changement, type PropositionConstruction, type TourConstruction,
} from '@/lib/api-agent-setup';

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
 * La conversation n'est pas persistée : elle vit dans cet onglet, et tout ce qu'elle produit atterrit dans
 * les autres, éditable champ par champ.
 */
export function AgentConstruction({ tenantId, agentId, onApplique }: {
  tenantId: string;
  agentId: string;
  /** Applique la proposition. Rendu par l'écran parent : c'est LUI qui porte le verrou de version. */
  onApplique: (p: PropositionConstruction) => Promise<void>;
}) {
  const t = useT();
  const [tours, setTours] = useState<TourConstruction[]>([]);
  const [saisie, setSaisie] = useState('');
  const [busy, setBusy] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [changements, setChangements] = useState<Changement[] | null>(null);
  const [proposition, setProposition] = useState<PropositionConstruction | null>(null);
  const [resteACouvrir, setResteACouvrir] = useState(0);
  // Chaque réponse ouvre un nouveau lot : ce numéro sert de clé au diff, pour que les choix « garder / jeter »
  // du lot précédent ne survivent pas à une proposition qui ne porte plus les mêmes lignes.
  const [lot, setLot] = useState(0);

  async function envoyer(texte: string) {
    const propre = texte.trim();
    if (propre === '' || busy) return;
    const suite: TourConstruction[] = [...tours, { role: 'user', content: propre }];
    setTours(suite);
    setSaisie('');
    setBusy(true);
    setErreur(null);
    setChangements(null);
    setProposition(null);
    try {
      const r = await parlerAuConstructeur(tenantId, agentId, suite);
      setTours([...suite, { role: 'assistant', content: r.message }]);
      setProposition(r.proposition);
      setChangements(r.changements);
      setResteACouvrir(r.couverture?.manquants.length ?? 0);
      setLot((n) => n + 1);
    } catch (err) {
      setErreur(err instanceof Error ? err.message : t('L’assistant n’a pas répondu', 'The assistant did not answer'));
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

  return (
    <div className="flex flex-col gap-4">
      <MbaNotice kind="warning">
        {t(
          'L’assistant fait d’abord le tour du sujet avec vous, puis il propose. Il ne change RIEN tout seul : vous voyez exactement ce que ça changerait, et vous gardez, corrigez ou jetez chaque règle séparément. Tout ce qu’il écrit reste modifiable dans les autres onglets.',
          'The assistant first covers the ground with you, then proposes. It changes NOTHING on its own: you see exactly what would change, and you keep, edit or drop each rule separately. Everything it writes stays editable in the other tabs.',
        )}
      </MbaNotice>
      {erreur && <MbaNotice kind="error" testid="setup-erreur">{erreur}</MbaNotice>}

      <div className={`${cardCls} flex flex-col gap-3`}>
        {tours.length === 0 && (
          <div data-testid="setup-vide" className="flex flex-col gap-2">
            <p className="text-sm text-ink-700">
              {t('Dites-lui ce que votre agent doit faire, dans vos mots.', 'Tell it what your agent should do, in your own words.')}
            </p>
            <div className="flex flex-wrap gap-2">
              {[
                t('Mon agent répond aux questions sur nos séjours et prend des rendez-vous.', 'My agent answers questions about our stays and books appointments.'),
                t('Il qualifie les demandes de devis, puis passe la main à un commercial.', 'It qualifies quote requests, then hands over to a salesperson.'),
              ].map((exemple) => (
                <button
                  key={exemple}
                  data-testid="setup-exemple"
                  disabled={busy}
                  onClick={() => void envoyer(exemple)}
                  className="rounded-lg border border-ink-300 px-3 py-1.5 text-left text-xs text-ink-700 hover:bg-ink-50 disabled:opacity-40"
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
              ? 'self-end max-w-[85%] rounded-2xl bg-brand-600 px-3 py-2 text-sm text-white'
              : 'self-start max-w-[85%] rounded-2xl bg-ink-100 px-3 py-2 text-sm text-ink-800'}
          >
            {tour.content}
          </div>
        ))}
        {busy && <p className="text-xs text-ink-500">{t('L’assistant réfléchit…', 'The assistant is thinking…')}</p>}

        <div className="flex flex-wrap gap-2">
          <input
            data-testid="setup-saisie"
            className={`${inputCls} flex-1`}
            value={saisie}
            disabled={busy}
            onChange={(e) => setSaisie(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void envoyer(saisie); }}
            placeholder={t('Votre réponse…', 'Your answer…')}
          />
          <button
            data-testid="setup-envoyer"
            disabled={busy || saisie.trim() === ''}
            onClick={() => void envoyer(saisie)}
            className="rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-40"
          >
            {t('Envoyer', 'Send')}
          </button>
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
      <p className="text-sm font-medium text-ink-700">{t('Ce que ça changerait', 'What this would change')}</p>
      {changements.map((c) => {
        const garde = gardees.has(c.champ);
        return (
          <div
            key={c.champ}
            data-testid={`setup-diff-${c.champ}`}
            className={`flex flex-col gap-1 rounded-lg border px-3 py-2 ${garde ? 'border-ink-200' : 'border-ink-200 bg-ink-50 opacity-60'}`}
          >
            <div className="flex items-start justify-between gap-2">
              <p className="text-xs font-medium text-ink-700">{c.label}</p>
              <button
                data-testid={`setup-bascule-${c.champ}`}
                disabled={busy}
                aria-pressed={garde}
                onClick={() => basculer(c.champ, c.apres)}
                className={`shrink-0 rounded-lg border px-2 py-1 text-[11px] disabled:opacity-40 ${garde
                  ? 'border-brand-600 bg-brand-50 text-brand-700'
                  : 'border-ink-300 text-ink-600 hover:bg-white'}`}
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
              <p className="whitespace-pre-wrap text-sm text-ink-800">{garde ? gardees.get(c.champ) : c.apres}</p>
            )}
          </div>
        );
      })}
      <div className="flex flex-wrap items-center gap-2">
        <button
          data-testid="setup-garder"
          disabled={busy || gardees.size === 0}
          onClick={() => onGarder(gardees)}
          className="rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-40"
        >
          {gardees.size === changements.length
            ? t('Enregistrer', 'Save')
            : t(`Enregistrer les ${gardees.size} gardées`, `Save the ${gardees.size} kept`)}
        </button>
        <button
          data-testid="setup-jeter"
          disabled={busy}
          onClick={onJeter}
          className="rounded-lg border border-ink-300 px-3 py-2 text-sm text-ink-700 hover:bg-ink-50 disabled:opacity-40"
        >
          {t('Tout jeter', 'Drop all')}
        </button>
      </div>
    </div>
  );
}
