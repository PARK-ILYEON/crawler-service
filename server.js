import express from "express";
import { chromium } from "playwright";

const app = express();
const PORT = process.env.PORT || 8080;

/** Railway/헬스 체크 */
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

/** 루트(도메인만 쳤을 때 Cannot GET/ 방지) */
app.get("/", (req, res) => {
  res
    .status(200)
    .send("crawler-service is running. Try /health or /crawl?keyword=...");
});

/**
 * 네이버 검색 상단 '큰 광고 카드' 1개 뽑기
 * GET /crawl?keyword=에듀윌+편입+강남
 */
app.get("/crawl", async (req, res) => {
  const keyword = String(req.query.keyword || "").trim();
  if (!keyword) return res.status(400).json({ error: "keyword is required" });

  let browser;

  try {
    browser = await chromium.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      locale: "ko-KR",
    });

    const url = `https://search.naver.com/search.naver?query=${encodeURIComponent(
      keyword
    )}`;

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    // 상단 영역 렌더링 안정화 대기 (너무 길게 잡지 않음)
    await page.waitForTimeout(800);

    /**
     * ✅ 핵심: "상단 큰 카드 광고"는 DOM이 자주 바뀜
     * 그래서 '후보 컨테이너 셀렉터'를 여러 개 두고,
     * 먼저 잡히는 영역에서 링크/타이틀을 추출한다.
     */
    const candidates = [
      // (가장 흔한) 광고 영역/상단 광고 컨테이너 계열
      "section[data-testid*='ad']",
      "section:has(span:has-text('광고'))",
      "div:has(span:has-text('광고'))",
      "div.ad_area",
      "div[class*='ad_area']",
      "div[class*='power']",
      // 스크린샷 같은 카드형(이미지/버튼들 포함)일 가능성 대비
      "div:has(img) >> xpath=ancestor-or-self::*[.//span[contains(.,'광고')]]",
    ];

    let ad = null;

    // 후보 컨테이너를 순회하면서 "큰 카드"에서 첫 유효 링크를 찾는다.
    for (const sel of candidates) {
      const container = page.locator(sel).first();
      const cnt = await container.count();
      if (!cnt) continue;

      // 컨테이너 내부에서 "광고로 보이는 링크" 후보들
      const linkLocators = [
        "a[href*='adcr.naver.com']",
        "a[href*='ad.naver.com']",
        "a[href^='https://ad.']",
        "a[href*='nadsearch']",
        // 광고 컨테이너 안에 있는 일반 링크도 후보로(카드형은 외부 링크가 직접 박혀있기도 함)
        "a[href^='http']",
      ];

      let foundLink = null;

      for (const linkSel of linkLocators) {
        const a = container.locator(linkSel).first();
        if ((await a.count()) > 0) {
          const href = await a.getAttribute("href");
          if (href && href.length > 10) {
            foundLink = { locator: a, href };
            break;
          }
        }
      }

      if (!foundLink) continue;

      // 타이틀 추출(카드형은 안쪽 텍스트가 다양해서 최대한 방어적으로)
      const title = await container.evaluate((el) => {
        const pickText = (node) => (node?.innerText || node?.textContent || "").trim();

        // 1) 카드 제목으로 자주 쓰이는 후보들
        const titleCandidates = [
          el.querySelector("strong"),
          el.querySelector("h2"),
          el.querySelector("h3"),
          el.querySelector("[class*='title']"),
          el.querySelector("[class*='name']"),
          el.querySelector("a"),
        ].filter(Boolean);

        for (const n of titleCandidates) {
          const t = pickText(n);
          if (t && t.length >= 2 && t.length <= 80) return t;
        }

        // 2) fallback: 컨테이너 전체 텍스트에서 첫 줄
        const all = pickText(el);
        if (!all) return null;

        const firstLine = all.split("\n").map((s) => s.trim()).filter(Boolean)[0];
        return firstLine || null;
      });

      ad = {
        title: title || null,
        link: foundLink.href,
      };

      // 하나 찾으면 종료
      break;
    }

    res.json({
      success: true,
      keyword,
      url,
      ad, // 못 찾으면 null
      crawledAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err?.message || String(err),
    });
  } finally {
    if (browser) await browser.close();
  }
});

app.listen(PORT, () => {
  console.log(`crawler-service listening on ${PORT}`);
});
