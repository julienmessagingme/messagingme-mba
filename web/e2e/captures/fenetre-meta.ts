import type { Locale } from './donnees-demo';

/**
 * LA FENÊTRE DE META, SOUS SA FORME GÉNÉRIQUE (spec du centre d'aide, « L'espace de démo et les captures »). Elle n'est
 * pas la nôtre et ne se simule pas : la page la montre comme le film du démarrage (`~/engageme-motion`,
 * `engageme-cas-onboarding`, dont les styles et les textes sont repris ici), une fenêtre « Meta » sans logo ni marque,
 * en trois étapes côte à côte : le portefeuille, le numéro, le code. La marque et le numéro sont ceux de l'espace de
 * démonstration, le numéro dans la plage réservée à la fiction.
 */
const TEXTES: Readonly<Record<Locale, Record<string, string>>> = {
  fr: {
    portefeuille: 'Choisissez votre portefeuille business', autre: 'Créer un portefeuille',
    numero: 'Ajoutez un numéro de téléphone', sms: 'SMS', appel: 'Appel',
    code: 'Saisissez le code de vérification', continuer: 'Continuer', terminer: 'Terminer',
  },
  en: {
    portefeuille: 'Choose your business portfolio', autre: 'Create a portfolio',
    numero: 'Add a phone number', sms: 'Text message', appel: 'Phone call',
    code: 'Enter the verification code', continuer: 'Continue', terminer: 'Finish',
  },
};
const MARQUE = 'Votre marque';
const NUMERO = '+33 6 39 98 01 00';
const CODE = '482913';

const STYLE = `
:root{--ink-900:#0B0E24}
html,body{margin:0;width:1280px;height:800px;background:#F4F5F9;font-family:system-ui,"Segoe UI",sans-serif}
.scene{height:800px;display:flex;align-items:center;justify-content:center;gap:18px}
.fleche{width:38px;height:38px;color:#4A507A}
.fen{zoom:.56;position:relative;width:640px;height:560px;border-radius:14px;overflow:hidden;background:#FFFFFF;color:#1C1E21;
  box-shadow:0 0 0 1px rgb(0 0 0 / .12),0 40px 80px -30px rgb(11 14 36 / .45)}
.nav-barre{display:flex;align-items:center;gap:9px;height:46px;padding:0 16px;background:#ECECEF;border-bottom:1px solid #D9D9DE}
.nav-barre i{width:13px;height:13px;border-radius:50%}
.nav-barre i:nth-child(1){background:#FF5F57}.nav-barre i:nth-child(2){background:#FEBC2E}.nav-barre i:nth-child(3){background:#28C840}
.nav-barre span{flex:1;text-align:center;margin-right:58px;font-size:16px;font-weight:600;line-height:1;color:#4B5563}
.mcorps{position:relative;height:514px;padding:26px 34px 30px;box-sizing:border-box}
.mbarres{display:flex;gap:8px}
.mbarres i{flex:1;height:6px;border-radius:3px;background:#E4E6EB}
.mbarres i.on{background:var(--ink-900)}
.mstep{position:absolute;left:34px;right:34px;top:66px}
.mstep h4{margin:0 0 20px;font-size:25px;line-height:1.25;font-weight:700}
.mradio{display:flex;align-items:center;gap:14px;height:60px;padding:0 18px;margin-bottom:12px;border-radius:10px;border:1.5px solid #DADDE1;font-size:20px;font-weight:500}
.mradio i{flex:none;width:22px;height:22px;border-radius:50%;border:2px solid #8A8D91;box-sizing:border-box}
.mradio.on{border-color:var(--ink-900)}
.mradio.on i{border-color:var(--ink-900);background:var(--ink-900);box-shadow:inset 0 0 0 4px #FFFFFF}
.mchamp{display:flex;align-items:center;height:60px;padding:0 18px;border-radius:10px;border:1.5px solid var(--ink-900);font-size:23px;font-weight:500;letter-spacing:.02em}
.mchoix{display:flex;gap:30px;margin:18px 0 0;font-size:19px;font-weight:500;color:#606770}
.mchoix b{color:var(--ink-900)}
.mcode{display:flex;gap:12px}
.mcode i{display:grid;place-items:center;width:70px;height:82px;border-radius:10px;border:1.5px solid #DADDE1;font-size:36px;font-weight:700;font-style:normal;color:var(--ink-900)}
.mbtn{position:absolute;right:34px;bottom:30px;padding:16px 32px;border-radius:10px;background:var(--ink-900);color:#FFFFFF;font-size:20px;font-weight:600}
`;

const echapper = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function fenetre(etape: 1 | 2 | 3, t: Record<string, string>): string {
  const barres = [1, 2, 3].map((n) => `<i class="${n <= etape ? 'on' : ''}"></i>`).join('');
  const corps = etape === 1
    ? `<h4>${echapper(t.portefeuille)}</h4><span class="mradio on"><i></i>${MARQUE}</span><span class="mradio"><i></i>${echapper(t.autre)}</span>`
    : etape === 2
      ? `<h4>${echapper(t.numero)}</h4><span class="mchamp">${NUMERO}</span><p class="mchoix"><b>● ${echapper(t.sms)}</b><span>○ ${echapper(t.appel)}</span></p>`
      : `<h4>${echapper(t.code)}</h4><div class="mcode">${[...CODE].map((c) => `<i>${c}</i>`).join('')}</div>`;
  return `<div class="fen"><div class="nav-barre"><i></i><i></i><i></i><span>Meta</span></div><div class="mcorps">`
    + `<div class="mbarres">${barres}</div><div class="mstep">${corps}</div>`
    + `<span class="mbtn">${echapper(etape === 3 ? t.terminer : t.continuer)}</span></div></div>`;
}

const FLECHE = '<svg class="fleche" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';

/** La page complète, au format des captures (1280 × 800). */
export function fenetreMeta(locale: Locale): string {
  const t = TEXTES[locale];
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><style>${STYLE}</style></head><body>`
    + `<div class="scene">${fenetre(1, t)}${FLECHE}${fenetre(2, t)}${FLECHE}${fenetre(3, t)}</div></body></html>`;
}
