import { parse as secureJsonParse } from 'secure-json-parse';
import type { ChatMessage, ChatMessageImage, OutilExpose, ReponseChat } from '../llm/chat-client';
import type { IssueImportEntretien } from '../connaissance';
import {
  budgetOuvert, MESSAGE_PLAFOND, noterDepense, type BudgetAssistantDeps,
} from '../../assistant/budget';
import { direPanneModele } from '../../llm/errors';
import { journaliser } from '../../lib/journal';
import { avancementEntretien, type AvancementEntretien } from './avancement';
import { construireMessages, inventaireDe, type ContexteConstruction } from './conversation';
import {
  actionChoisie, basculesDuTour, fusionner, fusionnerBascules, momentDuPoint, momentsDesReponses,
  poseUneQuestion, prochainPoint, urlDeConnaissance,
} from './couverture';
import {
  bornerPourModele, ENTRETIEN_VIERGE, type EntretienComplet, type EntretienStore, type TourEntretien,
} from './entretien-store';
import { blocDeFin } from './fin';
import {
  assainirProposition, brancheables, differences, propositionSchema, OUTIL_PROPOSER, SCHEMA_PROPOSITION,
  type Changement, type Proposition,
} from './proposition';
import {
  champScenario, MOYEN_DECRIT_PAR_LE_CLIENT, scenarioDuMoyen, scenariosAPoser, scenariosDesMoments,
  situationDuMoment, type ScenarioAPoser, type ScenarioEnLigne,
} from './scenarios';

const DELAI_MS = 45_000;

export interface CommandeTourEntretien {
  tenantId: string;
  agentId: string;
  auteurId: string | null;
  /** Message déjà validé et borné par l'adaptateur HTTP. */
  message: string;
  /** Instantané déjà chargé sous le tenant authentifié ; le module ne le mute pas. */
  contexte: Readonly<ContexteConstruction>;
}

export interface PropositionAffichee {
  fiche: NonNullable<Proposition['fiche']>;
  outils: NonNullable<Proposition['outils']>;
  connecteurs: NonNullable<Proposition['connecteurs']>;
  outilsBranches: string[];
  outilsDebranches: string[];
  scenarios?: ScenarioAPoser[];
}

export interface ReponseTourEntretien {
  message: string;
  couverture: AvancementEntretien;
  proposition: PropositionAffichee;
  changements: Changement[];
  usage: { tokensIn: number; tokensOut: number };
}

export interface ReponseBudgetEpuise extends ReponseTourEntretien {
  budgetEpuise: true;
  ongletsUtilisables: true;
}

export type ResultatTourEntretien =
  | { issue: 'repondu'; reponse: ReponseTourEntretien }
  | { issue: 'budget_epuise'; reponse: ReponseBudgetEpuise }
  | { issue: 'assistant_indisponible' }
  | { issue: 'modele_en_panne'; raison: string }
  | { issue: 'proposition_absente' }
  | { issue: 'proposition_illisible' }
  | { issue: 'proposition_hors_format' };

export interface TourEntretienDeps extends BudgetAssistantDeps {
  /** La mémoire du fil. L'écriture ne porte jamais l'état de l'agent lui-même. */
  entretiens: Pick<EntretienStore, 'lire' | 'ecrire'>;
  /** Scénarios réellement en ligne, seuls choix que le tour peut proposer. */
  scenariosEnLigne(tenantId: string): Promise<ScenarioEnLigne[]>;
  /** Import détaché de l'adresse retenue ; le module ne le lance qu'après la persistance. */
  importerSiteDeLEntretien(tenantId: string, agentId: string, url: string): Promise<IssueImportEntretien>;
  completer?(input: {
    tenantId: string;
    modele: string;
    messages: Array<ChatMessage | ChatMessageImage>;
    outils: OutilExpose[];
    toolChoice: string;
    signal: AbortSignal;
  }): Promise<ReponseChat>;
  modele: string;
}

export interface TourEntretienAgent {
  /** Préserve la priorité du 503 actuel sur la validation du corps HTTP. */
  readonly indisponibilite: 'modele_non_configure' | null;
  executer(commande: CommandeTourEntretien): Promise<ResultatTourEntretien>;
}

const propositionVide = (): PropositionAffichee => ({
  fiche: {}, outils: [], connecteurs: [], outilsBranches: [], outilsDebranches: [],
});

/**
 * Possède le cycle complet d'un message de l'entretien. L'adaptateur appelant ne choisit ni l'ordre des
 * lectures et écritures, ni le moment des appels modèle, de la comptabilisation ou de l'import du site.
 */
export function creerTourEntretien(deps: TourEntretienDeps): TourEntretienAgent {
  const indisponibilite = !deps.completer || deps.modele.trim() === '' ? 'modele_non_configure' : null;
  const appelerProposition = (tenantId: string, messages: Array<ChatMessage | ChatMessageImage>) => deps.completer!({
    tenantId,
    modele: deps.modele,
    messages,
    outils: [{
      name: OUTIL_PROPOSER,
      description: 'Rends ta réponse et, si tu en as une, ta proposition de réglage.',
      parameters: SCHEMA_PROPOSITION,
    }],
    toolChoice: OUTIL_PROPOSER,
    signal: AbortSignal.timeout(DELAI_MS),
  });

  return {
    indisponibilite,
    async executer(commande): Promise<ResultatTourEntretien> {
      if (indisponibilite || !deps.completer) return { issue: 'assistant_indisponible' };

      const contexte: ContexteConstruction = {
        ...commande.contexte,
        scenarios: await deps.scenariosEnLigne(commande.tenantId),
      };
      const avant = (await deps.entretiens.lire(commande.tenantId, commande.agentId)) ?? ENTRETIEN_VIERGE;
      // Le fil complet est conservé ; seule sa copie destinée au modèle est bornée.
      const filComplet: TourEntretien[] = [...avant.messages, { role: 'user', content: commande.message }];
      const auteursComplets: Array<string | null> = [...avant.auteurs, commande.auteurId];
      const historique = bornerPourModele(filComplet);
      const pointDuTour = prochainPoint(avant, inventaireDe(contexte));

      if (!(await budgetOuvert(deps, commande.tenantId))) {
        return {
          issue: 'budget_epuise',
          reponse: {
            message: MESSAGE_PLAFOND,
            couverture: avancementEntretien(avant, contexte),
            proposition: propositionVide(),
            changements: [],
            budgetEpuise: true,
            ongletsUtilisables: true,
            usage: { tokensIn: 0, tokensOut: 0 },
          },
        };
      }

      let reponse: ReponseChat;
      try {
        reponse = await appelerProposition(
          commande.tenantId,
          construireMessages(contexte, historique, avant),
        );
      } catch (err) {
        const raison = direPanneModele(err);
        if (raison === null) throw err;
        journaliser('error', 'agent_setup_tour_echec', { tenantId: commande.tenantId, err });
        return { issue: 'modele_en_panne', raison };
      }

      // L'appel est payé même si sa sortie est ensuite absente ou invalide.
      await noterDepense(deps, commande.tenantId, reponse.usage.coutDollars);
      const appel = reponse.appelsOutils.find((a) => a.nom === OUTIL_PROPOSER);
      if (!appel) return { issue: 'proposition_absente' };

      let brut: unknown;
      try {
        brut = secureJsonParse(appel.argumentsJson);
      } catch {
        return { issue: 'proposition_illisible' };
      }
      const propose = propositionSchema.safeParse(assainirProposition(brut));
      if (!propose.success) {
        journaliser('warn', 'agent_setup_proposition_hors_schema', {
          tenantId: commande.tenantId,
          agentId: commande.agentId,
          champs: propose.error.issues.map((i) => `${i.path.join('.') || '(racine)'}:${i.code}`),
        });
        return { issue: 'proposition_hors_format' };
      }

      const reponses = fusionner(avant.reponses, propose.data.reponses);
      // Le modèle range parfois les moments dans les réponses. On ne les reprend qu'au tour qui les demande,
      // et seulement si aucune liste n'existe encore, sinon une reformulation ferait naître des doublons.
      const reprendreDesReponses = pointDuTour?.collecteDesMoments === true
        && (propose.data.bascules ?? []).length === 0 && (avant.bascules ?? []).length === 0;
      const basculesProposees = reprendreDesReponses
        ? momentsDesReponses(propose.data.reponses)
        : basculesDuTour(avant.bascules ?? [], propose.data.bascules ?? [], pointDuTour);
      const listeBascules = fusionnerBascules(avant.bascules ?? [], basculesProposees);

      const vise = momentDuPoint(pointDuTour?.code);
      const momentVise = vise?.quoi === 'action' ? listeBascules[vise.index] : undefined;
      if (momentVise && !momentVise.action) {
        const choisie = actionChoisie(commande.message);
        if (choisie) momentVise.action = choisie;
      }

      const scenariosEnLigne = contexte.scenarios ?? [];
      const nomme = scenarioDuMoyen(commande.message, scenariosEnLigne);
      const reconnu = (moyen: string | undefined) => (moyen ? scenarioDuMoyen(moyen, scenariosEnLigne) : null);
      const sansScenario = listeBascules.filter((b) => b.action === 'scenario' && reconnu(b.moyen) === null);
      // Le nom exact vient du message du client : une paraphrase du modèle ne doit pas changer le scénario retenu.
      listeBascules.forEach((b, i) => {
        if (b.action !== 'scenario') return;
        const ancien = (avant.bascules ?? [])[i];
        const prisDuModele = reconnu(b.moyen);
        const pourCeMoment = vise?.index === i
          || (nomme !== null && prisDuModele?.id === nomme.id)
          || (sansScenario.length === 1 && sansScenario[0] === b && Boolean(b.moyen?.trim())
            && b.moyen !== ancien?.moyen && reconnu(ancien?.moyen) === null);
        if (nomme && pourCeMoment) {
          b.moyen = nomme.nom;
          return;
        }
        if (ancien?.moyen && b.moyen !== ancien.moyen && reconnu(ancien.moyen)) b.moyen = ancien.moyen;
      });

      const momentDuMoyen = vise?.quoi === 'moyen' ? listeBascules[vise.index] : undefined;
      // Au second passage, une description libre ferme le point sans devenir un faux nom de scénario.
      if (momentDuMoyen && !momentDuMoyen.moyen?.trim() && pointDuTour && avant.poses.includes(pointDuTour.code)) {
        momentDuMoyen.moyen = MOYEN_DECRIT_PAR_LE_CLIENT;
      }
      const poses = pointDuTour && !avant.poses.includes(pointDuTour.code)
        ? [...avant.poses, pointDuTour.code]
        : avant.poses;

      const ouvertApres = prochainPoint({ poses, reponses, bascules: listeBascules }, inventaireDe(contexte));
      const relance = ouvertApres && !poseUneQuestion(propose.data.message) ? ouvertApres : null;
      const posesApres = relance && !poses.includes(relance.code) ? [...poses, relance.code] : poses;
      const etatApres: EntretienComplet = {
        messages: filComplet,
        auteurs: auteursComplets,
        reponses,
        bascules: listeBascules,
        poses: posesApres,
      };
      const suivi = avancementEntretien(etatApres, contexte);
      const enEntretien = suivi.manquants.length > 0;

      let propositionFinale = propose.data;
      let message = relance ? `${propose.data.message}\n\n${relance.question}` : propose.data.message;
      let tokensIn = reponse.usage.tokensIn;
      let tokensOut = reponse.usage.tokensOut;
      const vientDeFinir = !enEntretien && avancementEntretien(avant, contexte).manquants.length > 0;

      // La synthèse ne tourne que sur la transition vers « couvert ». Une panne attendue du fournisseur ou une
      // sortie invalide garde la première proposition ; une panne interne de budget ou de stockage remonte.
      if (vientDeFinir && await budgetOuvert(deps, commande.tenantId)) {
        let seconde: ReponseChat | null = null;
        try {
          seconde = await appelerProposition(
            commande.tenantId,
            construireMessages(contexte, historique, etatApres, { synthese: true }),
          );
        } catch (err) {
          const raison = direPanneModele(err);
          if (raison === null) throw err;
          journaliser('warn', 'agent_setup_synthese_echec', { tenantId: commande.tenantId, agentId: commande.agentId, err });
        }

        if (seconde) {
          await noterDepense(deps, commande.tenantId, seconde.usage.coutDollars);
          tokensIn += seconde.usage.tokensIn;
          tokensOut += seconde.usage.tokensOut;
          const appelSynthese = seconde.appelsOutils.find((a) => a.nom === OUTIL_PROPOSER);
          if (appelSynthese) {
            let brutSynthese: unknown;
            try {
              brutSynthese = secureJsonParse(appelSynthese.argumentsJson);
            } catch (err) {
              if (!(err instanceof SyntaxError)) throw err;
              journaliser('warn', 'agent_setup_synthese_echec', {
                tenantId: commande.tenantId, agentId: commande.agentId, err: err.name,
              });
            }
            if (brutSynthese !== undefined) {
              const proposeSynthese = propositionSchema.safeParse(assainirProposition(brutSynthese));
              if (proposeSynthese.success) {
                propositionFinale = proposeSynthese.data;
                message = proposeSynthese.data.message;
              } else {
                journaliser('warn', 'agent_setup_synthese_hors_schema', {
                  tenantId: commande.tenantId,
                  agentId: commande.agentId,
                  champs: proposeSynthese.error.issues.map((i) => `${i.path.join('.') || '(racine)'}:${i.code}`),
                });
              }
            }
          }
        }
      }

      const adresseRetenue = propositionFinale.connaissanceUrl ?? avant.connaissanceUrl;
      const importLance = Boolean(adresseRetenue && adresseRetenue !== avant.connaissanceUrl);
      if (adresseRetenue && importLance) {
        message = `${message}\n\nJ’importe les pages de ${adresseRetenue} dans votre base de connaissance : elles seront `
          + 'dans l’onglet « Base de connaissance » d’ici une minute, à relire et corriger si besoin.';
      }

      const vises = new Set(contexte.outils.flatMap((o) => (
        o.handler === 'lancer_scenario' && o.workflowId ? [o.workflowId] : []
      )));
      const desMoments = enEntretien ? [] : scenariosDesMoments(listeBascules, contexte.scenarios ?? [], vises);
      const aPoser = scenariosAPoser(desMoments);
      const changements = enEntretien ? [] : [
        ...differences(contexte, propositionFinale),
        ...aPoser.map((s) => ({
          champ: champScenario(s.workflowId),
          label: `Outil « Lancer un scénario » : ${s.nom}, dès que le contact…`,
          avant: '',
          apres: situationDuMoment(s.moment),
        })),
      ];

      if (vientDeFinir) {
        const inventaire = inventaireDe(contexte);
        message = `${message}\n\n${blocDeFin({
          aAppliquer: changements.length > 0,
          connaissanceUrl: propositionFinale.connaissanceUrl ?? avant.connaissanceUrl ?? urlDeConnaissance(etatApres),
          fichesDeConnaissance: contexte.titresConnaissance.length,
          bascules: listeBascules,
          outilsApi: inventaire.outilsApi.length,
          outilsMcp: inventaire.outilsMcp.length,
          modele: contexte.modele ?? null,
          importEnCours: importLance,
          scenarios: desMoments,
        })}`;
      }

      const apres: EntretienComplet = {
        messages: [...filComplet, { role: 'assistant', content: message }],
        auteurs: [...auteursComplets, null],
        reponses,
        bascules: listeBascules,
        poses: posesApres,
        ...(adresseRetenue ? { connaissanceUrl: adresseRetenue } : {}),
      };
      // L'annonce d'import n'est vraie que pour un tour effectivement conservé.
      await deps.entretiens.ecrire(commande.tenantId, commande.agentId, apres);

      if (adresseRetenue && importLance) {
        void deps.importerSiteDeLEntretien(commande.tenantId, commande.agentId, adresseRetenue)
          .then((r) => journaliser(r.issue === 'refuse' ? 'warn' : 'info', 'agent_setup_import_site', {
            tenantId: commande.tenantId, agentId: commande.agentId, ...r,
          }))
          .catch((err) => journaliser('error', 'agent_setup_import_site_echec', {
            tenantId: commande.tenantId, agentId: commande.agentId, err,
          }));
      }

      return {
        issue: 'repondu',
        reponse: {
          message,
          couverture: suivi,
          proposition: enEntretien ? propositionVide() : {
            fiche: propositionFinale.fiche ?? {},
            outils: propositionFinale.outils ?? [],
            connecteurs: (propositionFinale.connecteurs ?? [])
              .filter((c) => (contexte.connecteurs ?? []).some((x) => x.nom === c.nom)),
            outilsBranches: brancheables(contexte.catalogue, propositionFinale.outilsBranches, false),
            outilsDebranches: brancheables(contexte.catalogue, propositionFinale.outilsDebranches, true),
            scenarios: aPoser,
          },
          changements,
          usage: { tokensIn, tokensOut },
        },
      };
    },
  };
}
