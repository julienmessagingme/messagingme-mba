'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { getSettings, getAccountStatus, putHubspotChoix, type ChoixHubspot } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { cardCls } from '@/lib/ui';
import { Toggle } from '@/components/Toggle';
import { Bouton } from '@/components/Bouton';
import { useInstallationHubspot } from '@/lib/hubspot-installation';
import { useOffre } from '@/lib/use-offre';
import { etapeHubspot, fermeeParLOffre, phraseDeLOffre, choixParDefaut, choixActuel, corpsDuChoix, choixApresBascule } from '@/lib/hubspot-choix';

/**
 * TOOLS > INTÉGRATIONS > HUBSPOT : le client choisit ce qu'il branche entre Messaging Me et HubSpot (lot 1bis de
 * la reprise humaine, cadrage validé par Julien le 2026-10-23). Remplace l'interrupteur `hubspot_actif` de 0179, qui
 * ne gouvernait que l'affichage (décision 4) : l'Accueil montre le bloc HubSpot dès qu'un portail est relié.
 *
 * TROIS ÉTATS (`etapeHubspot`) : rien de relié, « Connecter HubSpot » ; relié et jamais choisi, L'ÉTAPE DE CHOIX
 * (défauts cochés, bouton « Valider ») ; choisi, un interrupteur par fonction, enregistré à chaque bascule. L'installation
 * se fait dans un AUTRE onglet : l'écran se relit quand la fenêtre reprend le focus, et l'étape de choix apparaît.
 *
 * « Répondre aux clients depuis HubSpot » (lot 3, décision D) : éteint par défaut, ouvert par l'offre qui ouvre l'Inbox.
 * « Envoyer des modèles depuis HubSpot » (sous-lot « relancer », décision E) : éteint par défaut, sous la même offre, et
 * seulement réponse allumée (éteindre la réponse l'éteint, `choixApresBascule`).
 * La raison d'une ligne fermée se lit dans la grille du serveur (`phraseInclusDans`) : la réponse vient avec Pro,
 * l'analyse et les listes avec Entreprise.
 *
 * ⚠️ ADMIN SEULEMENT : cette carte ne vit que dans la page des administrateurs, et la route est gardée par `g.admin`.
 */

type Champ = keyof ChoixHubspot;

export function ReglageHubspot({ tenantId }: { tenantId: string }) {
  const t = useT();
  const offre = useOffre(tenantId);
  const { ouvrir, enCours } = useInstallationHubspot(tenantId, true);
  const [lecture, setLecture] = useState<'en_cours' | 'ok' | 'echec'>('en_cours');
  const [relie, setRelie] = useState<boolean | undefined>(undefined);
  const [valideLe, setValideLe] = useState<string | null | undefined>(undefined);
  const [nomPortail, setNomPortail] = useState<string | null>(null);
  const [listesAutorisees, setListesAutorisees] = useState(false);
  // Le mode des tâches du portail a-t-il été LU ? Sinon la ligne est grisée et le mode n'est jamais envoyé.
  const [modeConnu, setModeConnu] = useState(false);
  const [choix, setChoix] = useState<ChoixHubspot | null>(null);
  const [statut, setStatut] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [erreur, setErreur] = useState<string | null>(null);
  const [tachesNonAppliquees, setTachesNonAppliquees] = useState(false);
  const vivant = useRef(true);
  // Une relecture partie avant un enregistrement ne doit pas écraser ce qu'il a écrit (le retour du focus pendant un
  // enregistrement) : chaque enregistrement change la version, une lecture d'une version périmée est ignorée.
  const version = useRef(0);
  const enregistrementEnCours = useRef(false);
  // L'étape de choix garde ce que l'admin a coché pendant qu'il hésite : une relecture au focus ne l'écrase pas.
  const enEtapeDeChoix = useRef(false);

  const fonctions = offre === undefined ? undefined : (offre?.fonctions ?? null);
  const fonctionsLues = useRef(fonctions);
  fonctionsLues.current = fonctions;

  const lire = useCallback(() => {
    if (enregistrementEnCours.current) return;
    const v = version.current;
    Promise.all([getSettings(tenantId), getAccountStatus(tenantId).catch(() => null)])
      .then(([s, a]) => {
        if (!vivant.current || v !== version.current) return;
        const portail = a?.hubspotPortal;
        const estRelie = typeof s.hubspotPortalConnecte === 'boolean' ? s.hubspotPortalConnecte : undefined;
        const date = s.hubspotChoixValideLe;
        setRelie(estRelie);
        setValideLe(date);
        setNomPortail(portail?.connected ? (portail.hubDomain ?? portail.hubId ?? null) : null);
        setListesAutorisees(portail?.listsScopeGranted === true);
        setModeConnu(portail?.connected === true && portail.routingMode !== undefined);
        if (estRelie && date === null) {
          if (!enEtapeDeChoix.current) setChoix(choixParDefaut({ routingMode: portail?.routingMode, fonctions: fonctionsLues.current }));
          enEtapeDeChoix.current = true;
        } else {
          enEtapeDeChoix.current = false;
          setChoix(choixActuel(s, portail?.routingMode, fonctionsLues.current));
        }
        setLecture('ok');
      })
      .catch(() => { if (vivant.current) setLecture('echec'); });
  }, [tenantId]);

  useEffect(() => {
    vivant.current = true;
    lire();
    // L'installation HubSpot s'est faite dans un autre onglet : au retour, on relit, et l'étape de choix apparaît.
    const auRetour = () => { if (document.visibilityState === 'visible') lire(); };
    window.addEventListener('focus', lire);
    document.addEventListener('visibilitychange', auRetour);
    return () => {
      vivant.current = false;
      window.removeEventListener('focus', lire);
      document.removeEventListener('visibilitychange', auRetour);
    };
  }, [lire]);

  // L'Accueil renvoie ici par `#integration-hubspot` ; la page ne rend ses cartes qu'après sa propre lecture.
  useEffect(() => {
    if (lecture !== 'en_cours' && window.location.hash === '#integration-hubspot') document.getElementById('integration-hubspot')?.scrollIntoView();
  }, [lecture]);

  // Une fonction fermée par l'offre ne se lit jamais allumée, quel que soit l'ordre des lectures (l'offre peut
  // arriver après les réglages) : à l'étape de choix elle n'est pas proposée cochée, ensuite elle se lit éteinte.
  useEffect(() => {
    if (!fonctions) return;
    setChoix((c) => (c ? {
      ...c,
      analyse: c.analyse && !fermeeParLOffre('analyse', fonctions),
      reponse: c.reponse && !fermeeParLOffre('reponse', fonctions),
      modeles: c.modeles && c.reponse && !fermeeParLOffre('modeles', fonctions),
      listes: c.listes && !fermeeParLOffre('listes', fonctions),
    } : c));
  }, [fonctions]);

  const etape = etapeHubspot({ lecture, relie, valideLe });

  const enregistrer = useCallback((suivant: ChoixHubspot, precedent: ChoixHubspot | null, envoyerTaches: boolean) => {
    setStatut('saving');
    setErreur(null);
    version.current += 1;
    enregistrementEnCours.current = true;
    putHubspotChoix(tenantId, corpsDuChoix(suivant, { envoyerTaches }))
      .then((r) => {
        enregistrementEnCours.current = false;
        if (!vivant.current) return;
        enEtapeDeChoix.current = false;
        setValideLe(r.hubspotChoixValideLe);
        setChoix({
          analyse: r.hubspotAnalyse, passage: r.hubspotPassage, injoignable: r.hubspotInjoignable, reponse: r.hubspotReponse,
          modeles: r.hubspotModeles === true,
          listes: r.hubspotListsEnabled,
          // Le mode posé par cette requête ; non demandé, le mode affiché ne bouge pas ; demandé et non posé, la ligne
          // revient à ce qu'elle était (l'avertissement le dit).
          taches: r.routingMode !== null ? r.routingMode === 'mm_routing' : r.tachesAppliquees ? suivant.taches : (precedent?.taches ?? suivant.taches),
        });
        setTachesNonAppliquees(!r.tachesAppliquees);
        setStatut('saved');
      })
      .catch((e: unknown) => {
        enregistrementEnCours.current = false;
        if (!vivant.current) return;
        if (precedent) setChoix(precedent);
        setStatut('error');
        setErreur(e instanceof Error ? e.message : t('Enregistrement impossible', 'Unable to save'));
      });
  }, [tenantId, t]);

  const basculer = (champ: Champ) => {
    if (!choix || statut === 'saving') return;
    const suivant = choixApresBascule(choix, champ);
    if (etape === 'choisir') { setChoix(suivant); return; }
    setChoix(suivant);
    enregistrer(suivant, choix, champ === 'taches');
  };

  const lignes: Array<{ champ: Champ; titre: string; detail: string }> = [
    {
      champ: 'analyse',
      titre: t('Fiche contact et analyse de chaque conversation', 'Contact record and analysis of every conversation'),
      detail: t('Messaging Me crée ou met à jour le contact dans HubSpot, avec le sentiment, l’intention et l’action suggérée.', 'Messaging Me creates or updates the contact in HubSpot, with the sentiment, the intent and the suggested action.'),
    },
    {
      champ: 'passage',
      titre: t('Tâche immédiate quand un client demande un humain', 'Immediate task when a customer asks for a human'),
      detail: t('Dans la minute, une tâche au propriétaire du contact, avec le lien vers la conversation.', 'Within a minute, a task for the contact owner, with the link to the conversation.'),
    },
    {
      champ: 'taches',
      titre: t('Créer des tâches dans HubSpot', 'Create tasks in HubSpot'),
      detail: t('Éteint, Messaging Me n’écrit que les propriétés du contact, pour vos propres workflows HubSpot. Ce réglage vaut pour tout le portail HubSpot.', 'Off, Messaging Me only writes the contact properties, for your own HubSpot workflows. This setting applies to the whole HubSpot portal.'),
    },
    {
      champ: 'injoignable',
      titre: t('Contact injoignable sur WhatsApp', 'Contact unreachable on WhatsApp'),
      detail: t('La fiche est marquée quand un message ne peut plus parvenir au contact.', 'The record is flagged when messages can no longer reach the contact.'),
    },
    {
      champ: 'reponse',
      titre: t('Répondre aux clients depuis HubSpot', 'Reply to customers from HubSpot'),
      detail: t('Toute personne du portail répond depuis la carte Messaging Me de la fiche contact, signée de son adresse, tant que la fenêtre de 24 heures est ouverte. Jamais à un contact qui a dit STOP.', 'Anyone on the portal replies from the Messaging Me card on the contact record, signed with their address, while the 24-hour window is open. Never to a contact who said STOP.'),
    },
    {
      champ: 'modeles',
      titre: t('Envoyer des modèles depuis HubSpot', 'Send templates from HubSpot'),
      detail: t('Une fois la fenêtre de 24 heures fermée, la carte propose vos modèles approuvés. Un modèle Marketing ne part qu’à un contact qui a donné son accord, et rien ne part à un contact qui a dit STOP. Meta facture chaque modèle.', 'Once the 24-hour window has closed, the card offers your approved templates. A Marketing template only goes to a contact who has agreed, and nothing goes to a contact who said STOP. Meta charges for each template.'),
    },
    {
      champ: 'listes',
      titre: t('Vos listes HubSpot comme audience de campagne', 'Your HubSpot lists as a campaign audience'),
      detail: t('Importez une liste HubSpot comme destinataires d’une campagne.', 'Import a HubSpot list as campaign recipients.'),
    },
  ];

  const libelle = statut === 'saving' ? t('enregistrement…', 'saving…') : statut === 'saved' ? t('enregistré', 'saved') : '';

  return (
    <section id="integration-hubspot" className={cardCls} data-testid="integration-hubspot">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-ink-900">HubSpot</h3>
          <p className="mt-1 text-sm text-ink-500" data-testid="integration-hubspot-etat">
            {etape === 'lecture' && t('Lecture…', 'Loading…')}
            {etape === 'echec' && t('État inconnu : la lecture a échoué.', 'Unknown state: the read failed.')}
            {etape === 'connecter' && t('Aucun portail HubSpot relié.', 'No HubSpot portal linked.')}
            {(etape === 'choisir' || etape === 'regle') && (nomPortail
              ? t(`Relié au portail ${nomPortail}.`, `Linked to portal ${nomPortail}.`)
              : t('Relié à un portail HubSpot.', 'Linked to a HubSpot portal.'))}
          </p>
        </div>
        <span className="shrink-0 text-xs text-ink-500">{libelle}</span>
      </div>

      {etape === 'connecter' && (
        <div className="mt-4">
          <p className="text-sm text-ink-500">
            {t('Après la connexion, revenez ici : vous choisirez ce que vous branchez entre Messaging Me et HubSpot.', 'After connecting, come back here: you will choose what you connect between Messaging Me and HubSpot.')}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Bouton type="button" data-testid="integration-hubspot-connecter" onClick={() => void ouvrir()} disabled={enCours}>
              {t('Connecter HubSpot', 'Connect HubSpot')}
            </Bouton>
            <a href="/tuto-hubspot" target="_blank" rel="noopener noreferrer" data-testid="integration-hubspot-tuto" className="text-sm text-brand-600 hover:underline">
              {t('Le pas à pas (tuto)', 'Step by step (guide)')}
            </a>
          </div>
        </div>
      )}

      {(etape === 'choisir' || etape === 'regle') && choix && (
        <div className="mt-4">
          {etape === 'choisir' && (
            <p className="text-sm font-semibold text-ink-900" data-testid="integration-hubspot-etape-choix">
              {t('Choisissez ce que vous branchez', 'Choose what you connect')}
            </p>
          )}
          <ul className="mt-2 divide-y divide-ink-50">
            {lignes.map((l) => {
              const fermee = fermeeParLOffre(l.champ, fonctions);
              return (
                <li key={l.champ} className="flex items-start justify-between gap-3 py-3" data-testid={`integration-hubspot-${l.champ}`}>
                  <div className="min-w-0">
                    <div className="text-sm text-ink-900">{l.titre}</div>
                    <p className="mt-0.5 text-xs text-ink-500">{l.detail}</p>
                    {l.champ === 'taches' && !modeConnu && (
                      <p className="mt-0.5 text-xs text-ink-500">{t('Réglage indisponible pour le moment : rechargez la page.', 'Setting unavailable right now: reload the page.')}</p>
                    )}
                    {l.champ === 'modeles' && !choix.reponse && (
                      <p className="mt-0.5 text-xs text-ink-500" data-testid="integration-hubspot-modeles-sans-reponse">{t('Allumez d’abord « Répondre aux clients depuis HubSpot ».', 'First turn on “Reply to customers from HubSpot”.')}</p>
                    )}
                    {fermee && offre && (
                      <p className="mt-0.5 text-xs text-ink-500" data-testid={`integration-hubspot-${l.champ}-offre`}>{phraseDeLOffre(offre, l.champ, t)}</p>
                    )}
                    {l.champ === 'listes' && choix.listes && !listesAutorisees && (
                      <button
                        type="button"
                        onClick={() => void ouvrir('lists')}
                        disabled={enCours}
                        className="mt-2 text-sm text-brand-600 hover:underline disabled:opacity-60"
                      >
                        {t('Autoriser l’accès aux listes HubSpot', 'Authorize access to HubSpot lists')}
                      </button>
                    )}
                  </div>
                  <Toggle
                    testid={`integration-hubspot-${l.champ}-toggle`}
                    libelle={l.titre}
                    checked={choix[l.champ]}
                    onChange={() => basculer(l.champ)}
                    // Fermée par l'offre : on peut l'éteindre, jamais l'allumer. « Créer des tâches » dont le mode n'a pas
                    // pu être lu : grisé, jamais réécrit à l'aveugle.
                    disabled={statut === 'saving' || (fermee && !choix[l.champ]) || (l.champ === 'taches' && !modeConnu) || (l.champ === 'modeles' && !choix.reponse)}
                  />
                </li>
              );
            })}
          </ul>

          {etape === 'choisir' && (
            <div className="mt-3">
              <Bouton type="button" data-testid="integration-hubspot-valider" onClick={() => enregistrer(choix, null, modeConnu)} disabled={statut === 'saving'}>
                {t('Valider', 'Confirm')}
              </Bouton>
            </div>
          )}

          {tachesNonAppliquees && (
            <p className="mt-3 text-sm text-danger" role="alert" data-testid="integration-hubspot-taches-non-appliquees">
              {t('Le réglage « Créer des tâches dans HubSpot » n’a pas pu être appliqué : réessayez dans un moment.', 'The “Create tasks in HubSpot” setting could not be applied: try again in a moment.')}
            </p>
          )}

          <div className="mt-4 space-y-1 border-t border-ink-50 pt-3 text-sm text-ink-500">
            <p>
              {t('Un changement d’étape de deal qui envoie un message WhatsApp se règle dans', 'A deal stage change that sends a WhatsApp message is set up in')}{' '}
              <Link href="/automations" className="text-brand-600 hover:underline">{t('Automations', 'Automations')}</Link>.
            </p>
            <p>
              {t('Dans HubSpot, placez la carte Messaging Me sur la fiche contact : Paramètres > Objets > Contacts > Personnalisation des fiches.', 'In HubSpot, add the Messaging Me card to the contact record: Settings > Objects > Contacts > Record customization.')}{' '}
              <a href="/tuto-hubspot" target="_blank" rel="noopener noreferrer" className="text-brand-600 hover:underline">{t('Le tuto', 'The guide')}</a>
            </p>
          </div>
        </div>
      )}

      {erreur && <p className="mt-3 text-sm text-danger" data-testid="integration-hubspot-erreur">{erreur}</p>}
    </section>
  );
}
