'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useT } from '@/lib/i18n';
import { cardCls, inputCls } from '@/lib/ui';
import { dayLabel, hourMin } from '@/lib/day';
import { fmtCost, fmtNum } from '@/lib/format';
import { MbaNotice } from '@/components/MbaNotice';
import {
  essayerAgent, estSimule, listerEssais,
  type AppelTrace, type EssaiArchive, type ReponseEssai, type TourEssai,
} from '@/lib/api-agent-test';
import { Bouton } from '@/components/Bouton';

/**
 * L'onglet TESTER : parler à son agent avant de l'activer.
 *
 * 🔴 CE QUE CET ÉCRAN DOIT MONTRER, ET POURQUOI CE N'EST PAS QUE LA RÉPONSE. Ce qui fait qu'un agent marche
 * ou non, ce sont les outils qu'il choisit d'appeler et les sources qu'il trouve. Un panneau qui n'afficherait
 * que le texte laisserait le client régler à l'aveugle : il verrait une belle réponse sans savoir si elle
 * vient de sa base de connaissance ou de ce que le modèle a imaginé. Chaque appel est donc montré, avec ses
 * arguments et son issue.
 *
 * 🔴 ET IL GARDE LA TRACE. Julien, le 2026-09-08 : « j'ai voulu réappuyer et j'ai plus la trace de ce que
 * j'ai lu ». Régler un agent, c'est COMPARER : on change une consigne, on repose la MÊME question, et on
 * regarde si la réponse a bougé. C'est pour ça que « Reprendre » rejoue les messages archivés tels quels
 * plutôt que de les recopier dans la saisie : une comparaison sur une question retapée ne compare rien.
 *
 * 🔴 ET IL DIT CE QU'IL NE FAIT PAS. Les outils à effet sont simulés : il n'y a ni contact, ni conversation,
 * ni parcours ici. Le taire ferait croire qu'un tag a été posé, et le client réglerait la suite de sa
 * conversation sur une prémisse fausse.
 */
export function AgentTest({ tenantId, agentId }: { tenantId: string; agentId: string }) {
  const t = useT();
  const [tours, setTours] = useState<TourEssai[]>([]);
  const [appels, setAppels] = useState<AppelTrace[]>([]);
  const [sortie, setSortie] = useState<string | null>(null);
  const [motif, setMotif] = useState<ReponseEssai['motif']>(undefined);
  const [saisie, setSaisie] = useState('');
  const [busy, setBusy] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [essais, setEssais] = useState<EssaiArchive[]>([]);

  /**
   * ⚠️ L'historique est une COMMODITÉ, jamais une condition : son échec ne remonte pas dans le bandeau
   * d'erreur de l'essai. Un serveur qui ne tient pas de trace rend une liste vide, et l'écran marche.
   */
  const recharger = useCallback(() => {
    void listerEssais(tenantId, agentId).then(setEssais).catch(() => setEssais([]));
  }, [tenantId, agentId]);
  useEffect(recharger, [recharger]);

  /** Le POST, partagé par la saisie et par « Reprendre » : les deux doivent produire exactement le même essai. */
  async function jouer(suite: TourEssai[]) {
    if (busy) return;
    setTours(suite);
    setBusy(true);
    setErreur(null);
    setAppels([]);
    setSortie(null);
    setMotif(undefined);
    try {
      const r = await essayerAgent(tenantId, agentId, suite);
      setAppels(r.appels);
      setSortie(r.sortie);
      setMotif(r.motif);
      // `texte: null` est un cas nominal : l'agent sort sans rien dire, c'est le bloc aval qui parlera.
      if (r.texte !== null && r.texte !== '') setTours([...suite, { role: 'assistant', content: r.texte }]);
    } catch (err) {
      setErreur(err instanceof Error ? err.message : t('L’essai a échoué', 'The try failed'));
    } finally {
      setBusy(false);
      // Relu dans les DEUX cas : un essai qui échoue APRÈS un aller-retour facturé n'est pas archivé, mais
      // un essai qui a réussi l'est, et ne pas relire ici laisserait la liste en retard d'un essai.
      recharger();
    }
  }

  async function envoyer(texte: string) {
    const propre = texte.trim();
    if (propre === '' || busy) return;
    setSaisie('');
    await jouer([...tours, { role: 'user', content: propre }]);
  }

  return (
    <div className="flex flex-col gap-4">
      <MbaNotice kind="warning">
        {t(
          'Vous parlez au vrai agent. Seules les actions qui touchent le monde réel (poser un tag, envoyer un bloc, passer la main) sont simulées, et c’est dit à chaque fois.',
          'You are talking to the real agent. Only actions that touch the real world (tagging, sending a block, handing over) are simulated, and it is stated each time.',
        )}
      </MbaNotice>
      {erreur && <MbaNotice kind="error" testid="test-erreur">{erreur}</MbaNotice>}

      <div className={`${cardCls} flex flex-col gap-3`}>
        {tours.length === 0 && (
          <p data-testid="test-vide" className="text-sm text-ink-500">
            {t('Écrivez ce qu’un client vous écrirait.', 'Write what a customer would write to you.')}
          </p>
        )}
        {tours.map((tour, i) => (
          <div
            key={`${i}-${tour.content.slice(0, 24)}`}
            data-testid={`test-tour-${tour.role}`}
            className={tour.role === 'user'
              ? 'self-end max-w-[85%] rounded-carte bg-brand-600 px-3 py-2 text-sm text-white'
              : 'self-start max-w-[85%] rounded-carte bg-ink-100 px-3 py-2 text-sm text-ink-900'}
          >
            {tour.content}
          </div>
        ))}
        {busy && <p className="text-xs text-ink-500">{t('L’agent réfléchit…', 'The agent is thinking…')}</p>}

        <div className="flex flex-wrap gap-2">
          <input
            data-testid="test-saisie"
            className={`${inputCls} flex-1`}
            value={saisie}
            disabled={busy}
            onChange={(e) => setSaisie(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void envoyer(saisie); }}
            placeholder={t('Bonjour, vous avez une piscine ?', 'Hi, do you have a pool?')}
          />
          <Bouton
            data-testid="test-envoyer"
            disabled={busy || saisie.trim() === ''}
            onClick={() => void envoyer(saisie)}
          >
            {t('Envoyer', 'Send')}
          </Bouton>
        </div>
      </div>

      {sortie !== null && (
        /**
         * 🔴 LE MOTIF PASSE AVANT LA SORTIE quand il existe, et il change le TON du bandeau. « Sorti par
         * plafond » se lit comme un réglage à monter ; or dans un cas sur deux, aucun plafond n'était
         * atteint : le modèle a imité un résultat d'outil et le garde-fou a refusé sa réponse. Aucun
         * réglage ne corrige ça, et laisser le mot « plafond » seul envoie chercher pendant dix minutes.
         * Vécu par Julien le 2026-09-08.
         */
        <MbaNotice kind={motif === 'reponse_non_conforme' ? 'warning' : 'success'} testid="test-sortie">
          {motif === 'reponse_non_conforme'
            ? t(
              'Réponse refusée : le modèle a imité un résultat d’outil au lieu d’en appeler un. Ce n’est pas un plafond à monter : vérifiez que les outils de l’agent sont actifs, sinon changez de modèle.',
              'Answer refused: the model imitated a tool result instead of calling one. This is not a cap to raise: check that the agent’s tools are active, otherwise change the model.',
            )
            : t(
              `L’agent est sorti par « ${sortie} ». Dans un scénario, c’est cette branche du bloc qui prendrait la suite.`,
              `The agent left through “${sortie}”. In a scenario, that branch of the block would take over.`,
            )}
        </MbaNotice>
      )}

      {appels.length > 0 && (
        <div data-testid="test-appels" className={`${cardCls} flex flex-col gap-2`}>
          <p className="text-sm font-medium text-ink-900">{t('Ce que l’agent a fait', 'What the agent did')}</p>
          {appels.map((a, i) => <Appel key={`${i}-${a.nom}`} appel={a} rang={i} />)}
        </div>
      )}

      <Historique essais={essais} busy={busy} onReprendre={(e) => void jouer(e.messages)} />
    </div>
  );
}

/**
 * Les essais précédents.
 *
 * ⚠️ La RÉTENTION est dite à l'écran, pas seulement en base : un historique qui s'efface sans prévenir fait
 * croire à une perte. Elle est écrite en clair plutôt que branchée sur la constante du serveur, que le build
 * du navigateur ne partage pas ; `tests/agent-test-runs.test.ts` ancre la valeur côté serveur.
 */
function Historique({ essais, busy, onReprendre }: {
  essais: EssaiArchive[];
  busy: boolean;
  onReprendre: (essai: EssaiArchive) => void;
}) {
  const t = useT();
  if (essais.length === 0) return null;
  return (
    <div data-testid="test-historique" className={`${cardCls} flex flex-col gap-2`}>
      <p className="text-sm font-medium text-ink-900">{t('Vos essais précédents', 'Your previous tries')}</p>
      <p className="text-xs text-ink-500">
        {t(
          'Gardés 14 jours. « Reprendre » repose exactement la même question à l’agent tel qu’il est réglé maintenant : c’est ce qui permet de voir si un changement a servi.',
          'Kept for 14 days. “Run again” asks the agent the exact same question with its current settings: that is how you see whether a change helped.',
        )}
      </p>
      {essais.map((e) => <LigneEssai key={e.id} essai={e} busy={busy} onReprendre={() => onReprendre(e)} />)}
    </div>
  );
}

function LigneEssai({ essai, busy, onReprendre }: { essai: EssaiArchive; busy: boolean; onReprendre: () => void }) {
  const t = useT();
  const { locale } = useLocale();
  const [ouvert, setOuvert] = useState(false);
  // La DERNIÈRE question posée, pas la première : c'est elle qui a produit la réponse qu'on relit.
  const question = [...essai.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  return (
    <div data-testid={`test-essai-${essai.id}`} className="flex flex-col gap-1 rounded-controle border border-ink-200 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-ink-500">
        <span>{`${dayLabel(essai.createdAt, locale)} ${hourMin(essai.createdAt, locale)}`}</span>
        <span data-testid={`test-essai-cout-${essai.id}`}>
          {fmtCost(essai.coutMicroEur / 1_000_000, locale, 'EUR')}
        </span>
        <span>{`${fmtNum(essai.tokensEntree + essai.tokensSortie, locale)} ${t('jetons', 'tokens')}`}</span>
        {essai.sortie !== null && (
          <Etiquette classe="bg-brand-50 text-brand-700">{`${t('sortie', 'exit')} : ${essai.sortie}`}</Etiquette>
        )}
        {/* Les outils appelés : c'est ce qui distingue « il n'a pas trouvé » de « il n'a même pas cherché ». */}
        {essai.appels.length === 0
          ? <Etiquette classe="bg-ink-100 text-ink-500">{t('aucun outil', 'no tool')}</Etiquette>
          : essai.appels.map((a, i) => (
            <Etiquette
              key={`${i}-${a.nom}`}
              classe={a.status === 'ok' ? 'bg-succes-50 text-succes-700' : 'bg-danger-50 text-danger-800'}
            >
              {a.status === 'ok' ? a.nom : `${a.nom} : ${a.status}`}
            </Etiquette>
          ))}
      </div>
      <p className="truncate text-sm text-ink-900">{question}</p>
      {!ouvert && essai.reponse !== null && (
        <p className="line-clamp-2 text-xs text-ink-500">{essai.reponse}</p>
      )}
      {ouvert && (
        <div data-testid={`test-essai-detail-${essai.id}`} className="flex flex-col gap-2 pt-1">
          {essai.messages.map((m, i) => (
            <div
              key={`${i}-${m.content.slice(0, 24)}`}
              className={m.role === 'user'
                ? 'self-end max-w-[85%] rounded-carte bg-brand-600 px-3 py-2 text-sm text-white'
                : 'self-start max-w-[85%] rounded-carte bg-ink-100 px-3 py-2 text-sm text-ink-900'}
            >
              {m.content}
            </div>
          ))}
          {essai.reponse === null
            ? (
              <p className="text-xs italic text-ink-500">
                {t('L’agent n’a rien dit (il est sorti).', 'The agent said nothing (it exited).')}
              </p>
            )
            : (
              <div className="self-start max-w-[85%] rounded-carte bg-ink-100 px-3 py-2 text-sm text-ink-900">
                {essai.reponse}
              </div>
            )}
        </div>
      )}
      <div className="flex flex-wrap gap-3 pt-1">
        <button
          type="button"
          data-testid={`test-essai-ouvrir-${essai.id}`}
          onClick={() => setOuvert(!ouvert)}
          className="text-xs text-brand-600 hover:underline"
        >
          {ouvert ? t('Masquer', 'Hide') : t('Voir l’échange', 'See the exchange')}
        </button>
        <button
          type="button"
          data-testid={`test-essai-reprendre-${essai.id}`}
          disabled={busy}
          onClick={onReprendre}
          className="text-xs text-brand-600 hover:underline disabled:opacity-40"
        >
          {t('Reprendre', 'Run again')}
        </button>
      </div>
    </div>
  );
}

/** Un appel d'outil. Le statut et la simulation sont dits AVANT le contenu : c'est ce qu'on lit en premier. */
function Appel({ appel, rang }: { appel: AppelTrace; rang: number }) {
  const t = useT();
  const [ouvert, setOuvert] = useState(false);
  const simule = estSimule(appel);
  return (
    <div data-testid={`test-appel-${rang}`} className="flex flex-col gap-1 rounded-controle border border-ink-200 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-ink-900">{appel.nom}</span>
        {appel.status === 'ok'
          ? <Etiquette classe="bg-succes-50 text-succes-700">{t('exécuté', 'ran')}</Etiquette>
          : <Etiquette classe="bg-danger-50 text-danger-800">{appel.status}</Etiquette>}
        {simule && (
          <Etiquette classe="bg-alerte-100 text-ink-900">
            <span data-testid={`test-simule-${rang}`}>{t('simulé', 'simulated')}</span>
          </Etiquette>
        )}
      </div>
      <p className="break-all font-mono text-xs text-ink-500">{appel.arguments}</p>
      {simule && (
        <p className="text-xs leading-relaxed text-alerte-800">
          {t(
            'Rien n’a eu lieu pour de vrai : il n’y a ni contact ni conversation dans un test.',
            'Nothing actually happened: there is no contact and no conversation in a test.',
          )}
        </p>
      )}
      <button
        data-testid={`test-appel-detail-${rang}`}
        onClick={() => setOuvert(!ouvert)}
        className="self-start text-xs text-brand-600 hover:underline"
      >
        {ouvert ? t('Masquer ce qu’il a reçu', 'Hide what it got back') : t('Voir ce qu’il a reçu', 'See what it got back')}
      </button>
      {ouvert && (
        <pre className="max-h-48 overflow-auto rounded-controle bg-ink-50 p-2 text-xs leading-relaxed text-ink-900">
          {JSON.stringify(appel.contenu, null, 2)}
        </pre>
      )}
    </div>
  );
}

function Etiquette({ classe, children }: { classe: string; children: React.ReactNode }) {
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${classe}`}>{children}</span>;
}
