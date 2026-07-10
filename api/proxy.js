// SCRE — серверный прокси Steam (Vercel serverless, Node 18+).
// Делает только то, что НЕЛЬЗЯ из браузера: обходит отсутствие CORS у Steam.
// Нарезка/сжатие — целиком на клиенте (index.html), сюда не входят.
//
// Экшены (?action=): geometry | catalog | search-games | profile | link | img | profile-page

const CDN_ITEMS = "https://cdn.fastly.steamstatic.com/steamcommunity/public/images/items";
const IMG_BASE = "https://cdn.fastly.steamstatic.com/steamcommunity/public/images/";
const STEAMID_BASE = 76561197960265728n;
const ALLOWED = ["steamstatic.com", "steamcommunity.com"];

const GEOMETRY = {
  viewport_w: 1920, content_x: 484, art_x: 492, art_y: 286,
  center_w: 506, side_w: 100, featured_w: 630, gap: 9,
  leftcol_w: 652, rightcol_x: 1148, rightcol_w: 288, max_bytes: 5242880,
};

const UA = "SCRE-SteamArtworkEditor/2.0";
const get = (url) => fetch(url, { headers: { "User-Agent": UA } });
// Кэш на Vercel edge (s-maxage) — Steam получает в разы меньше запросов, не режет по частоте.
const cache = (res, s) => res.setHeader("Cache-Control", `public, s-maxage=${s}, max-age=${Math.min(s, 60)}, stale-while-revalidate=600`);

export default async function handler(req, res) {
  const action = req.query.action || "";
  try {
    if (action === "geometry") return res.json(GEOMETRY);
    if (action === "catalog") return await catalog(req, res);
    if (action === "search-games") return await searchGames(req, res);
    if (action === "profile") return await profile(req, res);
    if (action === "link") return await link(req, res);
    if (action === "img") return await img(req, res);
    if (action === "profile-page") return await profilePage(req, res);
    return res.status(400).json({ error: "unknown action" });
  } catch (e) {
    return res.status(502).json({ error: String(e && e.message || e) });
  }
}

// ── каталог анимированных фонов Points Shop ──
async function queryBackgrounds(appid, cursor) {
  const p = new URLSearchParams({ count: "500", cursor: cursor || "*" });
  p.append("community_item_classes[0]", "3");
  if (appid) p.append("appids[0]", String(appid));
  const r = await get("https://api.steampowered.com/ILoyaltyRewardsService/QueryRewardItems/v1/?" + p);
  const j = await r.json();
  const resp = j.response || {};
  const items = (resp.definitions || [])
    .filter((d) => d.community_item_data && d.community_item_data.animated)
    .map((d) => {
      const c = d.community_item_data;
      const movie = c.item_movie_webm || c.item_movie_mp4;
      return {
        appid: d.appid, defid: d.defid,
        title: c.item_title || c.item_name || "?",
        point_cost: Number(d.point_cost || 0),
        image_url: `${CDN_ITEMS}/${d.appid}/${c.item_image_large || c.item_image_small || ""}`,
        movie_url: movie ? `${CDN_ITEMS}/${d.appid}/${movie}` : null,
        animated: true,
      };
    });
  let next = resp.next_cursor || null;
  if (next === cursor || !(resp.definitions || []).length) next = null;
  return { items, next };
}

async function catalog(req, res) {
  const appid = req.query.appid ? Number(req.query.appid) : null;
  let cursor = req.query.cursor || "*";
  if (appid) {
    const { items, next } = await queryBackgrounds(appid, cursor);
    cache(res, 300);
    return res.json({ items, next_cursor: next });
  }
  // общий список: анимированных ~3%, копим до ~24 за несколько страниц
  const found = [];
  for (let i = 0; i < 8 && cursor; i++) {
    const { items, next } = await queryBackgrounds(null, cursor);
    found.push(...items);
    cursor = next;
    if (found.length >= 24) break;
  }
  cache(res, 180);
  return res.json({ items: found, next_cursor: cursor });
}

async function searchGames(req, res) {
  const term = req.query.term || "";
  const r = await get(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&cc=US&l=en`);
  const j = await r.json();
  cache(res, 600);
  res.json({ games: (j.items || []).slice(0, 10).map((it) => ({ appid: it.id, name: it.name })) });
}

// ── публичные данные профиля ──
async function profileMeta(steamid) {
  const xml = await (await get(`https://steamcommunity.com/profiles/${steamid}/?xml=1`)).text();
  const nick = (xml.match(/<steamID><!\[CDATA\[(.*?)\]\]><\/steamID>/) || [])[1] || steamid;
  const avatar = (xml.match(/<avatarFull><!\[CDATA\[(.*?)\]\]><\/avatarFull>/) || [])[1] || "";
  let level = null;
  try {
    const acc32 = (BigInt(steamid) - STEAMID_BASE).toString();
    const mp = await (await get(`https://steamcommunity.com/miniprofile/${acc32}`)).text();
    const m = mp.match(/friendPlayerLevelNum[^>]*>\s*([\d,]+)/);
    if (m) level = Number(m[1].replace(/,/g, ""));
  } catch {}
  let bg_url = "", bg_animated = false;
  try {
    const eq = await (await get(`https://api.steampowered.com/IPlayerService/GetProfileItemsEquipped/v1/?steamid=${steamid}`)).json();
    const r = eq.response || {};
    const anim = r.animated_background || {};
    const movie = anim.movie_webm || anim.movie_mp4;
    if (movie) { bg_url = IMG_BASE + movie; bg_animated = true; }
    else if ((r.profile_background || {}).image_large) bg_url = IMG_BASE + r.profile_background.image_large;
  } catch {}
  return { steamid64: steamid, nick, avatar_url: avatar, level, bg_url, bg_animated };
}

async function profile(req, res) {
  const meta = await profileMeta(req.query.steamid);
  if (meta.avatar_url) cache(res, 300);   // кэшируем только успешно полученные
  res.json(meta);
}

// ── фон по ссылке (Торговая площадка / Магазин очков) ──
async function link(req, res) {
  const url = (req.body && req.body.url ? req.body.url : "").trim();
  const pm = url.match(/^https?:\/\/store\.steampowered\.com\/points\/shop\/.*?\/reward\/(\d+)/i);
  if (pm) {
    const defid = pm[1];
    const p = new URLSearchParams({ count: "1", cursor: "*" });
    p.append("definitionids[0]", defid);
    const j = await (await get("https://api.steampowered.com/ILoyaltyRewardsService/QueryRewardItems/v1/?" + p)).json();
    const d = (j.response && j.response.definitions || [])[0];
    if (!d || String(d.defid) !== defid) return res.status(400).json({ error: "Фон в Магазине очков не найден.", kind: "not_bg" });
    if (Number(d.community_item_class) !== 3) return res.status(400).json({ error: "По ссылке не фон профиля.", kind: "not_bg" });
    const c = d.community_item_data || {};
    const movie = c.item_movie_webm || c.item_movie_mp4;
    const asset = movie || c.item_image_large || c.item_image_small;
    return res.json({ title: c.item_title || c.item_name || ("reward_" + defid), image_url: `${CDN_ITEMS}/${d.appid}/${asset}`, animated: !!movie });
  }
  const mm = url.match(/^https?:\/\/steamcommunity\.com\/market\/listings\/(\d+)\/([^/?#]+)/i);
  if (!mm) return res.status(400).json({ error: "Это не ссылка на фон Steam (Торговая площадка 753 или Магазин очков).", kind: "not_bg" });
  if (mm[1] !== "753") return res.status(400).json({ error: "Это лот другой игры, а не фон профиля Steam.", kind: "not_bg" });
  const html = await (await get(url)).text();
  if (!html.includes("item_class_3")) return res.status(400).json({ error: "По ссылке не фон профиля (карточка/смайлик).", kind: "not_bg" });
  const clean = html.replace(/\\/g, "");
  const im = clean.match(/https:\/\/[a-z0-9.\-]*steamstatic\.com\/[^"'\s]*\/images\/items\/\d+\/[0-9a-f]+\.(?:jpg|jpeg|png|gif)/i);
  if (!im) return res.status(400).json({ error: "Не удалось найти файл фона на странице лота.", kind: "not_bg" });
  const t = html.match(/<title>(.*?) - Steam Community Market<\/title>/s);
  res.json({ title: t ? t[1].trim() : mm[2], image_url: im[0], animated: false });
}

// ── прокси картинок/видео (для <canvas> и iframe) ──
async function img(req, res) {
  const url = req.query.url || "";
  if (!ALLOWED.some((h) => url.includes(h))) return res.status(403).json({ error: "host not allowed" });
  const r = await get(url);
  const buf = Buffer.from(await r.arrayBuffer());
  res.setHeader("Content-Type", r.headers.get("content-type") || "application/octet-stream");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(buf);
}

// ── 1:1 хром: настоящая страница профиля с нашим фоном ──
const DEMO_STEAMID = "76561198023414915";
async function profilePage(req, res) {
  const sid = req.query.steamid || req.cookies?.scre_steamid || DEMO_STEAMID;
  let bg = req.query.bg || "";
  let html = await (await get(`https://steamcommunity.com/profiles/${sid}/`)).text();
  const valid = html.includes("profile_page") && !/too many requests/i.test(html);
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  html = html.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "");
  html = html.replace(/(href|src)="\/(?!\/)/g, '$1="https://steamcommunity.com/');
  if (bg) {
    html = html.replace(
      /(has_profile_background\s*"[^>]*?style="[^"]*?background-image:\s*url\(\s*')[^']*('\s*\))/i,
      (m, a, b) => a + bg + b);
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  // Кэшируем только НОРМАЛЬНУЮ страницу (не rate-limit «too many requests»),
  // иначе на 5 минут закэшируем ошибку. Демо-профиль общий → кэш очень помогает.
  if (valid) res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
  else res.setHeader("Cache-Control", "no-store");
  res.send(html);
}
