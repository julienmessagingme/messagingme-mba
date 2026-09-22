'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '@/lib/i18n';
import { cardCls, inputCls, inputClsAuto } from '@/lib/ui';
import { MbaNotice } from '@/components/MbaNotice';
import type { SourceAgent } from '@/lib/api-agent-sources';
import {
  creerRequete, listRequetes, patchRequete, supprimerRequete, testerBrouillon,
  type CatalogueVariables, type CorpsRequete, type CreationRequete, type MethodeRequete,
  type OrigineVariable, type Paire, type RequeteApi, type ResultatTest, type VariableRequete,
} from '@/lib/api-agent-requetes';
import { lireGabarit, pastillesDe } from '@/lib/gabarit-pastilles';
import { lireChemin } from '@/lib/chemin-relatif';

/**
 * METTRE AU POINT UN APPEL vers le système du client, et l'ÉPROUVER avant de l'ouvrir aux agents.
 *
 * 🔴 CE QUE CET ÉCRAN DOIT PERMETTRE À QUELQU'UN QUI NE CONNAÎT PAS LES API. C'est la contrainte que Julien a
 * posée : « un rookie de l'API devrait être capable de setupper tout seul ». D'où l'ordre imposé par la
 * disposition, qui est celui du raisonnement et pas celui du protocole :
 *
 *  1. **quelles données on envoie** (les variables, et d'où vient chacune) ;
 *  2. **où on les envoie** (méthode, chemin, paramètres, corps) ;
 *  3. **on essaie**, avec des valeurs de test ;
 *  4. **on coche ce qu'on garde** dans la réponse REÇUE, au lieu d'écrire des chemins de tête.
 *
 * L'étape 4 est celle qui change tout : écrire `livraison.date` de mémoire suppose de savoir lire du JSON, et
 * une faute de frappe ne se verrait qu'à l'exécution, en pleine conversation avec un contact.
 *
 * ⚠️ Le corps JSON est un `textarea` NU, et non le `VariableBodyEditor` du dépôt. Ce dernier rend des jetons
 * ATOMIQUES dans du texte en prose (message RCS, modèle d'email), ce qui est le bon outil là-bas et le mauvais
 * ici : du JSON se relit, se corrige caractère par caractère et se colle depuis une documentation. Les
 * variables s'insèrent donc par des pastilles cliquables, comme le `</>` de la référence.
 */

const METHODES: MethodeRequete[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

/** Un brouillon de requête, tel que l'écran le manipule avant enregistrement. */
interface Brouillon {
  sourceId: string;
  label: string;
  methode: MethodeRequete;
  chemin: string;
  parametres: Paire[];
  entetes: Array<{ nom: string; valeur: string }>;
  corps: CorpsRequete;
  variables: VariableRequete[];
  outputPaths: string[];
  valeursTest: Record<string, string | number | boolean>;
}

const vide = (sourceId: string): Brouillon => ({
  sourceId, label: '', methode: 'GET', chemin: '/',
  parametres: [], entetes: [], corps: { mode: 'aucun' }, variables: [],
  outputPaths: [], valeursTest: {},
});

const deLaRequete = (r: RequeteApi): Brouillon => ({
  sourceId: r.sourceId, label: r.label, methode: r.methode, chemin: r.chemin,
  parametres: r.parametres, entetes: r.entetes, corps: r.corps, variables: r.variables,
  outputPaths: r.outputPaths, valeursTest: r.valeursTest,
});

export function RequetesConnecteur({ tenantId, sources, sourceFiltre }: {
  tenantId: string;
  sources: SourceAgent[];
  /**
   * ⚠️ N'AFFICHER QUE LES APPELS DE CE SYSTÈME. L'écran des connecteurs ouvre un système à la fois : montrer
   * les appels des autres dessous ferait croire qu'ils lui appartiennent, et c'est exactement la confusion
   * que la bibliothèque existe pour lever. Absent = tous les appels (aucun autre appelant aujourd'hui, mais
   * le composant reste utilisable tel quel).
   */
  sourceFiltre?: string;
}) {
  const t = useT();
  const [requetes, setRequetes] = useState<RequeteApi[] | null>(null);
  const [champs, setChamps] = useState<string[]>([]);
  const [catalogue, setCatalogue] = useState<CatalogueVariables | null>(null);
  const [busy, setBusy] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [edite, setEdite] = useState<string | null>(null);
  const [brouillon, setBrouillon] = useState<Brouillon | null>(null);

  const charger = useCallback(async () => {
    try {
      const r = await listRequetes(tenantId);
      // ⚠️ Défensif : une réponse mal formée doit dégrader, jamais blanchir l'écran.
      setRequetes(Array.isArray(r?.requetes) ? r.requetes : []);
      setChamps(Array.isArray(r?.champs) ? r.champs : []);
      setCatalogue(r?.catalogue ?? { contact: [], systeme: [], entetesReserves: [] });
    } catch (err) {
      setErreur(err instanceof Error ? err.message : t('Chargement impossible', 'Unable to load'));
    }
  }, [tenantId, t]);
  useEffect(() => { void charger(); }, [charger]);

  /**
   * 🔴 ELLE REND DÉSORMAIS UN VERDICT, et c'est ce qui empêche de perdre une saisie (2026-09-15). Elle ne
   * rendait rien : le formulaire de création se refermait DANS LA FOULÉE de l'appel, sans attendre son
   * résultat. Un refus du serveur (« chemin refusé », « variable non déclarée »...) affichait donc son
   * message au-dessus d'un formulaire DISPARU, avec tout le travail dedans. Vécu par Julien le jour même :
   * « ça a pas enregistré les données que j'avais saisi et il faut tout refaire ».
   *
   * ⚠️ Le formulaire d'ÉDITION, lui, restait ouvert : le défaut ne touchait que la création, c'est-à-dire
   * exactement le moment où l'on a le plus à perdre et le moins l'habitude de l'écran.
   */
  async function agir(travail: () => Promise<void>): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setErreur(null);
    try {
      await travail();
      await charger();
      return true;
    } catch (err) {
      setErreur(err instanceof Error ? err.message : t('Opération impossible', 'Operation failed'));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const libelleSource = (id: string): string => sources.find((s) => s.id === id)?.label ?? id;
  const visibles = (requetes ?? []).filter((r) => sourceFiltre === undefined || r.sourceId === sourceFiltre);

  return (
    <div className="flex flex-col gap-3" data-testid="requetes-bloc">
      <div>
        <h2 className="text-base font-semibold text-ink-900">{t('Appels API', 'API calls')}</h2>
        <p className="mt-1 text-sm text-ink-600">
          {t(
            'Mettez un appel au point une fois, éprouvez-le avec le bouton Essayer, puis ouvrez-le à vos agents dans leur onglet Outils. Un même appel sert à plusieurs agents.',
            'Set up a call once, test it with the Try button, then open it to your agents in their Tools tab. The same call serves several agents.',
          )}
        </p>
      </div>

      {erreur && <MbaNotice kind="error" testid="requetes-erreur">{erreur}</MbaNotice>}

      {/* Aucun système : un appel n'a nulle part où aller. On le DIT plutôt que de laisser remplir un
          formulaire qui ne pourra pas s'enregistrer. */}
      {sources.length === 0 ? (
        <p data-testid="requetes-sans-source" className="text-sm text-ink-500">
          {t('Déclarez d’abord un système ci-dessus : un appel a besoin de savoir où aller.', 'Declare a system above first: a call needs to know where to go.')}
        </p>
      ) : (
        <>
          {requetes !== null && visibles.length === 0 && (
            <p data-testid="requetes-vide" className="text-sm text-ink-500">
              {t('Aucun appel pour l’instant.', 'No call yet.')}
            </p>
          )}

          {visibles.map((r) => (
            <div key={r.id} className={`${cardCls} flex flex-col gap-2`} data-testid={`requete-${r.id}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-medium text-ink-800">
                  <span className="mr-2 rounded bg-ink-100 px-1.5 py-0.5 font-mono text-[11px]">{r.methode}</span>
                  {r.label}
                  {/* ⚠️ IL Y AVAIT ICI UN BADGE « à finir » (2026-09-15, matin), retiré l'après-midi même
                      avec la migration 0150. Il signalait un appel sans champ de réponse, sur l'idée que tout
                      appel doit rendre quelque chose. C'est faux : un appel qui POUSSE ne rend rien d'utile
                      et n'est pas inachevé pour autant. Un appel est complet dès qu'il a un chemin, et ce
                      qu'un agent en lit se décide maintenant à son rattachement. */}
                </p>
                {/* ⚠️ Le nom du système n'est répété que si l'écran montre PLUSIEURS systèmes. Sous la section
                    d'un système déplié, il est déjà écrit deux fois au-dessus. */}
                <p className="text-xs text-ink-500">{sourceFiltre === undefined ? `${libelleSource(r.sourceId)} ` : ''}{r.chemin}</p>
              </div>
              <div className="flex flex-wrap items-center gap-3 text-xs">
                <button
                  data-testid={`requete-editer-${r.id}`}
                  onClick={() => { setEdite((v) => (v === r.id ? null : r.id)); setBrouillon(deLaRequete(r)); }}
                  className="text-brand-600 hover:underline"
                >
                  {edite === r.id ? t('Fermer', 'Close') : t('Modifier', 'Edit')}
                </button>
                {/* Le nombre d'outils qui la désignent : sans lui, on la supprimerait en rendant un agent
                    muet. Même rôle que le compteur d'agents sur une source. */}
                <span data-testid={`requete-usage-${r.id}`} className="text-ink-500">
                  {r.outils === 0
                    ? t('utilisé par aucun agent', 'used by no agent')
                    : t(`utilisé par ${r.outils} outil(s) d’agent`, `used by ${r.outils} agent tool(s)`)}
                </span>
                <button
                  data-testid={`requete-supprimer-${r.id}`}
                  disabled={busy || r.outils > 0}
                  title={r.outils > 0 ? t('Retirez-le d’abord des agents qui l’utilisent.', 'Remove it from the agents using it first.') : ''}
                  onClick={() => agir(async () => { await supprimerRequete(tenantId, r.id); setEdite(null); })}
                  className="text-coral hover:underline disabled:cursor-not-allowed disabled:text-ink-300 disabled:no-underline"
                >
                  {t('Supprimer', 'Delete')}
                </button>
              </div>
              {edite === r.id && brouillon && catalogue && (
                <Editeur
                  tenantId={tenantId} requeteId={r.id} sources={sources} champs={champs} catalogue={catalogue}
                  brouillon={brouillon} setBrouillon={setBrouillon} busy={busy}
                  onEnregistrer={() => agir(async () => { await patchRequete(tenantId, r.id, brouillon); })}
                />
              )}
            </div>
          ))}

          <NouvelleRequete
            tenantId={tenantId} sources={sources} champs={champs} catalogue={catalogue} busy={busy}
            sourceParDefaut={sourceFiltre}
            onCreer={(b) => agir(async () => { await creerRequete(tenantId, b as CreationRequete); })}
          />
        </>
      )}
    </div>
  );
}

function NouvelleRequete({ tenantId, sources, champs, catalogue, busy, sourceParDefaut, onCreer }: {
  tenantId: string; sources: SourceAgent[]; champs: string[]; catalogue: CatalogueVariables | null;
  busy: boolean;
  /** Le système déjà ouvert : un appel créé depuis SA section lui appartient, ne pas le redemander. */
  sourceParDefaut?: string;
  /** 🔴 REND SI L'ENREGISTREMENT A RÉUSSI : le formulaire ne se referme que dans ce cas, sinon la saisie
   *  serait perdue sur un refus du serveur. */
  onCreer: (b: Brouillon) => Promise<boolean>;
}) {
  const t = useT();
  const [ouvert, setOuvert] = useState(false);
  const defaut = sourceParDefaut ?? sources[0]?.id ?? '';
  const [brouillon, setBrouillon] = useState<Brouillon>(() => vide(defaut));

  if (!ouvert) {
    return (
      <button data-testid="requete-nouvelle" onClick={() => { setBrouillon(vide(defaut)); setOuvert(true); }} className="self-start text-sm text-brand-600 hover:underline">
        {t('+ un appel', '+ a call')}
      </button>
    );
  }
  return (
    <div className={`${cardCls} flex flex-col gap-2`} data-testid="requete-nouvelle-form">
      {catalogue && (
        <Editeur
          tenantId={tenantId} requeteId={null} sources={sources} champs={champs} catalogue={catalogue}
          brouillon={brouillon} setBrouillon={setBrouillon as (b: Brouillon) => void} busy={busy}
          onEnregistrer={() => { void onCreer(brouillon).then((ok) => { if (ok) setOuvert(false); }); }}
        />
      )}
      <button onClick={() => setOuvert(false)} className="self-start text-xs text-ink-500 hover:underline">{t('Annuler', 'Cancel')}</button>
    </div>
  );
}

type Onglet = 'variables' | 'url' | 'corps' | 'entetes' | 'reponse';

function Editeur({ tenantId, requeteId, sources, champs, catalogue, brouillon, setBrouillon, busy, onEnregistrer }: {
  tenantId: string; requeteId: string | null; sources: SourceAgent[]; champs: string[];
  catalogue: CatalogueVariables; brouillon: Brouillon; setBrouillon: (b: Brouillon) => void;
  busy: boolean; onEnregistrer: () => void;
}) {
  const t = useT();
  const [onglet, setOnglet] = useState<Onglet>('variables');
  const [resultat, setResultat] = useState<ResultatTest | null>(null);
  const [essai, setEssai] = useState(false);
  const maj = (p: Partial<Brouillon>) => setBrouillon({ ...brouillon, ...p });

  /** Zone de saisie ayant reçu le focus en dernier : c'est là qu'une pastille insère sa variable. */
  const cible = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);

  const insererVariable = (nom: string): void => {
    const el = cible.current;
    if (!el) return;
    const debut = el.selectionStart ?? el.value.length;
    const fin = el.selectionEnd ?? debut;
    const jeton = `{{${nom}}}`;
    const suite = `${el.value.slice(0, debut)}${jeton}${el.value.slice(fin)}`;
    // On repasse par le setter React de l'élément, sinon la valeur affichée et l'état divergeraient.
    const setter = Object.getOwnPropertyDescriptor(
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value',
    )?.set;
    setter?.call(el, suite);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.focus();
    el.setSelectionRange(debut + jeton.length, debut + jeton.length);
  };

  const essayer = async (): Promise<void> => {
    setEssai(true);
    try {
      // 🔴 ON ÉPROUVE CE QUI EST À L'ÉCRAN, enregistré ou non. Avant, ce bouton exigeait un appel déjà en
      // base : créer le premier appel d'un client était donc impossible (enregistrer réclame un champ de
      // sortie, qui se coche dans la réponse d'un essai, qui réclamait un enregistrement). Et sur un appel
      // existant qu'on modifiait, il éprouvait la version STOCKÉE, donc une adresse que le client venait de
      // changer.
      setResultat(await testerBrouillon(tenantId, {
        sourceId: brouillon.sourceId, methode: brouillon.methode, chemin: brouillon.chemin,
        parametres: brouillon.parametres, entetes: brouillon.entetes, corps: brouillon.corps,
        variables: brouillon.variables, valeursTest: brouillon.valeursTest,
      }));
      setOnglet('reponse');
    } catch (err) {
      setResultat({ ok: false, erreur: err instanceof Error ? err.message : 'erreur' });
      setOnglet('reponse');
    } finally {
      setEssai(false);
    }
  };

  /**
   * Les pastilles écrites quelque part dans l'appel et qui ne correspondent à aucune donnée déclarée.
   *
   * ⚠️ Les noms VIDES sont écartés des deux côtés : une ligne de variable qu'on vient d'ajouter n'a pas
   * encore de nom, et la compter comme déclarée ferait taire l'avertissement au moment où il sert.
   */
  const declarees = new Set(brouillon.variables.map((v) => v.nom.trim()).filter((n) => n !== ''));
  const gabarits = [
    brouillon.chemin,
    ...brouillon.parametres.flatMap((x) => [x.cle, x.valeur]),
    ...brouillon.entetes.map((x) => x.valeur),
    brouillon.corps.mode === 'json' ? brouillon.corps.gabarit : '',
    ...(brouillon.corps.mode === 'champs' ? brouillon.corps.champs.map((c) => c.valeur) : []),
  ];
  const nonDeclarees = [...new Set(gabarits.flatMap(pastillesDe))].filter((n) => !declarees.has(n));
  /** Le chemin porte-t-il une adresse ? Lu contre le système RÉELLEMENT choisi, pas contre le premier. */
  const problemeChemin = lireChemin(brouillon.chemin, sources.find((x) => x.id === brouillon.sourceId)?.baseUrl ?? '');

  const ongletCls = (o: Onglet): string =>
    `border-b-2 px-2 pb-1 text-xs ${onglet === o ? 'border-brand-500 font-medium text-brand-700' : 'border-transparent text-ink-500 hover:text-ink-700'}`;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-ink-200 p-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-ink-600">
          {t('Nom de l’appel', 'Call name')}
          <input className={`${inputCls} mt-1 w-56`} data-testid="requete-label" value={brouillon.label} onChange={(e) => maj({ label: e.target.value })} placeholder={t('Chercher une commande', 'Find an order')} />
        </label>
        <label className="text-xs text-ink-600">
          {t('Système', 'System')}
          <select className={`${inputCls} mt-1 w-40`} data-testid="requete-source" value={brouillon.sourceId} onChange={(e) => maj({ sourceId: e.target.value })}>
            {sources.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
        <label className="text-xs text-ink-600">
          {t('Méthode', 'Method')}
          <select className={`${inputCls} mt-1 w-28`} data-testid="requete-methode" value={brouillon.methode} onChange={(e) => maj({ methode: e.target.value as MethodeRequete })}>
            {METHODES.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label className="min-w-[16rem] flex-1 text-xs text-ink-600">
          {t('Chemin (relatif au système)', 'Path (relative to the system)')}
          <input
            className={`${inputCls} mt-1 font-mono`} data-testid="requete-chemin" value={brouillon.chemin}
            onFocus={(e) => { cible.current = e.currentTarget; }}
            onChange={(e) => maj({ chemin: e.target.value })} placeholder="/commandes/{{ref}}"
          />
        </label>
        <button
          data-testid="requete-essayer"
          // ⚠️ IL MANQUE SEULEMENT L'ADRESSE : le serveur assemble l'appel avec le MÊME code que l'exécution,
          // donc ce qui passe ici passera en conversation. Ce qu'on exige avant de laisser essayer est donc
          // ce sans quoi il n'y a pas d'appel du tout : une source et un chemin.
          disabled={busy || essai || brouillon.sourceId === '' || brouillon.chemin.trim() === ''}
          title={brouillon.sourceId !== '' && brouillon.chemin.trim() !== '' ? '' : t('Choisissez un système et un chemin.', 'Pick a system and a path.')}
          onClick={() => { void essayer(); }}
          className="rounded-lg border border-brand-500 px-3 py-1.5 text-xs font-semibold text-brand-600 hover:bg-brand-50 disabled:cursor-not-allowed disabled:border-ink-200 disabled:text-ink-300"
        >
          {essai ? t('Essai…', 'Trying…') : t('Essayer', 'Try')}
        </button>
      </div>

      {/**
        * 🔴 COLLER L'ADRESSE ENTIÈRE EST LE RÉFLEXE NORMAL, et l'écran le refusait APRÈS l'envoi du
        * formulaire, avec « le chemin doit être relatif à l'adresse de base ». Le refus est juste, le moment
        * est faux, et le message ne disait pas le geste : la base est déjà déclarée sur le système, il ne
        * faut garder que ce qui la suit. Vécu par Julien le 2026-09-15.
        * ⚠️ On PROPOSE, on ne corrige pas en silence : une adresse d'un AUTRE hôte n'a rien à rattraper.
        */}
      {problemeChemin.probleme !== null && (
        <div className="flex flex-wrap items-center gap-2" data-testid="chemin-avertissement">
          <p className="text-[11px] text-coral">
            {problemeChemin.probleme === 'base-recopiee'
              ? t(
                `Le chemin recommence par l’adresse du système. Gardez seulement ce qui la suit : ${problemeChemin.propose ?? ''}`,
                `The path repeats the system’s address. Keep only what follows it: ${problemeChemin.propose ?? ''}`,
              )
              : t(
                'Le chemin ne peut pas porter une adresse complète : il est relatif au système choisi ci-dessus.',
                'The path cannot carry a full address: it is relative to the system picked above.',
              )}
          </p>
          {problemeChemin.propose !== null && (
            <button
              data-testid="chemin-corriger" onClick={() => maj({ chemin: problemeChemin.propose! })}
              className="rounded border border-brand-500 px-2 py-0.5 text-[11px] font-semibold text-brand-600 hover:bg-brand-50"
            >
              {t('Corriger', 'Fix it')}
            </button>
          )}
        </div>
      )}

      <div className="flex gap-1 border-b border-ink-200">
        <button className={ongletCls('variables')} data-testid="onglet-variables" onClick={() => setOnglet('variables')}>{t('Données envoyées', 'Data sent')}</button>
        <button className={ongletCls('url')} data-testid="onglet-url" onClick={() => setOnglet('url')}>{t('Paramètres d’URL', 'URL params')}</button>
        <button className={ongletCls('corps')} data-testid="onglet-corps" onClick={() => setOnglet('corps')}>{t('Corps', 'Body')}</button>
        <button className={ongletCls('entetes')} data-testid="onglet-entetes" onClick={() => setOnglet('entetes')}>{t('En-têtes', 'Headers')}</button>
        <button className={ongletCls('reponse')} data-testid="onglet-reponse" onClick={() => setOnglet('reponse')}>{t('Réponse (défaut)', 'Response (default)')}</button>
      </div>

      {/**
        * Les pastilles d'insertion, sur tous les onglets où l'on écrit un gabarit : on clique, ça s'insère au
        * curseur, plutôt que de retenir la syntaxe.
        *
        * 🔴 ELLE S'AFFICHE MÊME QUAND IL N'Y A AUCUNE VARIABLE, et c'est le correctif du 2026-09-15. Avant,
        * elle n'apparaissait qu'une fois une donnée déclarée : celui qui débute ne voyait donc JAMAIS que le
        * mécanisme existait, et tapait les accolades à la main dans un onglet où rien ne l'attendait. Vécu
        * par Julien le jour même. Une capacité qu'on ne découvre qu'après s'en être passé n'existe pas.
        */}
      {onglet !== 'reponse' && (
        <div className="flex flex-wrap items-center gap-1" data-testid="pastilles-variables">
          <span className="text-[11px] text-ink-500">{t('Insérer :', 'Insert:')}</span>
          {brouillon.variables.filter((v) => v.nom.trim() !== '').map((v) => (
            <button key={v.nom} data-testid={`pastille-${v.nom}`} onClick={() => insererVariable(v.nom)} className="rounded bg-brand-100 px-1.5 py-0.5 text-[11px] font-medium text-brand-700 hover:bg-brand-200">
              {v.nom}
            </button>
          ))}
          {brouillon.variables.every((v) => v.nom.trim() === '') && (
            <button
              data-testid="pastilles-vides" onClick={() => setOnglet('variables')}
              className="text-[11px] text-brand-600 hover:underline"
            >
              {t(
                'aucune donnée déclarée. Commencez par l’onglet « Données envoyées ».',
                'no data declared yet. Start with the “Data sent” tab.',
              )}
            </button>
          )}
        </div>
      )}

      {/**
        * 🔴 UNE PASTILLE QUI NE DÉSIGNE RIEN, DITE PENDANT QU'ON L'ÉCRIT. Le serveur refuse l'appel au
        * moment de le passer (`construireCorps` nomme les manquantes), mais c'est trop tard : l'écran
        * restait muet pendant toute la saisie, et le client découvrait le problème en conversation.
        * ⚠️ On regarde TOUT ce qui porte des gabarits, pas seulement le corps : le chemin, les paramètres
        * d'URL et les en-têtes en portent aussi, et n'en couvrir qu'un serait un demi-contrôle.
        */}
      {onglet !== 'reponse' && nonDeclarees.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 text-[11px] text-amber-700" data-testid="pastilles-inconnues">
          <span>{t('Utilisées mais pas déclarées :', 'Used but not declared:')}</span>
          {nonDeclarees.map((nom) => (
            <button
              key={nom} data-testid={`declarer-${nom}`}
              onClick={() => {
                maj({ variables: [...brouillon.variables.filter((v) => v.nom.trim() !== ''), { nom, type: 'string', origine: { type: 'modele' } }] });
                setOnglet('variables');
              }}
              className="rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-800 hover:bg-amber-200"
            >
              {t(`déclarer ${nom}`, `declare ${nom}`)}
            </button>
          ))}
        </div>
      )}

      {onglet === 'variables' && (
        <OngletVariables brouillon={brouillon} maj={maj} champs={champs} catalogue={catalogue} />
      )}
      {onglet === 'url' && (
        <Paires
          testidPrefixe="param" lignes={brouillon.parametres} cible={cible}
          onChange={(parametres) => maj({ parametres })}
          libelles={[t('Nom du paramètre', 'Parameter name'), t('Valeur', 'Value')]}
        />
      )}
      {onglet === 'corps' && <OngletCorps brouillon={brouillon} maj={maj} cible={cible} />}
      {onglet === 'entetes' && (
        <>
          <p className="text-[11px] text-ink-500">
            {t(
              `L’authentification se déclare sur le système, pas ici. Ces en-têtes sont refusés : ${catalogue.entetesReserves.join(', ')}.`,
              `Authentication is declared on the system, not here. These headers are rejected: ${catalogue.entetesReserves.join(', ')}.`,
            )}
          </p>
          <Paires
            testidPrefixe="entete"
            lignes={brouillon.entetes.map((e) => ({ cle: e.nom, valeur: e.valeur }))}
            cible={cible}
            onChange={(l) => maj({ entetes: l.map((x) => ({ nom: x.cle, valeur: x.valeur })) })}
            libelles={[t('Nom de l’en-tête', 'Header name'), t('Valeur', 'Value')]}
          />
        </>
      )}
      {onglet === 'reponse' && <OngletReponse brouillon={brouillon} maj={maj} resultat={resultat} />}

      <button
        data-testid="requete-enregistrer"
        /**
         * 🔴 UN APPEL À MOITIÉ ÉCRIT S'ENREGISTRE, depuis le 2026-09-15. Ce bouton exigeait un champ de
         * sortie coché ; or ces champs se cochent dans la RÉPONSE d'un essai, donc un appel qu'on n'avait
         * pas encore réussi à faire marcher ne pouvait pas être mis de côté. Julien, le jour même : « je
         * peux pas enregistrer pour commencer, quand je vais revenir je vais devoir repartir de zéro ».
         * La garantie « le client décide ce que l'agent lit » n'a pas disparu, elle a bougé d'un cran : le
         * serveur refuse de RATTACHER à un agent un appel sans champ de sortie (409).
         */
        disabled={busy || brouillon.label.trim() === '' || brouillon.chemin.trim() === ''}
        title={brouillon.outputPaths.length === 0
          ? t('Enregistré comme brouillon : il faudra cocher un champ dans l’onglet Réponse avant de l’ouvrir à un agent.',
            'Saved as a draft: you will need to tick a field in the Response tab before opening it to an agent.')
          : ''}
        onClick={onEnregistrer}
        className="self-start rounded-lg bg-brand-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
      >
        {t('Enregistrer', 'Save')}
      </button>
    </div>
  );
}

/** D'où vient la valeur d'une variable. La liste vient du SERVEUR, jamais recopiée ici. */
function OngletVariables({ brouillon, maj, champs, catalogue }: {
  brouillon: Brouillon; maj: (p: Partial<Brouillon>) => void; champs: string[]; catalogue: CatalogueVariables;
}) {
  const t = useT();
  const changer = (i: number, v: Partial<VariableRequete>): void => {
    const suite = brouillon.variables.map((x, j) => (j === i ? { ...x, ...v } : x));
    maj({ variables: suite });
  };
  /** La valeur de la liste déroulante encode l'origine : `champ:ville`, `systeme:maintenant`, `modele`. */
  const clefDe = (o: OrigineVariable): string => (o.type === 'modele' || o.type === 'fixe' ? o.type : `${o.type}:${o.cle}`);
  const origineDe = (clef: string): OrigineVariable => {
    if (clef === 'modele') return { type: 'modele' };
    if (clef === 'fixe') return { type: 'fixe', valeur: '' };
    const [type, cle] = clef.split(':');
    return { type: type as 'contact' | 'champ' | 'systeme', cle: cle ?? '' } as OrigineVariable;
  };

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[11px] text-ink-500">
        {t(
          'Chaque donnée envoyée porte un nom, et vous dites d’où vient sa valeur. Insérez-la ensuite dans le chemin, les paramètres, les en-têtes ou le corps avec les pastilles.',
          'Each piece of data sent has a name, and you say where its value comes from. Then insert it into the path, params, headers or body with the chips.',
        )}
      </p>
      {/* Mêmes intitulés visibles que les autres onglets : la VALEUR D'ESSAI surtout, qui, remplie, se lisait comme
          la donnée elle-même (Julien, 2026-09-23).
          ⚠️ LES LIGNES NE PASSENT PLUS À LA LIGNE, le bloc DÉFILE : une ligne qui se replie décale ses champs sous
          des intitulés qui, eux, ne bougent pas (revue du 2026-09-23). Et les champs portent `inputClsAuto`, pas
          `inputCls` : son `w-full` l'emporte sur `w-32` en Tailwind 3, donc aucune colonne n'avait sa largeur. */}
      <div className="overflow-x-auto">
      <div className="flex w-max flex-col gap-2">
      {brouillon.variables.length > 0 && (
        <div className="flex gap-2 text-[11px] font-medium text-ink-500" data-testid="var-intitules">
          <span className="w-32">{t('Nom de la donnée', 'Data name')}</span>
          <span className="w-56">{t('D’où vient sa valeur', 'Where its value comes from')}</span>
          <span className="w-28">{t('Type', 'Type')}</span>
          <span className="w-40">{t('Obligatoire', 'Required')}</span>
          <span className="w-32">{t('Valeur d’essai', 'Test value')}</span>
        </div>
      )}
      {brouillon.variables.map((v, i) => (
        <div key={i} className="flex items-start gap-2">
          <input
            className={`${inputClsAuto} w-32 font-mono`} data-testid={`var-nom-${i}`} value={v.nom} placeholder="ville"
            aria-label={t('Nom de la donnée', 'Data name')}
            onChange={(e) => changer(i, { nom: e.target.value })}
          />
          <div className="flex w-56 flex-col gap-1">
          <select
            className={`${inputClsAuto} w-56`} data-testid={`var-origine-${i}`} value={clefDe(v.origine)}
            aria-label={t('D’où vient sa valeur', 'Where its value comes from')}
            onChange={(e) => changer(i, { origine: origineDe(e.target.value) })}
          >
            <option value="modele">{t('décidée par l’agent', 'decided by the agent')}</option>
            {catalogue.contact.map((c) => (
              <option key={c} value={`contact:${c}`}>{c === 'wa_id' ? t('numéro du contact', 'contact’s number') : t('nom du contact', 'contact’s name')}</option>
            ))}
            {champs.map((c) => <option key={c} value={`champ:${c}`}>{t(`champ « ${c} »`, `field “${c}”`)}</option>)}
            {catalogue.systeme.map((c) => (
              <option key={c} value={`systeme:${c}`}>
                {c === 'maintenant' ? t('date et heure courantes', 'current date and time') : t('dernier message du contact', 'contact’s last message')}
              </option>
            ))}
            <option value="fixe">{t('valeur fixe', 'fixed value')}</option>
          </select>
          {v.origine.type === 'fixe' && (
            <input
              className={`${inputClsAuto} w-56`} data-testid={`var-fixe-${i}`} value={String(v.origine.valeur)}
              placeholder={t('la valeur fixe', 'the fixed value')} aria-label={t('Valeur fixe', 'Fixed value')}
              onChange={(e) => changer(i, { origine: { type: 'fixe', valeur: e.target.value } })}
            />
          )}
          </div>
          <select className={`${inputClsAuto} w-28`} aria-label={t('Type', 'Type')} data-testid={`var-type-${i}`} value={v.type} onChange={(e) => changer(i, { type: e.target.value as VariableRequete['type'] })}>
            <option value="string">{t('texte', 'text')}</option>
            <option value="number">{t('nombre', 'number')}</option>
            <option value="integer">{t('entier', 'integer')}</option>
            <option value="boolean">{t('oui/non', 'yes/no')}</option>
          </select>
          <label className="flex w-40 items-center gap-1 text-[11px] text-ink-600">
            <input type="checkbox" data-testid={`var-requis-${i}`} checked={v.requis === true} onChange={(e) => changer(i, { requis: e.target.checked })} />
            {t('sans elle, on n’appelle pas', 'without it, no call')}
          </label>
          {/* La valeur d'essai vit À CÔTÉ de la variable : c'est là qu'on la cherche au moment d'essayer. */}
          <input
            className={`${inputClsAuto} w-32`} data-testid={`var-test-${i}`} value={String(brouillon.valeursTest[v.nom] ?? '')}
            placeholder={t('valeur de test', 'test value')} aria-label={t('Valeur d’essai', 'Test value')}
            onChange={(e) => maj({ valeursTest: { ...brouillon.valeursTest, [v.nom]: e.target.value } })}
          />
          <button data-testid={`var-retirer-${i}`} onClick={() => maj({ variables: brouillon.variables.filter((_, j) => j !== i) })} className="text-xs text-coral hover:underline">
            {t('retirer', 'remove')}
          </button>
        </div>
      ))}
      </div>
      </div>
      <button
        data-testid="var-ajouter"
        onClick={() => maj({ variables: [...brouillon.variables, { nom: '', type: 'string', origine: { type: 'modele' } }] })}
        className="self-start text-xs text-brand-600 hover:underline"
      >
        {t('+ une donnée', '+ a piece of data')}
      </button>
    </div>
  );
}

function OngletCorps({ brouillon, maj, cible }: {
  brouillon: Brouillon; maj: (p: Partial<Brouillon>) => void;
  cible: React.MutableRefObject<HTMLTextAreaElement | HTMLInputElement | null>;
}) {
  const t = useT();
  const mode = brouillon.corps.mode;
  const champs = brouillon.corps.mode === 'champs' ? brouillon.corps.champs : [];
  const gabarit = brouillon.corps.mode === 'json' ? brouillon.corps.gabarit : '';

  /**
   * Passer de la liste au JSON REPREND le travail déjà fait, mais l'inverse ne le peut pas : tout JSON n'est
   * pas représentable en liste (objet imbriqué, tableau). On le DIT, plutôt que d'amputer en silence.
   */
  const versJson = (): void => {
    const objet: Record<string, string> = {};
    for (const c of champs) if (c.cle.trim() !== '') objet[c.cle.trim()] = c.valeur;
    maj({ corps: { mode: 'json', gabarit: JSON.stringify(objet, null, 2) } });
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3 text-xs text-ink-700">
        {(['aucun', 'champs', 'json'] as const).map((m) => (
          <label key={m} className="flex items-center gap-1">
            <input
              type="radio" name="corps-mode" data-testid={`corps-mode-${m}`} checked={mode === m}
              onChange={() => {
                if (m === 'json' && mode === 'champs') { versJson(); return; }
                maj({ corps: m === 'json' ? { mode: 'json', gabarit } : m === 'champs' ? { mode: 'champs', champs } : { mode: 'aucun' } });
              }}
            />
            {m === 'aucun' ? t('aucun corps', 'no body') : m === 'champs' ? t('liste de champs', 'field list') : t('JSON brut', 'raw JSON')}
          </label>
        ))}
      </div>

      {mode === 'champs' && (
        <>
          <p className="text-[11px] text-ink-500">
            {t('Une ligne par donnée à envoyer. Aucune accolade à écrire.', 'One line per piece of data to send. No braces to write.')}
          </p>
          <Paires
            testidPrefixe="corps-champ" lignes={champs} cible={cible}
            onChange={(l) => maj({ corps: { mode: 'champs', champs: l } })}
            libelles={[t('Nom du champ', 'Field name'), t('Valeur', 'Value')]}
          />
          <button data-testid="corps-vers-json" onClick={versJson} className="self-start text-xs text-brand-600 hover:underline">
            {t('Passer en JSON brut (sans retour possible)', 'Switch to raw JSON (no way back)')}
          </button>
        </>
      )}

      {mode === 'json' && (
        <>
          <p className="text-[11px] text-ink-500">
            {t('Collez le corps attendu par votre API et remplacez les valeurs variables par une pastille.', 'Paste the body your API expects and replace variable values with a chip.')}
          </p>
          <textarea
            className={`${inputCls} font-mono`} rows={8} data-testid="corps-json" value={gabarit}
            onFocus={(e) => { cible.current = e.currentTarget; }}
            onChange={(e) => maj({ corps: { mode: 'json', gabarit: e.target.value } })}
            placeholder={'{\n  "ville": "{{ville}}"\n}'}
          />
          <ApercuJson gabarit={gabarit} onReparer={(repare) => maj({ corps: { mode: 'json', gabarit: repare } })} />
        </>
      )}
    </div>
  );
}

/**
 * Dit tout de suite si le JSON tient debout. Le serveur refuse aussi, mais après un aller-retour.
 *
 * 🔴 ET QUAND LA CAUSE EST IDENTIFIABLE, IL LA NOMME (2026-09-15). « Ce n'est pas du JSON valide » était vrai
 * et inutilisable : le client regardait `"user_ns": {{user_ns}}` sans pouvoir deviner que la pastille se met
 * DANS la chaîne. Une erreur qui décrit le symptôme sans nommer le geste laisse quelqu'un bloqué devant sa
 * propre faute.
 *
 * ⚠️ ET LES GUILLEMETS NE FORCENT PAS UNE CHAÎNE, sans quoi le conseil serait faux : le serveur remplace une
 * chaîne valant EXACTEMENT `"{{x}}"` par la valeur AVEC SON TYPE déclaré. Le message le dit, parce que c'est
 * la question suivante de quiconque envoie un identifiant numérique.
 */
function ApercuJson({ gabarit, onReparer }: { gabarit: string; onReparer: (repare: string) => void }) {
  const t = useT();
  if (gabarit.trim() === '') return null;
  try {
    JSON.parse(gabarit);
    return <p className="text-[11px] text-emerald-700" data-testid="corps-json-etat">{t('JSON valide', 'Valid JSON')}</p>;
  } catch {
    const { horsGuillemets, repare } = lireGabarit(gabarit);
    // Le correctif n'est proposé que s'il MARCHE : un gabarit cassé pour une autre raison (accolade
    // manquante) ne doit pas recevoir un bouton qui ne le répare pas, sinon le bouton devient un mensonge.
    let reparable = false;
    if (horsGuillemets.length > 0) {
      try { JSON.parse(repare); reparable = true; } catch { reparable = false; }
    }
    if (!reparable) {
      return <p className="text-[11px] text-coral" data-testid="corps-json-etat">{t('Ce n’est pas du JSON valide.', 'This is not valid JSON.')}</p>;
    }
    return (
      <div className="flex flex-wrap items-center gap-2" data-testid="corps-json-etat">
        <p className="text-[11px] text-coral">
          {t(
            `Une pastille se met entre guillemets : "{{${horsGuillemets[0]!}}}". Elle garde son type déclaré, un nombre part bien en nombre.`,
            `A chip goes inside quotes: "{{${horsGuillemets[0]!}}}". It keeps its declared type, a number is still sent as a number.`,
          )}
        </p>
        <button
          data-testid="corps-json-reparer" onClick={() => onReparer(repare)}
          className="rounded border border-brand-500 px-2 py-0.5 text-[11px] font-semibold text-brand-600 hover:bg-brand-50"
        >
          {t('Corriger', 'Fix it')}
        </button>
      </div>
    );
  }
}

/** Deux colonnes clé/valeur, partagées par les paramètres d'URL, les en-têtes et le corps en liste. */
function Paires({ lignes, onChange, libelles, testidPrefixe, cible }: {
  lignes: Paire[];
  onChange: (l: Paire[]) => void;
  libelles: [string, string];
  testidPrefixe: string;
  cible: React.MutableRefObject<HTMLTextAreaElement | HTMLInputElement | null>;
}) {
  const t = useT();
  return (
    <div className="flex flex-col gap-2">
      {/* 🔴 DES INTITULÉS TOUJOURS VISIBLES (Julien, 2026-09-23). Ils n'étaient que des `placeholder`, qui
          disparaissent dès qu'un champ est rempli : en modifiant un appel existant, on ne savait plus quelle
          colonne était le nom et laquelle la valeur. */}
      <div className="overflow-x-auto">
      <div className="flex w-max flex-col gap-2">
      {lignes.length > 0 && (
        <div className="flex gap-2 text-[11px] font-medium text-ink-500" data-testid={`${testidPrefixe}-intitules`}>
          <span className="w-40">{libelles[0]}</span>
          <span className="w-64">{libelles[1]}</span>
        </div>
      )}
      {lignes.map((l, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            className={`${inputClsAuto} w-40`} data-testid={`${testidPrefixe}-cle-${i}`} value={l.cle} placeholder={libelles[0]}
            aria-label={libelles[0]}
            onChange={(e) => onChange(lignes.map((x, j) => (j === i ? { ...x, cle: e.target.value } : x)))}
          />
          <input
            className={`${inputClsAuto} w-64 font-mono`} data-testid={`${testidPrefixe}-valeur-${i}`} value={l.valeur} placeholder={libelles[1]}
            aria-label={libelles[1]}
            onFocus={(e) => { cible.current = e.currentTarget; }}
            onChange={(e) => onChange(lignes.map((x, j) => (j === i ? { ...x, valeur: e.target.value } : x)))}
          />
          <button data-testid={`${testidPrefixe}-retirer-${i}`} onClick={() => onChange(lignes.filter((_, j) => j !== i))} className="text-xs text-coral hover:underline">
            {t('retirer', 'remove')}
          </button>
        </div>
      ))}
      </div>
      </div>
      <button data-testid={`${testidPrefixe}-ajouter`} onClick={() => onChange([...lignes, { cle: '', valeur: '' }])} className="self-start text-xs text-brand-600 hover:underline">
        {t('+ une ligne', '+ a line')}
      </button>
    </div>
  );
}

/**
 * LA RÉPONSE, ET CE QU'ON EN GARDE.
 *
 * 🔴 C'est l'onglet qui rend l'écran utilisable par quelqu'un qui ne connaît pas les API : après l'essai, les
 * champs de la réponse RÉELLE apparaissent en cases à cocher. Écrire `livraison.date` de mémoire suppose de
 * savoir lire du JSON, et une faute de frappe ne se verrait qu'en pleine conversation avec un contact.
 */
function OngletReponse({ brouillon, maj, resultat }: {
  brouillon: Brouillon; maj: (p: Partial<Brouillon>) => void; resultat: ResultatTest | null;
}) {
  const t = useT();
  const basculer = (chemin: string): void => {
    const dedans = brouillon.outputPaths.includes(chemin);
    maj({ outputPaths: dedans ? brouillon.outputPaths.filter((c) => c !== chemin) : [...brouillon.outputPaths, chemin] });
  };

  return (
    <div className="flex flex-col gap-2">
      {/**
        * 🔴 CE TEXTE DISAIT « LA SEULE PARTIE QUE L'AGENT VERRA », ET C'EST DEVENU FAUX (migration 0150).
        * Ce qu'un agent lit se choisit désormais quand on lui DONNE l'appel, agent par agent : cet écran-ci
        * ne pose plus qu'un DÉFAUT de pré-remplissage. Laisser l'ancienne phrase ferait croire à une
        * garantie que cet écran n'apporte plus, ce qui est pire qu'une phrase absente sur un sujet de fuite
        * de données.
        */}
      <MbaNotice kind="warning">
        {t(
          'Ce que vous cochez ici est le DÉFAUT proposé quand vous donnerez cet appel à un agent : chacun recoche pour lui, et seuls ses champs à lui partent chez le fournisseur du modèle. Changer ce défaut ne touche aucun agent déjà en service.',
          'What you tick here is the DEFAULT offered when you give this call to an agent: each one ticks its own, and only its own fields reach the model provider. Changing this default does not affect any agent already in service.',
        )}
      </MbaNotice>

      {resultat === null && (
        <p className="text-xs text-ink-500" data-testid="reponse-pas-essaye">
          {t('Lancez « Essayer » pour voir ce que votre système répond, puis cochez les champs à garder.', 'Run “Try” to see what your system answers, then tick the fields to keep.')}
        </p>
      )}

      {resultat && !resultat.ok && (
        <MbaNotice kind="error" testid="reponse-echec">{resultat.erreur ?? t('Échec', 'Failed')}</MbaNotice>
      )}

      {resultat?.ok && (
        <>
          <p className="text-xs text-ink-600" data-testid="reponse-statut">
            {t(`HTTP ${resultat.httpStatus} en ${resultat.dureeMs} ms`, `HTTP ${resultat.httpStatus} in ${resultat.dureeMs} ms`)}
          </p>
          {resultat.envoye && (
            <p className="break-all text-[11px] text-ink-500" data-testid="reponse-envoye">
              {resultat.envoye.methode} {resultat.envoye.url}
              {resultat.envoye.corps ? ` ${resultat.envoye.corps}` : ''}
            </p>
          )}
          {/* Les en-têtes PARTIS, variables substituées. Jamais ceux de la source : le serveur ne les rend pas. */}
          {resultat.envoye?.entetes && Object.keys(resultat.envoye.entetes).length > 0 && (
            <p className="break-all font-mono text-[11px] text-ink-500" data-testid="reponse-envoye-entetes">
              {Object.entries(resultat.envoye.entetes).map(([k, v]) => <span key={k} className="block">{k}: {v}</span>)}
            </p>
          )}
          <pre className="max-h-48 overflow-auto rounded-lg bg-ink-50 p-2 text-[11px] text-ink-700" data-testid="reponse-apercu">{resultat.apercu}</pre>
          <div className="flex flex-col gap-1" data-testid="reponse-chemins">
            {(resultat.chemins ?? []).length === 0 ? (
              <p className="text-xs text-ink-500">{t('Aucun champ lisible dans cette réponse.', 'No readable field in this response.')}</p>
            ) : (
              (resultat.chemins ?? []).map((c) => (
                <label key={c} className="flex items-center gap-2 text-xs text-ink-700">
                  <input type="checkbox" data-testid={`chemin-${c}`} checked={brouillon.outputPaths.includes(c)} onChange={() => basculer(c)} />
                  <code>{c}</code>
                </label>
              ))
            )}
          </div>
        </>
      )}

      {brouillon.outputPaths.length > 0 && (
        <p className="text-xs text-ink-600" data-testid="reponse-gardes">
          {t('L’agent lira :', 'The agent will read:')} <code>{brouillon.outputPaths.join(', ')}</code>
        </p>
      )}
    </div>
  );
}
