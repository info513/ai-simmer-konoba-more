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
Ti si "AI Simmer" — digitalni asistent restorana.
• Odgovaraj kratko, korisno i prijateljski, na jeziku korisnikova pitanja.
• Koristi isključivo podatke iz Airtablea (RESTORANI, MENU, DESERTI, PIZZE, VINSKA KARTA, FAQ).
• Ako podatak ne postoji, reci da ga trenutačno nemaš i ponudi kontakt/restoran.
• Cijene i nazive reproduciraj točno. Ne izmišljaj stavke kojih nema u bazi.
• Za sparivanje jela i vina: prvo koristi PairingTagovi; ako ih nema, predloži 1–2 logične opcije s vinske karte.
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
