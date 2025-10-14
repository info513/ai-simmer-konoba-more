import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// --- CONFIG ---
const AIR = {
  base: process.env.AIRTABLE_BASE_ID,
  url: process.env.AIRTABLE_API_URL || 'https://api.airtable.com/v0',
  token: process.env.AIRTABLE_TOKEN
};

// —— helper za čitkije logove
const log = (...args) => console.log('[AI-SIMMER]', ...args);

// --- AIRTABLE HELPERS ---
async function airtableList(table, view, slug) {
  const url = new URL(`${AIR.url}/${AIR.base}/${encodeURIComponent(table)}`);
  if (view) url.searchParams.set('view', view);
  if (slug) url.searchParams.set('filterByFormula', `{RestoranSlug}='${slug}'`);
  url.searchParams.set('pageSize', '100');

  log('FETCH:', url.toString());

  const res = await fetch(url, { headers: { Authorization: `Bearer ${AIR.token}` } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Airtable ${table} → ${res.status}${text ? ` | ${text}` : ''}`);
  }
  const json = await res.json();
  return json.records.map(r => ({ id: r.id, ...r.fields }));
}

async function loadRestaurantBundle(slug) {
  // RESTORANI (osnovne info)
  const rurl = new URL(`${AIR.url}/${AIR.base}/RESTORANI`);
  rurl.searchParams.set('filterByFormula', `{slug}='${slug}'`);
  rurl.searchParams.set('maxRecords', '1');

  log('FETCH:', rurl.toString());
  const rres = await fetch(rurl, { headers: { Authorization: `Bearer ${AIR.token}` } });
  if (!rres.ok) throw new Error(`Airtable RESTORANI → ${rres.status}`);
  const rjson = await rres.json();
  const rest = rjson.records?.[0]?.fields || null;

  // Ostale tablice (trenutno koristimo Grid view svugdje)
  const [menu, deserti, pizze, vina, faq] = await Promise.all([
    airtableList('MENU', 'Grid view', slug),
    airtableList('DESERTI', 'Grid view', slug),
    airtableList('PIZZE', 'Grid view', slug),
    airtableList('VINSKA KARTA', 'Grid view', slug),
    airtableList('FAQ', 'Grid view', slug)
  ]);

  return { rest, menu, deserti, pizze, vina, faq };
}

// --- OPENAI ---
const hasOpenAI = !!process.env.OPENAI_API_KEY && !process.env.OPENAI_API_KEY.startsWith('sk-proj-');
const openai = hasOpenAI ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

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


// jednostavan fallback odgovor iz lokalnih podataka
function buildFallbackReply({ message, bundle }) {
  const lines = [];
  if (/pizza|pizze/i.test(message) && bundle.pizze?.length) {
    lines.push('Naše pizze:');
    lines.push(...bundle.pizze.map(p => `• ${p['Naziv pizze'] || p['Naziv']}`).slice(0, 12));
  } else if (/desert|slatko/i.test(message) && bundle.deserti?.length) {
    lines.push('Deserti:');
    lines.push(...bundle.deserti.map(d => `• ${d['Naziv deserta'] || d['Naziv']}`).slice(0, 10));
  } else if (/vino|vinska/i.test(message) && bundle.vina?.length) {
    lines.push('Iz vinske karte:');
    lines.push(...bundle.vina.map(v => `• ${v['Naziv vina'] || v['Naziv']}`).slice(0, 10));
  } else if (bundle.menu?.length) {
    lines.push('Dio jelovnika:');
    lines.push(...bundle.menu.map(j => `• ${j['Naziv jela'] || j['Naziv']}`).slice(0, 10));
  }
  lines.push('');
  lines.push('⚠️ AI trenutno nije aktivan (čeka se OpenAI billing), ali sustav radi ispravno.');
  return lines.join('\n');
}

// --- API ROUTES ---
app.get('/api/health', (req, res) => {
  res.json({ ok: true, openai: hasOpenAI, airtableBase: AIR.base });
});

app.post('/api/ask', async (req, res) => {
  const { slug, message, history } = req.body || {};
  if (!slug || !message) return res.status(400).json({ error: 'slug i message su obavezni' });

  try {
    const data = await loadRestaurantBundle(slug);

    const context = {
      RESTORAN: data.rest,
      MENU: data.menu.map(x => ({
        Naziv: x['Naziv jela'] || x['Naziv'],
        Cijena: x['Cijena'] ?? null,
        Opis: x['Opis'] ?? null,
        Tagovi: x['PairingTagovi'] || x['DijetalneOznake'] || null
      })),
      DESERTI: data.deserti.map(x => ({ Naziv: x['Naziv deserta'] || x['Naziv'], Cijena: x['Cijena'] ?? null })),
      PIZZE: data.pizze.map(x => ({ Naziv: x['Naziv pizze'] || x['Naziv'], Cijena: x['Cijena'] ?? null })),
      VINA: data.vina.map(x => ({ Naziv: x['Naziv vina'] || x['Naziv'], Sorta: x['Sorta'] || null, Cijena: x['Cijena'] ?? null })),
      FAQ: data.faq.map(x => ({ Pitanje: x['Pitanje'] || x['Question'], Odgovor: x['Odgovor'] || x['Answer'] || null }))
    };

    // Fallback ako OpenAI nije dostupan (billing/kvota)
    if (!hasOpenAI) {
      return res.json({ ok: true, reply: buildFallbackReply({ message, bundle: data }) });
    }

    try {
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.3,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          ...(history || []),
          { role: 'user', content: `RESTAURANT_SLUG=${slug}\nKONTEKST=${JSON.stringify(context)}\n\nKORISNIK: ${message}` }
        ]
      });

      return res.json({ ok: true, reply: completion.choices?.[0]?.message?.content || 'Nema odgovora.' });
    } catch (oaErr) {
      // Ako je 429 ili slična greška — vraćamo fallback iz baze
      log('OpenAI error:', oaErr?.status || '', oaErr?.message || '');
      return res.json({ ok: true, reply: buildFallbackReply({ message, bundle: data }) });
    }

  } catch (e) {
    log('ERROR:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// (opcionalno) posluži lokalni index.html da možeš kliknuti i testirati
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => log('AI Simmer running on :' + PORT));
