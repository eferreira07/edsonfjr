const http = require('http');
const https = require('https');
const { execFileSync } = require('child_process');

const PORT = 5680;

// Airtable credentials
const AIRTABLE_TOKEN = 'patmJvwfkSfgtqulh.667d15a117fc22cf21d017d1a455721774995b5ff5e2b3aa1a4b20192589c832';
const AIRTABLE_BASE = 'appPzLlWyH7tRp5NS';
const AIRTABLE_TABLE = 'tblKyvrvjeLykZ8qk';

// Fetch all records from Airtable
function fetchAirtableRecords() {
  return new Promise((resolve, reject) => {
    const headers = {
      'Authorization': `Bearer ${AIRTABLE_TOKEN}`,
      'Content-Type': 'application/json'
    };

    let allRecords = [];
    let offset = null;

    function fetchPage() {
      const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}${offset ? '?offset=' + offset : ''}`;

      https.get(url, { headers }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`Airtable HTTP ${res.statusCode}: ${data}`));
            return;
          }

          const parsed = JSON.parse(data);
          allRecords = allRecords.concat(parsed.records || []);
          offset = parsed.offset || null;

          if (offset) {
            fetchPage();
          } else {
            resolve(allRecords);
          }
        });
      }).on('error', reject);
    }

    fetchPage();
  });
}

// Update a single record in Airtable
function updateAirtableRecord(recordId, fields) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ fields });

    const options = {
      hostname: 'api.airtable.com',
      port: 443,
      path: `/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}/${recordId}`,
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${AIRTABLE_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': data.length
      }
    };

    const req = https.request(options, (res) => {
      let responseData = '';
      res.on('data', chunk => { responseData += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Airtable update HTTP ${res.statusCode}: ${responseData}`));
        } else {
          resolve(JSON.parse(responseData));
        }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Build the stack rank prompt (Claude analyzes, doesn't run curl)
function buildStackRankPrompt(records) {
  const recordsJson = JSON.stringify(records.map(r => ({
    id: r.id,
    Title: r.fields?.Title,
    Status: r.fields?.Status,
    Type: r.fields?.Type,
    'Content Ref': r.fields?.['Content Ref'],
    Why: r.fields?.Why,
    'My Angle': r.fields?.['My Angle'],
    Date: r.fields?.Date,
    Rank: r.fields?.Rank
  })), null, 2);

  return `You are Edson Ferreira's Social Media Manager, running a prioritization pass over his content pipeline.

HERE IS THE AIRTABLE DATA (already fetched for you):
${recordsJson}

YOUR TASK — SCORE EVERY RECORD WHOSE STATUS IS "Open", "Drafted", OR "Ready to Publish"
Do not modify records with Status "Scheduled", "Published", or "Rejected" — those are already locked in.

For each record to score, rate these five factors 1-5 and compute a weighted composite:
- Momentum (25%): how current the source and data are — is this being actively discussed right now, or already cooling.
- Differentiation (25%): how sharp and non-generic Edson's specific angle (the "My Angle" field) is. Contrarian, debate-sparking takes score higher than neutral summaries, because they drive comments, and comments drive reach.
- Audience fit (20%): how well it plays to Edson's actual credibility (20+ years enterprise product experience, Oracle-scale systems) vs. generic AI commentary, and whether it helps balance the mix — 1 of every 3 posts should stay enterprise-anchored, the other 2 should skew toward individuals/small business for relatability.
- Hook strength (20%): does the piece contain a stat or claim strong enough to stop the scroll as an opening line.
- Uniqueness (10%): penalize heavily (score 1-2) if this record's core argument or angle closely overlaps with another record in the pipeline — especially one that is already Scheduled or Published. Two pieces making basically the same point will cannibalize each other.

Composite = 0.25×Momentum + 0.25×Differentiation + 0.20×AudienceFit + 0.20×Hook + 0.10×Uniqueness, rounded to 1 decimal place.

Respond with ONLY valid JSON on the last line, single line, no line breaks inside it:
{"status":"success","scored":[{"recordId":"...","title":"...","rank":X.X}]}`;
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== 'POST' || req.url !== '/run') {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    try {
      const { prompt: customPrompt } = JSON.parse(body);

      // If it's a stack rank request, fetch Airtable data and build prompt
      let prompt = customPrompt;
      let isStackRank = customPrompt?.includes('stack ranking') || customPrompt?.includes('STEP 1 — FETCH ALL RECORDS');

      if (isStackRank) {
        const records = await fetchAirtableRecords();
        prompt = buildStackRankPrompt(records);
      }

      // Call Claude
      const stdout = execFileSync('claude', [
        '-p', prompt,
        '--output-format', 'json',
        '--permission-mode', 'acceptEdits'
      ], {
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
        env: { ...process.env, PATH: process.env.PATH + ':/usr/local/bin' }
      });

      // If this was stack rank, parse and update Airtable
      if (isStackRank) {
        const claudeResult = JSON.parse(stdout);
        const resultText = claudeResult.result.trim();
        const jsonStart = resultText.lastIndexOf('{"status"');

        if (jsonStart === -1) {
          throw new Error('Claude did not confirm success: ' + resultText);
        }

        const confirmation = JSON.parse(resultText.slice(jsonStart));
        if (confirmation.status !== 'success') {
          throw new Error('Claude scoring failed: ' + resultText);
        }

        // Update each scored record in Airtable
        const scored = confirmation.scored || [];
        for (const item of scored) {
          await updateAirtableRecord(item.recordId, { Rank: item.rank });
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          output: JSON.stringify({
            result: JSON.stringify({ status: 'success', scored: scored, message: `Updated ${scored.length} records` })
          })
        }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, output: stdout }));
      }
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        errorCode: err.code || null,
        message: err.message || null,
        stderr: err.stderr ? err.stderr.toString() : null
      }));
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Claude bridge v2 listening on http://localhost:${PORT}`);
  console.log(`Stack rank: Bridge fetches Airtable → Claude scores → Bridge updates (no curl needed)`);
});
