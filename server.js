import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import OpenAI from 'openai';

const app = express();

/* ----------------------- CONFIG ----------------------- */
const CFG = {
  port: Number(process.env.PORT || 3000),
  openaiKey: process.env.OPENAI_API_KEY,
  air: {
    base: process.env.AIRTABLE_BASE_ID,
    url: process.env.AIRTABLE_API_URL || 'https://api.airtable.com/v0',
    token: process.env.AIRTABLE_TOKEN, // (kod tebe se zove AIRTABLE_TOKEN)
  },
  baseUrl: process.env.BASE_URL || 'https://ai-simmer-konoba-more.onrender.com',
  corsOrigins: [
    'https://konobamore.com',
    'https://www.konobamore.com',
    'https://pressmax.net',
    'https://ai.pressmax.net',
    'https://ai-simmer-konoba-more.onrender.com',
    'http://localhost:3000',
    'http://localhost:5173',
  ],
};

// Osnovne provjere (da se lakše uhvate krive varijable)
function assertEnv() {
  const miss = [];
  if (!CFG.openaiKey) miss.push('OPENAI_API_KEY');
  if (!CFG.air.token) miss.push('AIRTABLE_TOKEN');
  if (!CFG.air.base) miss.push('AIRTABLE_BASE_ID');
  if (miss.length) console.error('[ENV] Missing:', miss.join(', '));
}
assertEnv();

/* ----------------------- MIDDLEWARE ----------------------- */
app.use(express.json({ limit: '1mb' }));
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      const ok = CFG.corsOrigins.some((o) =>
        origin.endsWith(o.replace('https://', '').replace('http://', ''))
      );
      return cb(null, ok);
    },
    methods: ['POST', 'GET', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

/* ----------------------- HELPERS ----------------------- */
// EUR format (broj -> "12.50 €"), tolerira "12,50" ili "12 €" iz baze
const asNumber = (v) => {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  const cleaned = String(v).replace(/[^\d,.\-]/g, '').replace(',', '.');
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
};
const eur = (v) => {
  const n = asNumber(v);
  return n == null ? null : `${n.toFixed(2)} €`;
};
const bulletList = (rows, mapFn) =>
  rows
    .map((r) => mapFn(r))
    .filter(Boolean)
    .map((s) => `• ${s}`)
    .join('\n');

async function airtableList(table, { view, slug } = {}) {
  const url = new URL(`${CFG.air.url}/${CFG.air.base}/${encodeURIComponent(table)}`);
  if (view) url.searchParams.set('view', view);
  if (slug) url.searchParams.set('filterByFormula', `{RestoranSlug}='${slug}'`);
  url.searchParams.set('pageSize', '100');

  const res = await fetch(url, { headers: { Authorization: `Bearer ${CFG.air.token}` } });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Airtable ${table} -> ${res.status}${txt ? `: ${txt}` : ''}`);
  }
  const json = await res.json();
  return (json.records || []).map((r) => ({ id: r.id, ...r.fields }));
}

async function loadRestaurantBundle(slug) {
  // RESTORANI (osnovne info)
  const rurl = new URL(`${CFG.air.url}/${CFG.air.base}/RESTORANI`);
  rurl.searchParams.set('filterByFormula', `{slug}='${slug}'`);
  rurl.searchParams.set('maxRecords', '1');
  const rres = await fetch(rurl, { headers: { Authorization: `Bearer ${CFG.air.token}` } });
  if (!rres.ok) {
    const tx = await rres.text().catch(() => '');
    throw new Error(`Airtable RESTORANI -> ${rres.status}${tx ? `: ${tx}` : ''}`);
  }
  const rjson = await rres.json();
  const rest = rjson.records?.[0]?.fields || null;

  // Ostale tablice – zasad "Grid view"
  const [menu, deserti, pizze, vina, faq] = await Promise.all([
    airtableList('MENU', { view: 'Grid view', slug }),
    airtableList('DESERTI', { view: 'Grid view', slug }),
    airtableList('PIZZE', { view: 'Grid view', slug }),
    airtableList('VINSKA KARTA', { view: 'Grid view', slug }),
    airtableList('FAQ', { view: 'Grid view', slug }),
  ]);

  return { rest, menu, deserti, pizze, vina, faq };
}

/* ----------------------- SYSTEM PROMPT ----------------------- */
const SYSTEM_PROMPT = `
Ti si **AI SIMMER** – digitalni asistent restorana **Konoba More** u Splitu.

🎯 Tvoja svrha:
Pomažeš gostima restorana na prijateljski i informativan način.
Odgovaraj samo na teme povezane s restoranom Konoba More (hrana, piće, lokacija, rezervacije, meni, vina, deserti, radno vrijeme, plaćanje, dječji meni, kućni ljubimci, pristup, parking i sl.).
Nikada ne odgovaraj na teme nevezane uz restoran (turizam, druge restorane, povijest Splita, općenita pitanja).

💬 Ton komunikacije:
Topao, gostoljubiv, prijateljski. Piši kao konobar ili domaćin koji želi pomoći gostu.
Odgovori neka budu kratki, jasni i konkretni, ali s toplim ljudskim tonom.
Uvijek koristi "mi" umjesto "ja".
Ne koristi formalne izraze poput "Poštovani", "Srdačno" i sl.

🌐 Jezik:
Prepoznaj jezik gosta automatski i odgovaraj na tom jeziku (hrvatski, engleski, talijanski, njemački).
Ako ne prepoznaš jezik, koristi hrvatski.

📋 Informacije o restoranu (iz tablice RESTORANI):
- Naziv: Konoba More
- Lokacija: Poljička cesta, Split (glavna gradska prometnica)
- Udaljenost: oko 10–15 minuta hoda do centra grada i plaže
- Parking: postoji, besplatan
- Tip kuhinje: dalmatinska i mediteranska kuhinja
- Radno vrijeme: od ponedjeljka do nedjelje, 12:00–23:00
- Obiteljski i pet friendly
- Djeca: u ponudi su jela prilagođena djeci (pohano meso, krumpirići, pizze)

🍽️ Meni i ponuda:
Koristi tablice MENU, PIZZE, DESERTI i VINA iz Airtable baze.
Kad gost pita za jela, pića, deserte ili cijene – koristi podatke iz tih tablica.
Ako neko jelo nije u bazi, reci “Trenutno nemam podatke o tom jelu, ali mogu preporučiti nešto slično.”

🍷 Preporuke vina (vino–jela pairing):
Ako gost spomene jelo i pita koje vino preporučuješ:
1) Pogledaj listu VINA iz baze i predloži vino koje odgovara jelu (riba/bijela – bijela vina; crveno meso – crna vina; deserti – desertna vina).
2) Prednost daj lokalnim/regionalnim vinima iz naše vinske karte.
3) Odgovaraj toplo i prirodno (npr. “Uz pašticadu preporučujemo Plavac Mali s Hvara…”).
4) Nikad ne spominji vino koje nije u našoj bazi.

🧭 Ostala pravila:
- Ako gost pita “imate li dječji meni”, spomeni jela prilagođena djeci + napomeni da imamo bojanke i morske rekvizite za razgledavanje.
- Plaže: najbliže su 10–15 minuta hoda.
- Parking: postoji i besplatan.
- Rezervacija: pozivom ili dolaskom u restoran.
- Plaćanje: kartice i gotovina.
- Kućni ljubimci: dobrodošli su.

⚠️ Fallback:
Ako pitanje nije povezano s restoranom ili nemaš podatke, odgovori:
“AI asistent trenutno može odgovarati samo na pitanja o našoj ponudi, meniju, vinima i informacijama o restoranu Konoba More.”

FORMAT & LISTE:
- Sve cijene PRIKAŽI ISKLJUČIVO u EUR (npr. "12.50 €"). Ako cijenu nema, prikaži samo naziv.
- Kad nabrajaš više stavki (jela/pizze/deserti/vina) koristi listu s točkama, svaki red:
  • Naziv — Cijena
- Ako korisnik tek započinje (bok/pozdrav/menu/start...), prvo kratko pozdravi i ponudi kategorije: MENU, PIZZE, VINA, DESERTI, FAQ (“Kliknite na kategoriju ili postavite pitanje”).
`;

/* ----------------------- OPENAI ----------------------- */
const openai = new OpenAI({ apiKey: CFG.openaiKey });

/* ----------------------- ROUTES ----------------------- */
app.get('/api/health', (_req, res) =>
  res.json({ status: 'ok', message: 'AI Simmer server is healthy', uptime: process.uptime() })
);

app.get('/', (_req, res) => res.json({ ok: true, msg: 'AI Simmer API', url: CFG.baseUrl }));

// Glavni endpoint
app.post('/api/ask', async (req, res) => {
  try {
    const { slug, message, history } = req.body || {};
    if (!slug || !message) return res.status(400).json({ error: 'slug i message su obavezni' });

    const data = await loadRestaurantBundle(slug);

    // pripremi kontekst (mapiranje + EUR)
    const context = {
      RESTORAN: data.rest,
      MENU: data.menu.map((x) => ({
        Naziv: x['Naziv jela'] || x['Naziv'],
        Cijena: eur(x['Cijena']),
        Opis: x['Opis'] ?? null,
        Tagovi: x['PairingTagovi'] || x['DijetalneOznake'] || null,
      })),
      DESERTI: data.deserti.map((x) => ({
        Naziv: x['Naziv deserta'] || x['Naziv'],
        Cijena: eur(x['Cijena']),
      })),
      PIZZE: data.pizze.map((x) => ({
        Naziv: x['Naziv pizze'] || x['Naziv'],
        Cijena: eur(x['Cijena']),
      })),
      VINA: data.vina.map((x) => ({
        Naziv: x['Naziv vina'] || x['Naziv'],
        Sorta: x['Sorta'] || null,
        Cijena: eur(x['Cijena']),
      })),
      FAQ: data.faq.map((x) => ({
        Pitanje: x['Pitanje'] || x['Question'],
        Odgovor: x['Odgovor'] || x['Answer'] || null,
      })),
    };

    // brze liste kao hint modelu (da ne izmišlja i da koristi € format)
    const quickLists = {
      MENU: bulletList(context.MENU, (i) => (i.Cijena ? `${i.Naziv} — ${i.Cijena}` : i.Naziv)),
      PIZZE: bulletList(context.PIZZE, (i) => (i.Cijena ? `${i.Naziv} — ${i.Cijena}` : i.Naziv)),
      DESERTI: bulletList(context.DESERTI, (i) => (i.Cijena ? `${i.Naziv} — ${i.Cijena}` : i.Naziv)),
      VINA: bulletList(context.VINA, (i) => (i.Cijena ? `${i.Naziv} — ${i.Cijena}` : i.Naziv)),
    };

    // lagani "welcome" hint
    const low = String(message).trim().toLowerCase();
    const isWelcome = ['bok', 'pozdrav', 'hello', 'hi', 'meni', 'menu', 'start'].some(
      (t) => low === t || low.includes(t)
    );
    const welcomeHint = isWelcome
      ? 'NAPOMENA: prvo pozdravi i ponudi MENU / PIZZE / VINA / DESERTI / FAQ kao kratke tipke.'
      : '';

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...(Array.isArray(history) ? history : []),
      {
        role: 'user',
        content: `
RESTAURANT_SLUG=${slug}
KONTEKST=${JSON.stringify(context)}

LISTE (za brzi prikaz ako korisnik to traži):
MENU_LISTA:
${quickLists.MENU}

PIZZE_LISTA:
${quickLists.PIZZE}

DESERTI_LISTA:
${quickLists.DESERTI}

VINA_LISTA:
${quickLists.VINA}

${welcomeHint}

KORISNIK: ${message}
        `.trim(),
      },
    ];

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.3,
      messages,
    });

    const answer = completion.choices?.[0]?.message?.content?.trim() || 'Nema odgovora.';
    return res.json({ ok: true, answer });
  } catch (err) {
    console.error('[API ERROR]', err);
    const msg = `${err.message || err}`;
    if (msg.includes('429')) return res.status(429).json({ error: 'OpenAI 429 – provjeri billing/limite.' });
    if (msg.includes('Airtable')) return res.status(502).json({ error: msg });
    return res.status(500).json({ error: msg });
  }
});

/* ----------------------- START ----------------------- */
app.listen(CFG.port, () => {
  console.log(`[AI-SIMMER] Running on :${CFG.port}`);
});
