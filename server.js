import express from "express";
import { chromium } from "playwright";

const app = express();
const PORT = process.env.PORT || 8080;

/**
 * ✅ 헬스 체크 (Railway / n8n 확인용)
 */
app.get("/health", (req, res) => {
  res.status(200).json({ ok: true, service: "crawler-service" });
});

/**
 * ✅ 네이버 검색 – 상단 광고 1개 크롤링
 * GET /crawl?keyword=에듀윌+편입+강남
 */
app.get("/crawl", async (req, res) => {
  const { keyword } = req.query;

  if (!keyword) {
    return res.status(400).json({
      error: "keyword query parameter is required",
    });
  }

  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });

    const page = await browser.newPage({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
    });

    const searchUrl = `https://search.naver.com/search.naver?query=${encodeURIComponent(
      keyword
    )}`;

    await page.goto(searchUrl, {
      waitUntil: "networkidle",
      timeout: 60000,
    });

    /**
     * ⚠️ 네이버 광고 DOM은 자주 바뀌므로
     * "광고 도메인" 기준으로 최대한 방어적으로 추출
     */
    const ad = await page.evaluate(() => {
      const adLink = document.querySelector(
        "a[href*='adcr.naver.com'], a[href*='ad.naver.com']"
      );

      if (!adLink) return null;

      return {
        title: adLink.innerText?.trim() || null,
        link: adLink.href,
      };
    });

    res.json({
      keyword,
      ad,
      success: true,
      crawledAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("❌ Crawl Error:", error);

    res.status(500).json({
      success: false,
      error: error.message,
    });
  } finally {
    if (browser) {
      await browser.close();
    }
  }
});

/**
 * ✅ 서버 시작
 */
app.listen(PORT, () => {
  console.log(`🚀 crawler-service running on port ${PORT}`);
});

