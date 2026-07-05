// SCRE — вход через Steam (OpenID 2.0) на Vercel serverless.
// Только идентификация: приложение получает SteamID64, паролей не видит.
// Экшены (?action=): login | return | me | logout

const OPENID = "https://steamcommunity.com/openid/login";
const NS = "http://specs.openid.net/auth/2.0";
const SELECT = "http://specs.openid.net/auth/2.0/identifier_select";
const UA = "SCRE-SteamArtworkEditor/2.0";

function baseUrl(req) {
  const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0];
  return `${proto}://${req.headers.host}`;
}

export default async function handler(req, res) {
  const action = req.query.action || "";
  if (action === "login") return login(req, res);
  if (action === "return") return doReturn(req, res);
  if (action === "me") return me(req, res);
  if (action === "logout") return logout(req, res);
  return res.status(400).json({ error: "unknown action" });
}

function login(req, res) {
  const base = baseUrl(req);
  const p = new URLSearchParams({
    "openid.ns": NS,
    "openid.mode": "checkid_setup",
    "openid.return_to": `${base}/api/steam-auth?action=return`,
    "openid.realm": base + "/",
    "openid.identity": SELECT,
    "openid.claimed_id": SELECT,
  });
  res.writeHead(302, { Location: OPENID + "?" + p });
  res.end();
}

async function doReturn(req, res) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query)) {
    if (k.startsWith("openid.")) params.append(k, v);
  }
  params.set("openid.mode", "check_authentication");
  const vr = await fetch(OPENID, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
    body: params.toString(),
  });
  const text = await vr.text();
  const claimed = req.query["openid.claimed_id"] || "";
  const m = String(claimed).match(/\/openid\/id\/(\d+)\s*$/);
  if (!text.includes("is_valid:true") || !m) {
    res.writeHead(302, { Location: "/?login=failed" });
    return res.end();
  }
  const cookie = `scre_steamid=${m[1]}; Path=/; Max-Age=${60 * 60 * 24 * 30}; HttpOnly; Secure; SameSite=Lax`;
  res.writeHead(302, { Location: "/?login=ok", "Set-Cookie": cookie });
  res.end();
}

function readCookie(req) {
  const raw = req.headers.cookie || "";
  const m = raw.match(/(?:^|;\s*)scre_steamid=(\d+)/);
  return m ? m[1] : null;
}

function me(req, res) {
  const sid = readCookie(req);
  res.json({ logged_in: !!sid, steamid: sid || null });
}

function logout(req, res) {
  res.setHeader("Set-Cookie", "scre_steamid=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax");
  res.json({ ok: true });
}
