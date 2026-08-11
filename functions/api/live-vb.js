/**
 * live-vb.js — Cloudflare Pages Function
 * 对应原 Pantheon 的 live-vb.php：服务端 YouTube 排球直播代理（优先频道版，省配额）。
 *
 * 路由：/api/live-vb
 *
 * 逻辑：
 *   1) 白名单频道的“上传播放列表”(UU前缀) 用 playlistItems.list 拿近期 videoId（1 unit/频道）
 *   2) videos.list?part=snippet,liveStreamingDetails 批量(50/批, 1 unit/批) 判定 live/upcoming
 *   3) 输出：正在直播(_priority) → 即将开播预告，归一成 search 结果结构，前端沿用原渲染
 *
 * 密钥：Cloudflare 环境变量 YOUTUBE_API_KEY（Pages 项目 Settings → Environment variables，设为 Secret）
 * 加频道：改下面 CHANNEL_WHITELIST 常量即可（也可改读 env.CHANNEL_WHITELIST 逗号分隔）
 */

// 综合性/多项目频道：同一频道混播多种运动，需按排球关键词过滤，只留排球。
// 专门排球频道不在此列表，全部收录（不受关键词限制）。
const MIXED_SPORT_CHANNELS = {
  "UCw56njNrrXwcODpbacS3Tmw": "European Universities Games 2026", // @eug2026
  // 注：Latina Deportes (@LatinaDeportes) 已从白名单整体移除，不再抓取。
  "UCdkrHEDb1xT3gts9lct12Ug": "KBS N SPORTS", // @KBSNSPORTS_official 韩国综合体育台，仅留排球(含韩文 배구)
  "UCutSfYmIwdDOb4Ba7ObcaAQ": "HOY媒體網絡", // @hkhoy 香港综合电视网，仅留排球(含中文 排球)
};

const CHANNEL_WHITELIST_DEFAULT = [
  "UCjauoNHBQP5Pa_xH1cv-JRQ", // Asian Volleyball Confederation
  "UC8XRC858pOERvclUDb_d7rg", // European Volleyball
  "UCm-KUxgF1uOrwBb3_IRZR2A", // LOVB
  "UCitq3mixAs4qZX-4RX1OEtA", // Trực Tiếp Bóng Chuyền
  "UCTgQ8Bfq3AUuo1vWULdvRKw", // TVF VOLEYBOL TV
  "UCNMg6XDhRZI2QzL4pWOvP_w", // Volleyball World
  "UCaTF1soVKjGtdhizgLJVydg", // Volleyball World Italia
  "UCw56njNrrXwcODpbacS3Tmw", // European Universities Games 2026 (@eug2026)
  "UCKusmuVI9eJahQ-SQhapU6g", // Federata e Volejbollit e Kosovës (@federataevolejbollitekosov8866, 科索沃排球联合会)
  "UCdkrHEDb1xT3gts9lct12Ug", // KBS N SPORTS (@KBSNSPORTS_official, 韩国综合体育台)
  "UCiWIC7oM6VY_5JB1xvXNUzA", // Federazione Italiana Pallavolo - FIPAV (@Federvolley., 意大利排球联合会)
  "UChQi8LJ0aaACdXuZLpCeqKw", // TopVolley Belgium (@topvolleybelgium_, 比利时排球联赛)
  "UCXqb0HRIQMQiObmdgYvdZJg", // CAVB Live Streaming (@cavb.africa, 非洲排球联合会)
  "UCG-MqP6-9tdHNB9TtjJIrdA", // Oceania Volleyball (@OceaniaVolleyball, 大洋洲排球联合会)
  "UC2w2DZg9FTMWpoa9YKW7sXg", // OSSRB Odbojkaški savez Srbije (@OSSRBOdbojkaškisavezSrbije, 塞尔维亚排球联合会)
  "UCutSfYmIwdDOb4Ba7ObcaAQ", // HOY媒體網絡 (@hkhoy, 香港综合电视网 76/77/78台，仅留排球)
];

// ---- Volleyball World 预告缓存（server-side 内存缓存 + 惰性刷新）----
// VW 的 upcoming 预告走 YouTube 独立直播事件、不进 uploads 播放列表，
// 单靠 playlistItems 永远捞不到。改用 search?eventType=upcoming 后台定时抓取一次、缓存到服务器，
// 主页直接读缓存（零配额），不每次访问都 search（避免配额爆炸）。
const VW_CHANNEL_ID = "UCNMg6XDhRZI2QzL4pWOvP_w";
const VW_REFRESH_MS = 6 * 60 * 60 * 1000; // 缓存有效期 6h，过期才重新 search
const VW_MAX_UPCOMING = 10; // 主页最多释放最近 10 场预告
let _vwCache = null; // { ts, items:[{videoId,title,channelId,channelTitle,publishedAt,description,thumbnails,scheduledStart}] }
let _vwLockUntil = 0; // 刷新锁：时间戳，过期自动释放（防 waitUntil 不支持时锁死）

// 惰性刷新：缓存缺失或过期时触发一次后台 search（不阻塞当前请求）
function maybeRefreshVw(key, context) {
  if (_vwCache && Date.now() - _vwCache.ts <= VW_REFRESH_MS) return;
  if (Date.now() < _vwLockUntil) return; // 正在刷新或刚失败锁定中
  _vwLockUntil = Date.now() + 5 * 60 * 1000; // 最多锁 5 分钟，超时自愈
  const refreshPromise = (async () => {
    try {
      const sqs = new URLSearchParams({
        part: "snippet", channelId: VW_CHANNEL_ID, eventType: "upcoming",
        type: "video", maxResults: "20", key,
      });
      const { code, data } = await fetchJson(
        "https://www.googleapis.com/youtube/v3/search?" + sqs.toString(), 10000
      );
      if (code >= 400 || !data || !Array.isArray(data.items)) return;
      const ids = data.items
        .map((it) => (it && it.id && it.id.videoId ? String(it.id.videoId).trim() : ""))
        .filter(Boolean);
      if (!ids.length) { _vwCache = { ts: Date.now(), items: [] }; return; }
      const vqs = new URLSearchParams({
        part: "snippet,liveStreamingDetails", id: ids.join(","), key,
      });
      const { code: vcode, data: vdata } = await fetchJson(
        "https://www.googleapis.com/youtube/v3/videos?" + vqs.toString(), 12000
      );
      const items = [];
      if (vcode < 400 && vdata && Array.isArray(vdata.items)) {
        for (const v of vdata.items) {
          const sn = v.snippet || {};
          if ((sn.liveBroadcastContent || "none") !== "upcoming") continue;
          const lsd = v.liveStreamingDetails || {};
          if (!lsd.scheduledStartTime) continue;
          const titleRaw = sn.title || "";
          const tl = titleRaw.toLowerCase();
          if (tl.includes("beach") || titleRaw.includes("비치") || titleRaw.includes("沙滩")) continue;
          items.push({
            videoId: v.id, title: titleRaw,
            channelId: sn.channelId || VW_CHANNEL_ID, channelTitle: sn.channelTitle || "",
            publishedAt: sn.publishedAt || "", description: sn.description || "",
            thumbnails: sn.thumbnails || {}, scheduledStart: lsd.scheduledStartTime,
          });
        }
      }
      _vwCache = { ts: Date.now(), items };
    } catch (e) {
      // 刷新失败：保留旧缓存，锁到期后会重试
    } finally {
      _vwLockUntil = 0;
    }
  })();
  // CF Pages Functions 支持 context.waitUntil：保活后台刷新直到完成（否则可能返回后被冻结）
  if (context && typeof context.waitUntil === "function") {
    context.waitUntil(refreshPromise);
  }
}

function jsonResponse(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=60",
      "Access-Control-Allow-Origin": "*",
      ...extraHeaders,
    },
  });
}

async function fetchJson(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "vbplayer-cf/1.0" },
    });
    const code = r.status;
    let data = null;
    try { data = await r.json(); } catch (e) { data = null; }
    return { code, data };
  } catch (e) {
    return { code: 0, data: null, error: String(e) };
  } finally {
    clearTimeout(t);
  }
}

export async function onRequest(context) {
  const { env } = context;
  const key = env.YOUTUBE_API_KEY || env.YT_API_KEY;
  if (!key) {
    return jsonResponse(
      { error: { message: "Server missing YOUTUBE_API_KEY (set it in Pages env vars)" } },
      500
    );
  }

  // 白名单：优先环境变量（逗号分隔），否则用内置常量
  let whitelist = CHANNEL_WHITELIST_DEFAULT;
  if (env.CHANNEL_WHITELIST && typeof env.CHANNEL_WHITELIST === "string") {
    const arr = env.CHANNEL_WHITELIST.split(",")
      .map((s) => s.trim())
      .filter((s) => /^UC[0-9A-Za-z_-]{20,}$/.test(s));
    if (arr.length) whitelist = [...new Set(arr)];
  }

  const seen = {};
  const priorityItems = []; // 正在直播
  const priorityLater = []; // 即将开播预告

  // 1) 并发拉各频道上传播放列表（每频道单页，截断到前 25 条），收集 videoId
  async function fetchChannelUploads(cid) {
    const plId = "UU" + cid.slice(2);
    const vids = {};
    const qs = new URLSearchParams({ part: "contentDetails", maxResults: "50", playlistId: plId, key });
    const { code, data } = await fetchJson("https://www.googleapis.com/youtube/v3/playlistItems?" + qs.toString(), 10000);
    if (code >= 400 || !data || !Array.isArray(data.items)) return [];
    // playlistItems 单页最少可取 50，这里截断到前 25 条，避免列表过杂
    const items = data.items.slice(0, 25);
    for (const it of items) {
      const vid = it && it.contentDetails && it.contentDetails.videoId
        ? String(it.contentDetails.videoId).trim() : "";
      if (vid) vids[vid] = true;
    }
    return Object.keys(vids);
  }

  const allVideoIds = (await Promise.all(whitelist.map((cid) => fetchChannelUploads(cid)))).flat();
  const videoIdSet = {};
  for (const vid of allVideoIds) videoIdSet[vid] = true;
  const videoIds = Object.keys(videoIdSet);

  // 2) videos.list 批量判定 live/upcoming（每批 50）
  for (let i = 0; i < videoIds.length; i += 50) {
    const chunk = videoIds.slice(i, i + 50);
    if (!chunk.length) continue;
    const qs = new URLSearchParams({
      part: "snippet,liveStreamingDetails",
      id: chunk.join(","),
      key,
    });
    const vurl = "https://www.googleapis.com/youtube/v3/videos?" + qs.toString();
    const { code, data } = await fetchJson(vurl, 12000);
    if (code >= 400 || !data || !Array.isArray(data.items)) continue;

    const liveBatch = [];
    const upcomingBatch = [];
    for (const v of data.items) {
      const sn = v.snippet || {};
      const lbc = sn.liveBroadcastContent || "none";
      if (lbc !== "live" && lbc !== "upcoming") continue;
      const vid = v.id;
      if (seen[vid]) continue;
      const lsd = v.liveStreamingDetails || {};
      // 已结束的直播（liveStreamingDetails 含 actualEndTime）不再展示
      if (lsd.actualEndTime) continue;
      // 全局过滤沙滩排球（所有频道均生效）：beach(英)/비치(韩)/沙滩(中)
      const titleRaw = sn.title || "";
      const titleLower = titleRaw.toLowerCase();
      if (titleLower.includes("beach") || titleRaw.includes("비치") || titleRaw.includes("沙滩")) continue;
      // 综合性频道（多项目大赛/综合体育台）只保留排球场次；专门排球频道全收
      // 英文用 volley：区分 Volleyball/Beach Volley 与 Handball/Futsal/Padel/Table Tennis。
      // 韩文用 배구：KBS N SPORTS 等韩文标题里排球关键词为 배구（非 volley）。
      if (MIXED_SPORT_CHANNELS[sn.channelId]) {
        const title = (sn.title || "");
        const t = title.toLowerCase();
        // 英文 volley / 韩文 배구 / 中文 排球
        if (!t.includes("volley") && !title.includes("배구") && !title.includes("排球")) continue;
      }
      // upcoming 但无 scheduledStartTime：多为“直播已结束却未翻回 none”的卡住条目，丢弃
      if (lbc === "upcoming" && !lsd.scheduledStartTime) continue;
      seen[vid] = true;
      const scheduledStart = lsd.scheduledStartTime || "";
      const entry = {
        kind: "youtube#searchResult",
        id: { kind: "youtube#video", videoId: vid },
        snippet: {
          publishedAt: sn.publishedAt || "",
          channelId: sn.channelId || "",
          title: sn.title || "",
          description: sn.description || "",
          thumbnails: sn.thumbnails || {},
          channelTitle: sn.channelTitle || "",
          liveBroadcastContent: lbc,
        },
        _priority: true,
        _state: lbc,
        _scheduledStart: scheduledStart,
      };
      if (lbc === "live") liveBatch.push(entry);
      else upcomingBatch.push(entry);
    }
    upcomingBatch.sort((a, b) => (a._scheduledStart < b._scheduledStart ? -1 : a._scheduledStart > b._scheduledStart ? 1 : 0));
    for (const e of liveBatch) priorityItems.push(e);
    for (const e of upcomingBatch) priorityLater.push(e);
  }

  const items = priorityItems.concat(priorityLater);

  // 过滤已过期预告：开播时间早于当前(空值保留,前端不显示时间)
  const nowMs = Date.now();
  const filtered = items.filter((it) => {
    if (it._state !== "upcoming") return true;
    if (!it._scheduledStart) return true;
    const t = Date.parse(it._scheduledStart);
    if (isNaN(t)) return true;
    return t >= nowMs - 60 * 60 * 1000; // 留 1 小时缓冲,刚结束的也先保留
  });

  const liveN = filtered.filter((it) => it._state === "live").length;
  const upN = filtered.filter((it) => it._state === "upcoming").length;
  return jsonResponse({
    kind: "youtube#searchListResponse",
    pageInfo: {
      totalResults: filtered.length,
      resultsPerPage: filtered.length,
      liveCount: liveN,
      upcomingCount: upN,
      priorityCount: filtered.length,
    },
    items: filtered,
  });
}
