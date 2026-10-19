import type {} from "./request-context.js";
import type { FastifyInstance, RouteShorthandOptions } from "fastify";

/** Link preview inspection for pasted URLs; the parent retains authentication, CSRF, errors and rate limits. */
export function registerLinkInspectRoutes(app: FastifyInstance, options: {
  routeOptions: Pick<RouteShorthandOptions, "config">;
}) {
  const { routeOptions: defaultRouteRateLimitOptions } = options;
  app.get("/api/links/inspect", defaultRouteRateLimitOptions, async (request, reply) => {
    const query = request.query as { url?: string };
    const rawUrl = typeof query?.url === "string" ? query.url.trim() : "";
    if (!rawUrl) {
      return reply.code(400).send({ message: "URL is required." });
    }

    let normalizedUrl = rawUrl;
    if (!/^https?:\/\//i.test(normalizedUrl)) {
      normalizedUrl = `https://${normalizedUrl}`;
    }

    let parsed: URL;
    try {
      parsed = new URL(normalizedUrl);
    } catch {
      return reply.code(400).send({ message: "Invalid link URL." });
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return reply.code(400).send({ message: "Only HTTP and HTTPS URLs are supported." });
    }

    let title = parsed.hostname;
    let canEmbed = parsed.protocol === "https:";
    let openMode: "EMBEDDED" | "NEW_TAB" = canEmbed ? "EMBEDDED" : "NEW_TAB";

    const hostLower = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const isYouTube = hostLower === "youtube.com" || hostLower === "m.youtube.com" || hostLower === "music.youtube.com" || hostLower === "youtu.be";
    // The web app plays these in its YouTube pane (isYouTubeUrl in App.tsx), so youtube.com's frame headers do not apply; music.youtube.com opens in a frame.
    const playsInYouTubePane = isYouTube && hostLower !== "music.youtube.com";

    if (isYouTube) {
      if (playsInYouTubePane) {
        canEmbed = true;
        openMode = "EMBEDDED";
      }

      try {
        let canonicalTarget = parsed.toString();
        let videoId: string | null = null;
        if (hostLower === "youtu.be") {
          const id = parsed.pathname.slice(1).split("/")[0] ?? "";
          if (/^[A-Za-z0-9_-]{11}$/.test(id)) videoId = id;
        } else {
          const v = parsed.searchParams.get("v");
          if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) {
            videoId = v;
          } else {
            const segments = parsed.pathname.split("/").filter(Boolean);
            if (segments[0] === "shorts" || segments[0] === "live" || segments[0] === "embed" || segments[0] === "v") {
              const segId = segments[1] ?? "";
              if (/^[A-Za-z0-9_-]{11}$/.test(segId)) videoId = segId;
            }
          }
        }
        if (videoId) {
          canonicalTarget = `https://www.youtube.com/watch?v=${videoId}`;
        }

        const oembedRes = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(canonicalTarget)}&format=json`, {
          signal: AbortSignal.timeout(3500)
        });
        if (oembedRes.ok) {
          const oembedData = (await oembedRes.json()) as { title?: string };
          if (oembedData && typeof oembedData.title === "string" && oembedData.title.trim()) {
            const clean = oembedData.title.trim().slice(0, 160);
            if (clean && clean !== "- YouTube" && clean.toLowerCase() !== "youtube") {
              return {
                url: parsed.toString(),
                title: clean,
                openMode: playsInYouTubePane ? "EMBEDDED" : "NEW_TAB",
                canEmbed: playsInYouTubePane
              };
            }
          }
        }
      } catch {}
    }

    try {
      const response = await fetch(parsed.toString(), {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        },
        signal: AbortSignal.timeout(4000),
        redirect: "follow"
      });

      const xFrameOptions = (response.headers.get("x-frame-options") || "").toLowerCase();
      const csp = (response.headers.get("content-security-policy") || "").toLowerCase();

      if (playsInYouTubePane) {
        // Embedded through the YouTube pane, not a frame of this page.
      } else if (xFrameOptions.includes("deny") || xFrameOptions.includes("sameorigin")) {
        canEmbed = false;
      } else if (csp.includes("frame-ancestors")) {
        const match = csp.match(/frame-ancestors\s+([^;]+)/);
        if (match && match[1]) {
          const val = match[1].trim();
          if (val.includes("'none'") || val.includes("'self'") || (!val.includes("*") && !val.includes("https:"))) {
            canEmbed = false;
          }
        }
      }

      if (!canEmbed || parsed.protocol === "http:") {
        openMode = "NEW_TAB";
      } else {
        openMode = "EMBEDDED";
      }

      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("text/html") || contentType.includes("application/xhtml") || !contentType) {
        const text = await response.text();

        const sanitize = (raw: string) => {
          let cleaned = raw.trim()
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&nbsp;/g, " ")
            .replace(/\\u0026/g, "&")
            .replace(/\\"/g, '"')
            .replace(/\s+/g, " ");
          if (isYouTube) {
            cleaned = cleaned.replace(/\s*[-–—|]\s*YouTube$/i, "").trim();
            if (cleaned === "- YouTube" || cleaned.toLowerCase() === "youtube" || cleaned === "-" || cleaned === "undefined") {
              return "";
            }
          }
          return cleaned;
        };

        let candidateTitle = "";

        if (isYouTube) {
          const vdMatch = text.match(/"videoDetails":\{"videoId":"[^"]+","title":"([^"]+)"/);
          if (vdMatch && vdMatch[1]) {
            candidateTitle = sanitize(vdMatch[1]);
          }
          if (!candidateTitle) {
            const plMatch = text.match(/"header":\{"playlistHeaderRenderer":\{"title":\{"runs":\[\{"text":"([^"]+)"/);
            if (plMatch && plMatch[1]) candidateTitle = sanitize(plMatch[1]);
          }
          if (!candidateTitle) {
            const runsMatch = text.match(/"title":\{"runs":\[\{"text":"([^"]+)"\}/);
            if (runsMatch && runsMatch[1]) candidateTitle = sanitize(runsMatch[1]);
          }
        }

        if (!candidateTitle) {
          const ogTitleMatch = text.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i)
            || text.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:title["']/i)
            || text.match(/<meta[^>]*name=["']title["'][^>]*content=["']([^"']+)["']/i)
            || text.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']title["']/i);
          if (ogTitleMatch && ogTitleMatch[1]) {
            candidateTitle = sanitize(ogTitleMatch[1]);
          }
        }

        if (!candidateTitle) {
          const titleMatch = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
          if (titleMatch && titleMatch[1]) {
            candidateTitle = sanitize(titleMatch[1]);
          }
        }

        if (candidateTitle) {
          title = candidateTitle.slice(0, 160);
        }
      }
    } catch {
      canEmbed = parsed.protocol === "https:";
      openMode = canEmbed ? "EMBEDDED" : "NEW_TAB";
    }

    return {
      url: parsed.toString(),
      title,
      openMode,
      canEmbed
    };
  });
}
