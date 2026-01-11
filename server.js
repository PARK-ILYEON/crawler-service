import express from "express";
import { chromium } from "playwright";

const app = express();
const PORT = process.env.PORT || 8080;

function clean(s) {
  return (s || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function uniq(arr) {
  return Array.from(new Set((arr || []).map(clean).filter(Boolean)));
}

function isScheduleLike(t) {
  const s = clean(t);
  if (!s) return false;
  return (
    /(\d{1,2}\/\d{1,2})/.test(s) ||
    /(\d{1,2}월\s*\d{1,2}일)/.test(s) ||
    /(오전|오후|저녁|밤|낮)\s*\d{1,2}시/.test(s) ||
    /(\d{1,2}:\d{2})/.test(s)
  );
}

/**
 * 네이버 상단 "큰 광고 카드" 1개 추출
 * - title, link, img
 * - advertiser, headline, schedule, tags, badges
 */
async function extractBigCardAd(page, keyword) {
  const url = `https://search.naver.com/search.naver?query=${encodeURIComponent(
    keyword
  )}`;

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(900);

  const ad = await page.evaluate(() => {
    const clean = (s) =>
      (s || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
    const uniq = (arr) => Array.from(new Set(arr.map(clean).filter(Boolean)));
    const isScheduleLike = (t) => {
      const s = clean(t);
      if (!s) return false;
      return (
        /(\d{1,2}\/\d{1,2})/.test(s) ||
        /(\d{1,2}월\s*\d{1,2}일)/.test(s) ||
        /(오전|오후|저녁|밤|낮)\s*\d{1,2}시/.test(s) ||
        /(\d{1,2}:\d{2})/.test(s)
      );
    };

    // 광고 링크(큰 카드 클릭 링크) 우선 탐색
    const a =
      document.querySelector(
        "a[href*='ad.search.naver.com'], a[href*='adcr.naver.com'], a[href*='ad.naver.com'], a[href*='nadsearch']"
      ) || null;
    if (!a) return null;

    // 링크 주변에서 "광고" 라벨이 포함된 큰 블록(컨테이너) 추정
    const candidates = [];
    let el = a;
    for (let i = 0; i < 12 && el; i++) {
      if (el instanceof HTMLElement) {
        const tag = el.tagName.toLowerCase();
        if (["div", "section", "article"].includes(tag)) candidates.push(el);
      }
      el = el.parentElement;
    }

    const container =
      candidates.find((c) => (c.innerText || "").includes("광고")) ||
      a.closest("div, section, article") ||
      a.parentElement;

    if (!container) return null;

    // 카드형일 확률 체크: 라인이 너무 적으면 제외
    const lines = (container.innerText || "")
      .split("\n")
      .map(clean)
      .filter(Boolean);

    if (lines.length < 3) return null;

    const title = clean(a.innerText) || null;
    const link = a.href || null;
    const img = container.querySelector("img")?.src || null;

    // schedule
    const schedule = lines.find(isScheduleLike) || null;

    // advertiser: "광고" 라벨 위쪽 or 첫 줄
    const idxAd = lines.findIndex((t) => t === "광고");
    const advertiserCandidates = [];
    if (idxAd > 0) advertiserCandidates.push(lines[idxAd - 1]);
    advertiserCandidates.push(lines[0]);

    const advertiser =
      advertiserCandidates.find((t) => t && t.length <= 30) || null;

    // tags: 짧은 칩 텍스트(강남/신촌/노원/부평 등)
    const tags = uniq(
      lines.filter((t) => {
        const s = clean(t);
        if (!s || s === "광고") return false;
        if (s.length > 6) return false;
        if (/^[0-9+\-/%\s]+$/.test(s)) return false;
        return true;
      })
    );

    // badges: 이벤트/퍼센트/1+1/환급 등
    const badges = uniq(
      lines.filter((t) => {
        const s = clean(t);
        if (!s || s === "광고") return false;
        if (s.length > 18) return false;
        return /(\d+%|\d+\+\d+|이벤트|환급|할인|쿠폰|무료|혜택)/.test(s);
      })
    );

    // headline: blacklist 제외한 가장 그럴듯한 문장
    const blacklist = new Set(
      uniq(["광고", advertiser, schedule, ...tags, ...badges, title]).map(clean)
    );

    const headline =
      lines.find((t) => {
        const s = clean(t);
        if (!s) return false;
        if (blacklist.has(s)) return false;
        if (s.length < 7) return false;
        return true;
      }) || null;

    return { title, link, img, advertiser, headline, schedule, tags, badges };
  });

  return { keyword, url, ad };
}

/** 헬스체크 */
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

/** 루트 안내 */
app.get("/", (req, res) => {
  res
    .status(200)
    .send(
      "crawler-service is running. Try /crawl?keyword=... or /crawl-multi?base=편입+강남"
    );
});

/**
 * 단일 크롤링
 * GET /crawl?keyword=에듀윌+편입+강남
 */
app.get("/crawl", async (req, res) => {
  const keyword = clean(req.query.keyword || "");
  const crawledAt = new Date().toISOString();

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

    const result = await extractBigCardAd(page, keyword);

    res.json({
      success: true,
      crawledAt,
      ...result,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      crawledAt,
      error: err?.message || String(err),
    });
  } finally {
    if (browser) await browser.close();
  }
});

/**
 * ✅ 한번의 호출로 3개 학원(김영/에듀윌/해커스) 각각 "다시 검색" 후 카드뉴스(큰 카드) 추출
 * GET /crawl-multi?base=편입+강남
 *
 * 반환:
 * {
 *   results: {
 *     "김영": { keyword, url, ad },
 *     "에듀윌": { keyword, url, ad },
 *     "해커스": { keyword, url, ad }
 *   }
 * }
 */
app.get("/crawl-multi", async (req, res) => {
  const base = clean(req.query.base || "편입 강남");
  const crawledAt = new Date().toISOString();

  // 필요하면 여기서 브랜드 키워드 바꿔도 됨
  const brands = [
    { name: "김영", keyword: `김영 ${base}` },
    { name: "에듀윌", keyword: `에듀윌 ${base}` },
    { name: "해커스", keyword: `해커스 ${base}` },
  ];

  let browser;

  try {
    browser = await chromium.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    // ✅ 브라우저 1개, 페이지 1개 재사용(제일 안정적)
    const page = await browser.newPage({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      locale: "ko-KR",
    });

    const results = {};
    for (const b of brands) {
      results[b.name] = await extractBigCardAd(page, b.keyword);
    }

    res.json({
      success: true,
      base,
      crawledAt,
      results,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      base,
      crawledAt,
      error: err?.message || String(err),
    });
  } finally {
    if (browser) await browser.close();
  }
});

app.listen(PORT, () => {
  console.log(`crawler-service listening on ${PORT}`);
});
