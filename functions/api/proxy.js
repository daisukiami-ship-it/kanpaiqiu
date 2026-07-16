/**
 * proxy.js — Cloudflare Pages Function
 * 对应原 Pantheon 的 proxy.php：HLS/m3u8 转发代理，解决源站 CORS 缺失 / 需特定 Referer。
 *
 * 路由：/api/proxy?url=<绝对URL>&referer=<可选>
 *
 * 注意：Cloudflare 边缘节点 IP 是全球分布的，对地域封锁源（如 TRT 的 CloudFront）
 *       同样可能被 403 —— 这与 Pantheon 的地域问题本质相同，代理改变不了 IP 地理位置。
 *       TRT 已在前端改为超链接跳官网，本代理主要服务 VBTV/TVF 等无地域锁的源。
 *
 * 安全：仅允许 http/https；用白名单限制可代理域名，避免开放代理(SSRF)。
 */

const ALLOW_HOSTS = [
  "livecdn.euw1-0008.jwpllive.com",
  "tv.volleyballworld.com",
  "www.trtspor.com.tr",
  "trtspor.com.tr",
  "trt-live.ercdn.net",
  "www.tvf.org.tr",
  "tvf.org.tr",
];
const ALLOW_SUFFIXES = [".jwpllive.com", ".ercdn.net", ".daioncdn.net", ".medya.trt.com.tr"];

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";

function textResponse(body, status) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" },
  });
}

function hostAllowed(host) {
  host = (host || "").toLowerCase();
  if (ALLOW_HOSTS.map((h) => h.toLowerCase()).includes(host)) return true;
  for (const suf of ALLOW_SUFFIXES) {
    if (suf && host.endsWith(suf.toLowerCase())) return true;
  }
  return false;
}

function resolveUrl(u, base, dir) {
  if (/^https?:\/\//i.test(u)) return u;      // 已是绝对
  if (u[0] === "/") return base + u;          // 站点根相对
  return base + dir + u;                       // 目录相对
}

export async function onRequest(context) {
  const { request } = context;
  const reqUrl = new URL(request.url);
  const target = (reqUrl.searchParams.get("url") || "").trim();
  const referer = (reqUrl.searchParams.get("referer") || "").trim();

  if (!target) return textResponse("missing url", 400);

  let parts;
  try {
    parts = new URL(target);
  } catch (e) {
    return textResponse("invalid url", 400);
  }
  if (!["http:", "https:"].includes(parts.protocol)) return textResponse("invalid url", 400);
  if (!hostAllowed(parts.hostname)) return textResponse("host not allowed", 403);

  const headers = { "User-Agent": UA };
  if (referer) {
    headers["Referer"] = referer;
    headers["Origin"] = parts.protocol + "//" + parts.hostname;
  }

  let upstream;
  try {
    upstream = await fetch(target, { headers, redirect: "follow" });
  } catch (e) {
    return textResponse("proxy error: " + String(e), 502);
  }

  if (upstream.status >= 400) {
    return textResponse("proxy error: HTTP " + upstream.status, upstream.status);
  }

  const ctype = upstream.headers.get("content-type") || "application/octet-stream";
  const isM3u8Type = /mpegurl/i.test(ctype) || /\.m3u8($|\?)/i.test(target);

  // 先读文本（m3u8 需要），若非文本则回退为二进制
  let bodyText = null;
  let bodyBuf = null;
  if (isM3u8Type) {
    bodyText = await upstream.text();
  } else {
    // 可能是 m3u8 但 content-type 不标准：先读文本探测 #EXTM3U
    bodyBuf = await upstream.arrayBuffer();
    const head = new TextDecoder().decode(bodyBuf.slice(0, 16));
    if (head.replace(/^\s+/, "").startsWith("#EXTM3U")) {
      bodyText = new TextDecoder().decode(bodyBuf);
    }
  }

  const isM3u8 = bodyText !== null;

  if (isM3u8) {
    // 重写 m3u8 内分片 URL 走本代理
    const base =
      parts.protocol + "//" + parts.hostname + (parts.port ? ":" + parts.port : "");
    const dir = parts.pathname.replace(/\/[^/]*$/, "/");
    const self = reqUrl.origin + reqUrl.pathname; // 本代理路径 /api/proxy
    const refQS = referer ? "&referer=" + encodeURIComponent(referer) : "";

    const out = [];
    for (const rawLine of bodyText.split(/\r?\n/)) {
      const t = rawLine.trim();
      if (t === "" || t[0] === "#") {
        if (/URI="/i.test(t)) {
          const line = rawLine.replace(/URI="([^"]+)"/i, (m, p1) => {
            const abs = resolveUrl(p1, base, dir);
            return 'URI="' + self + "?url=" + encodeURIComponent(abs) + refQS + '"';
          });
          out.push(line);
        } else {
          out.push(rawLine);
        }
        continue;
      }
      const abs = resolveUrl(t, base, dir);
      out.push(self + "?url=" + encodeURIComponent(abs) + refQS);
    }
    return new Response(out.join("\n"), {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  // 非 m3u8：原样透传二进制
  return new Response(bodyBuf, {
    status: 200,
    headers: {
      "Content-Type": ctype,
      "Access-Control-Allow-Origin": "*",
    },
  });
}
