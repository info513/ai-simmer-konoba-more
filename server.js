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
    // ako već ima €/EUR, pusti kako jest; inače dodaj €
    return /€|eur/i.test(v) ? v : `${v} €`;
  }
  return null;
};

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
    // DNEVNA PONUDA – ako nema takve tablice, samo vrati prazno
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
- Kad korisnik napiše nešto s tipfelrom, nemoj tvrditi da "nije u okviru znanja", nego zamoli kratko pojašnjenje:  
  “Nisam siguran jesam li dobro razumio – možete li ponoviti ili pojasniti riječ/rečenicu?”

💬 Ton:
- Topao i gostoljubiv, odgovori kratki, jasni i konkretni.
- Koristi “mi” umjesto “ja”.
- Bez formalnih “Poštovani/Srdačno”.

👥 Osoblje:
- Ako se pitaju imena osoblja: **Joško (vlasnik)**, **Nives (konobar)**.

🌐 Jezik:
- Automatski prepoznaj jezik i odgovaraj istim jezikom (hr/en/it/de). Ako ne možeš, koristi hrvatski.

📋 Podaci:
- RESTORAN objekt sadrži kontakt podatke i info (adresa, telefon, email, web, radno vrijeme, parking).
- MENI (MENU, PIZZE, DESERTI): koristi nazive, **opise** i cijene; prikazuj cijene s “€” (npr. 12.00 €).  
  Ako korisnik traži “meni”, **ne ispisuj sve odjednom** – prvo prikaži **kategorije/podkategorije** i tek onda traženi dio.
- VINA: koristi nazive, sorte i **cijene** iz tablice VINSKA KARTA.  
  Kod pairinga: izbjegavaj potpitanje “uz koje jelo” ako je iz konteksta jasno što je korisnik naručio.
- DNEVNA PONUDA: ako postoji, prikaži aktualne stavke s cijenama.
- FAQ: odgovaraj koristeći najvažnija pitanja/odgovore.

🍷 Pairing (vino–jela):
- riba, školjke, bijelo meso → bijela vina (Pošip, Malvazija, Chardonnay…)
- crveno meso, pašticada, divljač → crna vina (Plavac Mali, Merlot, Cabernet…)
- deserti → desertna vina (prošek, muškat…)
- Prednost daj domaćim/regionalnim vinima s **naše vinske karte**.
- Nikad nemoj predlagati vino koje nije u bazi.

👨‍👩‍👧 Djeca:
- Spomeni da imamo jela prilagođena djeci i da se mogu zabaviti **bojankama** ili razgledavanjem **morskih rekvizita** u restoranu.

💶 Pravila cijena:
- Cijene reproduciraj **točno** iz baze i formatiraj s “€” (npr. 8.00 €). Ako nema cijene, reci da trenutačno nemamo podatak.

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

app.post('/api/ask', async (req, res) => {
  try {
    const { slug, message, history } = req.body || {};
    if (!slug || !message) return res.status(400).json({ error: 'slug i message su obavezni' });

    const data = await loadRestaurantBundle(slug);

    // mapiranje – uključujemo opise, kategorije i formatirane cijene
    const context = {
      RESTORAN: {
        ...data.rest,
        Telefon: data.rest?.Telefon || data.rest?.Phone || null,
        Email: data.rest?.Email || null,
        Adresa: data.rest?.Adresa || data.rest?.Address || null,
        Web: data.rest?.Web || data.rest?.Website || null,
      },
      MENU: data.menu.map((x) => ({
        Naziv: x['Naziv jela'] || x['Naziv'],
        Opis: x['Opis'] || null,
        Cijena: fmtPrice(x['Cijena']),
        Kategorija: x['Kategorija'] || null,
        Podkategorija: x['Podkategorija'] || null,
        Tagovi: x['PairingTagovi'] || x['DijetalneOznake'] || null,
      })),
      PIZZE: data.pizze.map((x) => ({
        Naziv: x['Naziv pizze'] || x['Naziv'],
        Opis: x['Opis'] || null,
        Cijena: fmtPrice(x['Cijena']),
        Kategorija: x['Kategorija'] || 'Pizze',
        Podkategorija: x['Podkategorija'] || null,
      })),
      DESERTI: data.deserti.map((x) => ({
        Naziv: x['Naziv deserta'] || x['Naziv'],
        Opis: x['Opis'] || null,
        Cijena: fmtPrice(x['Cijena']),
        Kategorija: x['Kategorija'] || 'Deserti',
        Podkategorija: x['Podkategorija'] || null,
      })),
      VINA: data.vina.map((x) => ({
        Naziv: x['Naziv vina'] || x['Naziv'],
        Sorta: x['Sorta'] || null,
        Cijena: fmtPrice(x['Cijena']),
        Kategorija: x['Kategorija'] || 'Vina',
      })),
      DNEVNA: (data.dnevno || []).map((x) => ({
        Naziv: x['Naziv'] || x['Jelo'] || null,
        Opis: x['Opis'] || null,
        Cijena: fmtPrice(x['Cijena']),
        Napomena: x['Napomena'] || null,
      })),
      FAQ: data.faq.map((x) => ({
        Pitanje: x['Pitanje'] || x['Question'],
        Odgovor: x['Odgovor'] || x['Answer'] || null,
      })),
    };

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...(Array.isArray(history) ? history : []), // << kratka povijest iz widgeta
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
