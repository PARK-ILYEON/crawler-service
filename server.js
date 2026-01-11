// server.js (전체 교체 버전)
// Node 18+ / package.json에 "type": "module" 가정
import express from "express";
import { chromium } from "playwright";

const app = express();
const PORT = process.env.PORT || 8080;

// (선택) Railway/프록시 환경에서 ip/https 처리 안정화
app.set("trust proxy", 1);

/** 루트 안내 (Railway 도메인 접속 시 Not Found 안 뜨게) */
app.get("/", (req, res) => {
  res.type("text").send(
    [
      "crawler-service is running.",
      "",
      "Endpoints:",
      "  GET /health",
      "  GET /crawl?keyword=에듀윌 편입 강남",
      "  GET /crawl-multi?base=편입 강남",
      "",
      "Query:",
      "  /crawl      -> keyword (required)",
      "  /crawl-multi-> base (required)   // 내부에서 김영/에듀윌/해커스로 합성 검색",
    ].join("\n")
  );
});

/** 헬스체크 */
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

/** 단일 크롤링: 상단 '큰 카드 광고' 1개 */
app.get("/crawl", async (req, res) => {
  const keyword = (req.query.keyword || "").toString().trim();
  if (!keyword) return res.status(400).json({ error: "keyword is required" });

  const startedAt = Date.now();
  let browser;

  try {
    browser = await chromium.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const result = await crawlTopCardAd(browser, keyword);

    res.json({
      success: true,
      keyword,
      url: result.url,
      ad: result.ad, // 없으면 null
      crawledAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      keyword,
      error: err?.message || String(err),
      crawledAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
    });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

/**
 * 멀티 크롤링:
 * base="편입 강남" -> ["김영", "에듀윌", "해커스"] 붙여서
 *  - 김영 편입 강남
 *  - 에듀윌 편입 강남
 *  - 해커스 편입 강남
 * 각각의 "상단 큰 카드 광고" 1개씩 반환
 */
app.get("/crawl-multi", async (req, res) => {
  const base = (req.query.base || "").toString().trim();
  if (!base) return res.status(400).json({ error: "base is required" });

  const academies = ["김영", "에듀윌", "해커스"];
  const startedAt = Date.now();
  let browser;

  try {
    browser = await chromium.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const results = {};
    for (const academy of academies) {
      const keyword = `${academy} ${base}`.trim();
      const r = await crawlTopCardAd(browser, keyword);
      results[academy] = {
        academy,
        keyword,
        url: r.url,
        ad: r.ad, // 없으면 null
      };
    }

    res.json({
      success: true,
      base,
      results,
      crawledAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      base,
      error: err?.message || String(err),
      crawledAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
    });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

/**
 * 핵심: 네이버 검색 결과에서 "상단 큰 카드형 광고"를 최대한 방어적으로 파싱
 * - advertiser (광고주명)
 * - headline (메인문구)
 * - schedule (일정/날짜로 보이는 텍스트 후보)
 * - tags (알약 태그)
 * - badges (하단 이벤트 배지/버튼 3개 구조)
 * - image (대표 이미지)
 * - link (광고 클릭 링크)
 */
async function crawlTopCardAd(browser, keyword) {
  const page = await browser.newPage({
    // (선택) 네이버가 UA에 민감할 때가 있어 기본값보다 현실적인 UA로
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });

  const url = `https://search.naver.com/search.naver?query=${encodeURIComponent(
    keyword
  )}`;

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  // 카드형 광고가 lazy로 뜰 때가 있어 약간 기다림
  await page.waitForTimeout(800);

  // 최대한 범용적으로: "ad.search.naver.com" 또는 "adcr.naver.com"를 포함한 링크를 찾고,
  // 그 링크를 감싸는 가장 큰 "카드 컨테이너"를 추정해서 파싱한다.
  const ad = await page.evaluate(() => {
    const pickText = (el) => (el?.innerText || el?.textContent || "").trim();
    const uniq = (arr) => [...new Set(arr.map((s) => s.trim()).filter(Boolean))];

    // 1) 광고 링크 앵커 찾기 (상단 카드형은 보통 광고 링크를 포함)
    const anchor =
      document.querySelector(
        "a[href*='ad.search.naver.com'],a[href*='adcr.naver.com'],a[href*='ad.naver.com']"
      ) || null;

    if (!anchor) return null;

    // 2) 카드 컨테이너 추정: 앵커에서 위로 올라가면서
    //    - img가 있고
    //    - 텍스트가 어느 정도 있고
    //    - '광고' 텍스트가 주변에 있는
    //    블록을 우선한다.
    const candidates = [];
    let cur = anchor;
    for (let i = 0; i < 12 && cur; i++) {
      const el = cur instanceof Element ? cur : null;
      if (el) {
        const hasImg = !!el.querySelector("img");
        const textLen = pickText(el).length;
        const hasAdMark = pickText(el).includes("광고");
        if (hasImg && textLen > 30) {
          candidates.push({ el, score: textLen + (hasAdMark ? 500 : 0) });
        }
      }
      cur = cur.parentElement;
    }

    // fallback: 그냥 anchor parent
    const container =
      candidates.sort((a, b) => b.score - a.score)[0]?.el ||
      anchor.parentElement;

    if (!container) return null;

    // 3) 이미지(대표 썸네일)
    const imgEl =
      container.querySelector("img") ||
      anchor.querySelector("img") ||
      container.querySelector("img[src]");
    const image = imgEl?.src || null;

    // 4) 광고주명(좌상단에 브랜드명/광고주명이 있을 확률이 큼)
    //    - 카드 내에서 가장 위쪽 라인의 짧은 텍스트를 후보로 잡는다.
    //    - 또는 로고 옆 텍스트(브랜드)
    let advertiser = null;
    {
      const textBlocks = Array.from(container.querySelectorAll("a,span,strong,em,div,p"))
        .map((n) => ({ n, t: pickText(n) }))
        .filter((x) => x.t && x.t.length >= 2 && x.t.length <= 20);

      // 상단에 가까운 것 우선: top 좌표 기준
      const withPos = textBlocks
        .map((x) => {
          const r = x.n.getBoundingClientRect();
          return { ...x, top: r.top, left: r.left };
        })
        .sort((a, b) => a.top - b.top || a.left - b.left);

      // "광고" 같은 단어는 제외
      const filtered = withPos.filter(
        (x) =>
          !x.t.includes("광고") &&
          !x.t.includes("새소식") &&
          !x.t.includes("img") &&
          x.t.length <= 20
      );

      advertiser = filtered[0]?.t || null;
    }

    // 5) 메인 헤드라인: 보통 파란색 큰 글씨 → strong/h3/a 텍스트가 길고 의미 있는 것
    let headline = null;
    {
      const candidates = Array.from(container.querySelectorAll("h3,strong,a,div,span"))
        .map((n) => pickText(n))
        .filter((t) => t && t.length >= 6 && t.length <= 80)
        // 너무 흔한 라벨 제거
        .filter((t) => !t.includes("광고") && !t.includes("새소식"))
        // 날짜만 있는 라벨 제거
        .filter((t) => !/^\d{1,2}\/\d{1,2}/.test(t));

      // headline은 대개 가장 "길고 의미 있는" 문장
      headline = candidates.sort((a, b) => b.length - a.length)[0] || null;
    }

    // 6) 일정/날짜 추출(완벽 정규화는 나중에)
    //    카드 안에서 날짜 패턴이 있는 텍스트를 모아 첫 번째를 schedule로.
    let schedule = null;
    {
      const allText = pickText(container);
      // 흔한 패턴: 1/22(목), 2/22(일), 2027, "오후", "저녁", "온라인"
      const m =
        allText.match(/\b\d{1,2}\/\d{1,2}\s*\([^)]+\)/) ||
        allText.match(/\b\d{1,2}\/\d{1,2}\b/) ||
        allText.match(/\b20\d{2}\b/);
      schedule = m ? m[0] : null;
    }

    // 7) 태그(알약 pill): 버튼/스팬 형태로 짧은 단어들이 여러 개
    let tags = [];
    {
      const tagText = Array.from(container.querySelectorAll("a,button,span,em,div"))
        .map((n) => pickText(n))
        .filter((t) => t && t.length >= 2 && t.length <= 12)
        .filter((t) => !t.includes("광고") && !t.includes("새소식"))
        .filter((t) => !/^\d{1,2}\/\d{1,2}/.test(t));

      // 카드 하단의 큰 배지 텍스트랑 섞일 수 있어서,
      // "상대적으로 짧은 텍스트" 위주로 uniq.
      tags = uniq(tagText).slice(0, 12);
    }

    // 8) 배지(이벤트 박스 3개): 박스 안에 줄 2개(큰 문구 + 작은 문구)가 많음
    //    DOM 구조를 모르니, "자주 등장하는 짧은 라인"을 묶는 휴리스틱으로 간다.
    let badges = [];
    {
      // 후보: '예약하기', '%', '환급', '지원', '상담' 같은 키워드가 섞인 라인들
      const lines = pickText(container)
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);

      const badgeLines = lines.filter((t) =>
        /(예약|상담|환급|지원|패스|무료|체험|이벤트|합격|개강|설명회|특강|쿠폰)/.test(t)
      );

      // 너무 많이 잡히면 앞쪽만
      const cleaned = uniq(badgeLines).slice(0, 10);

      // 2줄로 구성된 배지를 만들기 어렵다면 1줄 label로라도 내려준다
      badges = cleaned.map((t) => ({ label: t, sub: null }));
    }

    // 9) 링크
    const link = anchor.href || null;

    return {
      advertiser,
      headline,
      schedule,
      tags,
      badges,
      image,
      link,
    };
  });

  await page.close().catch(() => {});
  return { url, ad };
}

app.listen(PORT, () => {
  console.log(`crawler-service listening on ${PORT}`);
});
