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
  // 注：Latina Deportes (@LatinaDeportes) 已移出本名单 —— 用户要求显示其全部直播（含足球 Copa Sudamericana），不再限排球。
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
  "UC5P87cB2LXUMmmn3W4v9o_w", // Latina Deportes (@LatinaDeportes, 秘鲁综合体育台)
  "UCKusmuVI9eJahQ-SQhapU6g", // Federata e Volejbollit e Kosovës (@federataevolejbollitekosov8866, 科索沃排球联合会)
];

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

  // 1) 并发拉各频道上传播放列表，收集近期 videoId
  const plUrls = whitelist.map((cid) => {
    const plId = "UU" + cid.slice(2);
    // 综合性频道（多项目大赛）一天上传几十条，排球易被其它项目挤出最新 15 条窗口，
    // 故对其拉取上限 50 条（playlistItems 单页上限）；专门排球频道 15 条足够。
    const maxResults = MIXED_SPORT_CHANNELS[cid] ? "50" : "15";
    const qs = new URLSearchParams({
      part: "contentDetails",
      maxResults,
      playlistId: plId,
      key,
    });
    return "https://www.googleapis.com/youtube/v3/playlistItems?" + qs.toString();
  });

  const plResults = await Promise.all(plUrls.map((u) => fetchJson(u, 10000)));
  const videoIdSet = {};
  for (const res of plResults) {
    const j = res.data;
    if (!j || !Array.isArray(j.items)) continue;
    for (const it of j.items) {
      const vid = it && it.contentDetails && it.contentDetails.videoId
        ? String(it.contentDetails.videoId).trim()
        : "";
      if (vid) videoIdSet[vid] = true;
    }
  }
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
      // 综合性频道（多项目大赛）只保留排球场次；专门排球频道全收
      // （其比赛标题常不含 volleyball 字样，如 "vs. - Round of 16..."）。
      // 关键词用 volley：可区分 Volleyball/Beach Volley 与 Handball/Futsal/Padel/Table Tennis。
      if (MIXED_SPORT_CHANNELS[sn.channelId]) {
        const title = (sn.title || "").toLowerCase();
        if (!title.includes("volley")) continue;
      }
      seen[vid] = true;
      const lsd = v.liveStreamingDetails || {};
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
