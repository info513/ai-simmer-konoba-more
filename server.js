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
    token: process.env.AIRTABLE_TOKEN,
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
const isNum = (v) => typeof v === 'number' && isFinite(v);
const fmtPrice = (v) => {
  if (isNum(v)) return `${v.toFixed(2)} €`;
  if (typeof v === 'string' && v.trim()) {
    return /€|eur/i.test(v) ? v : `${v} €`;
  }
  return null;
};

// prva postojeća vrijednost iz liste naziva polja (točno po imenu)
function getField(rec, names) {
  for (const n of names) {
    const v = rec?.[n];
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return null;
}

// tekstualno polje s varijantama naziva (pokušaj exact → fallback regex po ključevima)
function getTextField(rec, candidates) {
  const exact = getField(rec, candidates);
  if (exact) return exact;
  const keys = Object.keys(rec || {});
  for (const k of keys) {
    const kl = k.toLowerCase();
    for (const cand of candidates) {
      const c = cand.toLowerCase();
      if (kl.includes(c)) {
        const val = rec[k];
        if (val !== undefined && val !== null && String(val).trim() !== '') return val;
      }
    }
  }
  return null;
}

// Skupi cijene vina iz raznih mogućih naziva kolona (čaša / butelja / 0.5 / 0.25 / 0.187)
function buildWinePrices(rec) {
  if (!rec) return { prices: {}, priceText: null, main: null };
  const entries = Object.entries(rec).filter(
    ([, v]) => v !== undefined && v !== null && String(v).trim() !== ''
  );

  let byGlass = null, bottle = null, half = null, q0187 = null, q025 = null;
  for (const [key, raw] of entries) {
    const k = key.toLowerCase();
    const val = typeof raw === 'string' ? raw.replace(',', '.').trim() : raw;

    if (!byGlass && (k.includes('čaš') || k.includes('casa') || k.includes('glass'))) { byGlass = val; continue; }
    if (!bottle  && (k.includes('butelj') || k.includes('boca') || k.includes('bottle'))) { bottle = val; continue; }
    if (!half    && (k.includes('0.5') || k.includes('0,5'))) { half = val; continue; }
    if (!q025    && (k.includes('0.25') || k.includes('0,25'))) { q025 = val; continue; }
    if (!q0187   && (k.includes('0.187') || k.includes('0,187'))) { q0187 = val; continue; }
  }

  const prices = {
    casa:  fmtPrice(byGlass),
    boca:  fmtPrice(bottle),
    pola:  fmtPrice(half),
    q025:  fmtPrice(q025),
    q0187: fmtPrice(q0187),
  };

  const parts = [];
  if (prices.casa) parts.push(`čaša: ${prices.casa}`);
  if (prices.boca) parts.push(`butelja: ${prices.boca}`);
  if (prices.pola) parts.push(`0.5 l: ${prices.pola}`);
  if (prices.q025) parts.push(`0.25 l: ${prices.q025}`);
  if (prices.q0187) parts.push(`0.187 l: ${prices.q0187}`);

  const main = prices.boca || prices.casa || null;
  return { prices, priceText: parts.join(' • ') || null, main };
}

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

  const [menu, deserti, pizze, vina, faq, dnevno] = await Promise.all([
    airtableList('MENU', { view: 'Grid view', slug }),
    airtableList('DESERTI', { view: 'Grid view', slug }),
    airtableList('PIZZE', { view: 'Grid view', slug }),
    airtableList('VINSKA KARTA', { view: 'Grid view', slug }),
    airtableList('FAQ', { view: 'Grid view', slug }),
    airtableList('DNEVNA PONUDA', { view: 'Grid view', slug }).catch(() => []),
  ]);

  return { rest, menu, deserti, pizze, vina, faq, dnevno };
}

/* ----------------------- SYSTEM PROMPT ----------------------- */
const SYSTEM_PROMPT = `
Ti si **AI SIMMER** – digitalni asistent restorana **Konoba More** u Splitu.

🎯 Svrha:
- Pomažeš gostima na prijateljski i informativan način.
- Odgovaraj samo o restoranu (meni, vina, deserti, dnevna ponuda, rezervacije, radno vrijeme, plaćanje, djeca, kućni ljubimci, parking).
- Ako korisnik napiše riječ s tipfelrom, nemoj tvrditi da “nije u okviru znanja”, nego zamoli kratko pojašnjenje:
  “Nisam siguran jesam li dobro razumio – možete li ponoviti ili pojasniti riječ/rečenicu?”

💬 Ton:
- Topao i gostoljubiv, odgovori kratki, jasni i konkretni. Koristi “mi”.
- Bez formalnih “Poštovani/Srdačno”.

👥 Osoblje:
- Ako se pitaju imena osoblja: **Joško (vlasnik)**, **Nives (konobar)**.

🌐 Jezik:
- Uvijek odgovaraj na jeziku **posljednje korisničke poruke**.
- Ako je dostupna varijabla VisitorLanguage, koristi je kao preferirani jezik, osim ako je jezik korisničke poruke drugačiji – tada slijedi jezik poruke.
- Primjeri podržanih jezika: hr/en/it/de — ali se prilagodi bilo kojem jeziku koji korisnik koristi.

📋 Podaci i pravila:
- MENI/PIZZE/DESERTI: za sadržaj jela OBAVEZNO koristi polje **Opis** (doslovno – bez izmišljanja).
  Ako korisnik pita “od čega se sastoji…”, “je li odležani biftek…”, “što uključuje riblja plata” – uzmi iz **Opis**.
  Ako **Opis** nije upisan, jasno reci da opis trenutačno nije dostupan.
- VINA: koristi nazive, sorte i **sve dostupne cijene**. Ako postoje više cijena (čaša/butelja/0.5 l/0.25 l/0.187 l) – prikaži sve koje postoje.
- Cijene reproduciraj točno i formatiraj s “€” (npr. 8.00 €). Ako cijene nema, reci da trenutačno nemamo podatak.
- Pri prikazu menija **ne izbacuj cijeli jelovnik** odjednom – najprije prikaži kategorije/podkategorije pa traženi dio.
- Dnevna ponuda: prikaži aktualne stavke s cijenama ako postoje.
- FAQ: koristi najvažnija pitanja/odgovore.

🍷 Pairing:
- riba/školjke/bijelo meso → bijela vina (Pošip, Malvazija, Chardonnay…)
- crveno meso/pašticada/divljač → crna vina (Plavac Mali, Merlot, Cabernet…)
- deserti → desertna vina (prošek, muškat…)
- Prednost daj vinima s naše karte; nemoj predlagati vino koje nije u bazi.
- Ako je iz konteksta jasno koje je jelo, ne postavljaj dodatno pitanje “uz koje jelo?”.

👨‍👩‍👧 Djeca:
- Spomeni da imamo jela prilagođena djeci i da se mogu zabaviti **bojankama** ili razgledavanjem **morskih rekvizita** u restoranu.

⚠️ Fallback:
- Ako pitanje nije povezano s restoranom:
  “AI asistent može odgovarati samo na pitanja o našoj ponudi i informacijama o Konobi More.”
`;

/* ----------------------- OPENAI ----------------------- */
const openai = new OpenAI({ apiKey: CFG.openaiKey });

/* ----------------------- ROUTES ----------------------- */
app.get('/api/health', (_req, res) =>
  res.json({ status: 'ok', message: 'AI Simmer server is healthy', uptime: process.uptime() })
);
app.get('/', (_req, res) => res.type('text').send('AI Simmer up'));

// (Opcionalno) Debug – vidi ključeve iz VINSKA KARTA (odkomentiraj po potrebi)
// app.get('/api/debug/vina', async (req, res) => {
//   try {
//     const { slug } = req.query;
//     if (!slug) return res.status(400).json({ error: 'slug je obavezan' });
//     const vina = await airtableList('VINSKA KARTA', { view: 'Grid view', slug });
//     const sample = vina[0] || null;
//     res.json({ count: vina.length, sampleKeys: sample ? Object.keys(sample) : [], sampleRecord: sample || null });
//   } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
// });

app.post('/api/ask', async (req, res) => {
  try {
    const { slug, message, history } = req.body || {};
    if (!slug || !message) return res.status(400).json({ error: 'slug i message su obavezni' });

    // Hint jezika posjetitelja iz headera (npr. "hr-HR,hr;q=0.9,en;q=0.8")
    const acceptLang = String(req.headers['accept-language'] || '').split(',')[0] || '';
    const visitorLang = acceptLang.split('-')[0] || '';

    const data = await loadRestaurantBundle(slug);

    // mapiranje – uključujemo opise, kategorije i formatirane cijene + sve cijene vina
    const context = {
      RESTORAN: {
        ...data.rest,
        Telefon: data.rest?.Telefon || data.rest?.Phone || null,
        Email:   data.rest?.Email   || null,
        Adresa:  data.rest?.Adresa  || data.rest?.Address || null,
        Web:     data.rest?.Web     || data.rest?.Website || null,
      },

      MENU: data.menu.map((x) => ({
        Naziv:   x['Naziv jela'] || x['Naziv'],
        Opis:    getTextField(x, ['Opis', 'Opis jela', 'Sastojci', 'Opis jelo', 'Description', 'Ingredients']),
        Cijena:  fmtPrice(x['Cijena']),
        Kategorija:    x['Kategorija'] || null,
        Podkategorija: x['Podkategorija'] || null,
        Tagovi:  x['PairingTagovi'] || x['DijetalneOznake'] || null,
      })),

      PIZZE: data.pizze.map((x) => ({
        Naziv:   x['Naziv pizze'] || x['Naziv'],
        Opis:    getTextField(x, ['Opis', 'Opis pizze', 'Opis jela', 'Sastojci', 'Description', 'Ingredients']),
        Cijena:  fmtPrice(x['Cijena']),
        Kategorija:    x['Kategorija'] || 'Pizze',
        Podkategorija: x['Podkategorija'] || null,
      })),

      DESERTI: data.deserti.map((x) => ({
        Naziv:   x['Naziv deserta'] || x['Naziv'],
        Opis:    getTextField(x, ['Opis', 'Opis deserta', 'Opis jela', 'Sastojci', 'Description', 'Ingredients']),
        Cijena:  fmtPrice(x['Cijena']),
        Kategorija:    x['Kategorija'] || 'Deserti',
        Podkategorija: x['Podkategorija'] || null,
      })),

      VINA: data.vina.map((x) => {
        const { prices, priceText, main } = buildWinePrices(x);
        return {
          Naziv:  x['Naziv vina'] || x['Naziv'],
          Sorta:  x['Sorta'] || null,
          Cijena: main || fmtPrice(x['Cijena']) || null,
          Cijene: prices,              // {casa, boca, pola, q025, q0187}
          CijenaTekst: priceText || null,
          Kategorija: x['Kategorija'] || 'Vina',
        };
      }),

      DNEVNA: (data.dnevno || []).map((x) => ({
        Naziv:   x['Naziv'] || x['Jelo'] || null,
        Opis:    x['Opis'] || null,
        Cijena:  fmtPrice(x['Cijena']),
        Napomena: x['Napomena'] || null,
      })),

      FAQ: data.faq.map((x) => ({
        Pitanje: x['Pitanje'] || x['Question'],
        Odgovor: x['Odgovor'] || x['Answer'] || null,
      })),
    };

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      // dodatni "signal" o jeziku posjetitelja
      ...(visitorLang ? [{ role: 'system', content: `VisitorLanguage=${visitorLang}` }] : []),
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
