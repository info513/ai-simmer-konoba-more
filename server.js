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
  // nije obavezno, samo za log/allowlist
  baseUrl: process.env.BASE_URL || 'https://ai-simmer-konoba-more.onrender.com',
  // dozvoljene domene za CORS
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
  if (miss.length) {
    console.error('[ENV] Missing:', miss.join(', '));
  }
}
assertEnv();

/* ----------------------- MIDDLEWARE ----------------------- */
app.use(express.json({ limit: '1mb' }));
app.use(
  cors({
    origin: (origin, cb) => {
      // dopuštamo i “no origin” (npr. curl/ReqBin) i naše domene
      if (!origin) return cb(null, true);
      const ok = CFG.corsOrigins.some((o) => origin.endsWith(o.replace('https://', '').replace('http://', '')));
      return cb(null, ok);
    },
    methods: ['POST', 'GET', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

/* ----------------------- HELPERS ----------------------- */
async function airtableList(table, { view, slug } = {}) {
  const url = new URL(`${CFG.air.url}/${CFG.air.base}/${encodeURIComponent(table)}`);
  if (view) url.searchParams.set('view', view);
  if (slug) url.searchParams.set('filterByFormula', `{RestoranSlug}='${slug}'`);
  url.searchParams.set('pageSize', '100');

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${CFG.air.token}` },
  });

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

  // Ostale tablice – koristiš “Grid view”. Ako kasnije napraviš API view, promijeni `view`.
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
1. Pregledaj tablicu "VINA" restorana i odaberi vino koje najbolje odgovara jelu prema osnovnim pravilima:
   - riba, školjke, bijelo meso, lagana jela → bijela vina (npr. Pošip, Malvazija, Chardonnay)
   - crveno meso, pašticada, divljač → crna vina (npr. Plavac Mali, Merlot, Cabernet Sauvignon)
   - deserti → desertna vina (npr. prošek, muškat)
2. Prednost daj vinima iz lokalne/regionalne ponude restorana.
3. Uvijek odgovaraj prirodno i gostoljubivo:
   - “Uz našu pašticadu preporučujemo Plavac Mali s Hvara – punog tijela i bogate arome, savršeno se slaže s umakom.”
   - “Za riblja jela preporučujemo Pošip s Korčule – svjež i lagan, idealan uz bijelu ribu.”
4. Ako u vinskoj karti ne postoji odgovarajuće vino, reci:
   - “Trenutno nemamo vino koje posebno preporučujemo uz to jelo, ali gostima često prija {{drugo vino iz ponude}}.”

Nikada nemoj predlagati vino koje nije u vinskoj karti restorana (tablica VINA).

🧭 Ostala pravila:
- Ako gost pita “imate li dječji meni”, odgovori da imamo jela prilagođena djeci.
- Ako pita za plaže, spomeni da su najbliže plaže 10–15 minuta hoda.
- Ako pita za parking, reci da postoji i da je besplatan.
- Ako pita za rezervaciju, objasni da se može izvršiti pozivom ili dolaskom u restoran.
- Ako pita za plaćanje, reci da primamo kartice i gotovinu.
- Ako pita za kućne ljubimce, reci da su dobrodošli.

⚠️ Fallback:
Ako pitanje nije povezano s restoranom ili nemaš podatke, odgovori:
“AI asistent trenutno može odgovarati samo na pitanja o našoj ponudi, meniju, vinima i informacijama o restoranu Konoba More.”

U svakom odgovoru koristi tople izraze poput:
“Preporučujemo”, “Rado bismo Vam”, “Naši gosti najčešće biraju”, “Uz to jelo savršeno pristaje”, “Možete nas pronaći”, “Dobrodošli ste”.
`;

/* ----------------------- OPENAI ----------------------- */
const openai = new OpenAI({ apiKey: CFG.openaiKey });

/* ----------------------- ROUTES ----------------------- */
// Health-check (Render koristi za provjeru)
app.get('/health', (_req, res) => res.json({ ok: true, service: 'ai-simmer', url: CFG.baseUrl }));

// Kratki info o verziji
app.get('/', (_req, res) => res.json({ ok: true, msg: 'AI Simmer API', url: CFG.baseUrl }));

// Glavni endpoint
app.post('/api/ask', async (req, res) => {
  try {
    const { slug, message, history } = req.body || {};
    if (!slug || !message) return res.status(400).json({ error: 'slug i message su obavezni' });

    const data = await loadRestaurantBundle(slug);

    // pripremi kontekst (mapiranje ključnih polja)
    const context = {
      RESTORAN: data.rest,
      MENU: data.menu.map((x) => ({
        Naziv: x['Naziv jela'] || x['Naziv'],
        Cijena: x['Cijena'] ?? null,
        Opis: x['Opis'] ?? null,
        Tagovi: x['PairingTagovi'] || x['DijetalneOznake'] || null,
      })),
      DESERTI: data.deserti.map((x) => ({ Naziv: x['Naziv deserta'] || x['Naziv'], Cijena: x['Cijena'] ?? null })),
      PIZZE: data.pizze.map((x) => ({ Naziv: x['Naziv pizze'] || x['Naziv'], Cijena: x['Cijena'] ?? null })),
      VINA: data.vina.map((x) => ({
        Naziv: x['Naziv vina'] || x['Naziv'],
        Sorta: x['Sorta'] || null,
        Cijena: x['Cijena'] ?? null,
      })),
      FAQ: data.faq.map((x) => ({
        Pitanje: x['Pitanje'] || x['Question'],
        Odgovor: x['Odgovor'] || x['Answer'] || null,
      })),
    };

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...(Array.isArray(history) ? history : []),
      {
        role: 'user',
        content:
          `RESTAURANT_SLUG=${slug}\n` +
          `KONTEKST=${JSON.stringify(context)}\n\n` +
          `KORISNIK: ${message}`,
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
    // Lijepše poruke prema klijentu
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
