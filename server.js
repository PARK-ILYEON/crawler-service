import express from "express";
import { chromium } from "playwright";

const app = express();
const PORT = process.env.PORT || 8080;

/** 헬스체크 */
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

/** 크롤링: 상단 광고 1개 */
app.get("/crawl", async (req, res) => {
  const keyword = req.query.keyword;
  if (!keyword) {
    return res.status(400).json({ error: "keyword is required" });
  }

  let browser;
  try {
    browser = await chromium.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();
    const url = `https://search.naver.com/search.naver?query=${encodeURIComponent(
      keyword
    )}`;

    await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });

    // ⚠️ 네이버 DOM은 자주 바뀜 → 최대한 방어적으로 선택
    const ad = await page.evaluate(() => {
      const anchor = document.querySelector("a[href*='adcr.naver.com'], a[href*='ad.naver.com']");
      if (!anchor) return null;

      return {
        title: anchor.innerText?.trim() || null,
        link: anchor.href,
      };
    });

    res.json({
      keyword,
      ad,
      crawledAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (browser) await browser.close();
  }
});

app.listen(PORT, () => {
  console.log(`crawler-service listening on ${PORT}`);
});

