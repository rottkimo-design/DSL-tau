// 讀取 Google 試算表「DUPR 積分回報表」，用服務帳號驗證，回傳姓名/DUPR ID 對應積分。
// 需要環境變數 GOOGLE_SA_EMAIL, GOOGLE_SA_PRIVATE_KEY（服務帳號需已被加為該試算表的檢視者）。
const crypto = require('crypto');

const SPREADSHEET_ID = '1KOFUrzo8Cs_sCvTdKcS3WyqJbDJMXHWXS2EEq7p2oEw';
const SHEET_GID = 236345712;

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getAccessToken() {
  const email = process.env.GOOGLE_SA_EMAIL;
  const key = (process.env.GOOGLE_SA_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !key) throw new Error('缺少 GOOGLE_SA_EMAIL / GOOGLE_SA_PRIVATE_KEY 環境變數');

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64url(JSON.stringify({
    iss: email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  }));
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${header}.${claim}`);
  sign.end();
  const signature = base64url(sign.sign(key));
  const jwt = `${header}.${claim}.${signature}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${jwt}`,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`取得 access token 失敗: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function findSheetTitle(token) {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}?fields=sheets.properties(sheetId,title)`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(`讀取試算表結構失敗: ${JSON.stringify(data)}`);
  const sheet = (data.sheets || []).find(s => s.properties.sheetId === SHEET_GID);
  if (!sheet) throw new Error('找不到指定的分頁 gid');
  return sheet.properties.title;
}

async function fetchValues(token, title) {
  const range = encodeURIComponent(`${title}!A:G`);
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${range}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(`讀取試算表資料失敗: ${JSON.stringify(data)}`);
  return data.values || [];
}

module.exports = async (req, res) => {
  try {
    const token = await getAccessToken();
    const title = await findSheetTitle(token);
    const rows = await fetchValues(token, title);

    // A時間戳記 B會員編號 C會員暱稱 D DUPR ID E DUPR Name F DUPR積分 G True=U18
    const byId = {};
    const byName = {};
    rows.slice(1).forEach(row => {
      const nickname = (row[2] || '').trim();
      const duprId = (row[3] || '').trim().toUpperCase();
      const duprName = (row[4] || '').trim();
      const score = (row[5] || '').trim();
      if (!score) return;
      if (duprId) byId[duprId] = score;
      if (nickname) byName[nickname] = score;
      if (duprName) byName[duprName] = score;
    });

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.status(200).json({ updatedAt: Date.now(), byId, byName });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
};
