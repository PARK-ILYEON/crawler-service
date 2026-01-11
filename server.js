import express from "express";
import { chromium } from "playwright";

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_, res) => res.json({ ok: true }));

app.post("/scrape/naver-ad-top", async (req, res) => {
  const { url, timeoutMs = 30000, waitMs = 1500 } = req.body || {};
  if (!url || typeof url !== "string") {
    return res.status(400).json({ ok: false, error: "url is required" });
  }

  let browser;
  const startedAt = Date.now();

  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
    });

    const context = await browser.newContext({
      viewport: { width: 1400, height: 900 },
      locale: "ko-KR",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    });

    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);

    await page.goto(url, { waitUntil: "domcontentloaded" });
    if (waitMs > 0) await page.waitForTimeout(waitMs);

    const topCard = await page.evaluate(() => {
      const uniq = (arr) => [...new Set(arr.filter(Boolean))];
      const adAnchors = Array.from(document.querySelectorAll('a[href*="ader.naver.com"]'));
      if (!adAnchors.length) return null;

      function findCardRoot(a) {
        let el = a;
        for (let i = 0; i < 12 && el; i++) {
          if (el.matches?.("section, div")) {
            const txt = (el.innerText || "").trim();
            const hasImg = !!el.querySelector("img");
            const adLinkCount = el.querySelectorAll('a[href*="ader.naver.com"]').length;
            if (txt.length >= 10 && (hasImg || adLinkCount >= 2)) return el;
          }
          el = el.parentElement;
        }
        return null;
      }

      const roots = [];
      for (const a of adAnchors) {
        const root = findCardRoot(a);
        if (root && !roots.includes(root)) roots.push(root);
      }
      if (!roots.length) return null;

      roots.sort((r1, r2) => (r1.getBoundingClientRect().top || 0) - (r2.getBoundingClientRect().top || 0));
      const root = roots[0];

      const aTexts = Array.from(root.querySelectorAll("a"))
        .map((a) => (a.textContent || "").replace(/\s+/g, " ").trim())
        .filter((t) => t && t.length >= 2 && t.length <= 60)
        .filter((t) => !["광고", "더보기", "바로가기"].includes(t));

      const titleCandidates = uniq(aTexts).slice(0, 6);

      const mainAdAnchors = Array.from(root.querySelectorAll('a[href*="ader.naver.com"]'));
      const main = mainAdAnchors
        .map((a) => ({
          href: a.getAttribute("href") || "",
          text: (a.textContent || "").replace(/\s+/g, " ").trim()
        }))
        .filter((x) => x.href)
        .sort((x, y) => (y.text.length || 0) - (x.text.length || 0))[0];

      const images = uniq(
        Array.from(root.querySelectorAll("img"))
          .map((img) => img.getAttribute("src") || "")
          .filter((s) => s && !s.startsWith("data:"))
      ).slice(0, 10);

      const summary = (root.innerText || "").replace(/\s+/g, " ").trim().slice(0, 350);

      return {
        titleCandidates,
        mainLink: main?.href || "",
        mainLinkText: main?.text || "",
        images,
        summary
      };
    });

    return res.json({
      ok: true,
      url,
      tookMs: Date.now() - startedAt,
      card: topCard
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      url,
      tookMs: Date.now() - startedAt,
      error: e?.message || String(e)
    });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`crawler-service listening on :${PORT}`));
