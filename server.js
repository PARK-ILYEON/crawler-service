import express from "express";
import { chromium } from "playwright";

const app = express();
const PORT = process.env.PORT || 8080;

/** 헬스체크 */
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

/** 네이버 상단 광고 1개 크롤링 */
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

    const ad = await page.evaluate(() => {
      // 1️⃣ "광고" 텍스트가 있는 span 찾기
      const adLabel = Array.from(document.querySelectorAll("span")).find(
        (el) => el.innerText.trim() === "광고"
      );
      if (!adLabel) return null;

      // 2️⃣ 광고 카드 전체 컨테이너 추적
      const card =
        adLabel.closest("div")?.parentElement?.parentElement ||
        adLabel.closest("div");

      if (!card) return null;

      // 3️⃣ 제목 + 링크
      const titleAnchor = card.querySelector("a");
      if (!titleAnchor) return null;

      const title = titleAnchor.innerText.trim();
      const link = titleAnchor.href;

      // 4️⃣ 이미지 (있으면)
      const img = card.querySelector("img")?.src || null;

      return {
        title,
        link,
        img,
      };
    });

    res.json({
      keyword,
      success: true,
      ad,
      crawledAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message,
    });
  } finally {
    if (browser) await browser.close();
  }
});

app.listen(PORT, () => {
  console.log(`crawler-service listening on ${PORT}`);
});
