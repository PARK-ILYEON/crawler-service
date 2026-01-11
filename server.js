import express from "express";
import { chromium } from "playwright";

const app = express();
const PORT = process.env.PORT || 8080;

// ==============================
// 공통 유틸
// ==============================
function cleanText(s) {
  return (s || "")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniq(arr) {
  return [...new Set((arr || []).map((x) => cleanText(x)).filter(Boolean))];
}

// “상단 큰 광고 카드”를 DOM에서 찾아서 필요한 필드 추출
// - 네이버 DOM이 자주 바뀌므로 “광고” 배지 + 카드형 구조(이미지/버튼/태그/뱃지) 기준으로 최대한 방어적으로 탐색
async function extractTopAdCard(page) {
  // 네이버가 늦게 뜨는 경우가 많아서 최소한 “광고” 텍스트를 기다림(없을 수도 있음)
  // 광고가 없으면 null 반환
  try {
    await page.waitForSelector("text=광고", { timeout: 8000 });
  } catch (e) {
    // 광고 배지 자체가 없으면(또는 로딩 실패) 그냥 null
    return null;
  }

  const ad = await page.evaluate(() => {
    const clean = (s) =>
      (s || "")
        .replace(/\u00A0/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    // “광고” 배지를 가진 요소를 찾고, 그 주변에서 가장 그럴듯한 “카드 컨테이너”를 역으로 올라가며 찾는다.
    const adBadges = Array.from(document.querySelectorAll("*"))
      .filter((el) => clean(el.textContent) === "광고")
      .slice(0, 30);

    const scoreCard = (root) => {
      if (!root || !(root instanceof HTMLElement)) return -1;

      const text = clean(root.innerText || "");
      if (!text) return -1;

      // 너무 큰 컨테이너(페이지 전체) 배제
      if (text.length > 1500) return -1;

      const hasImg = !!root.querySelector("img");
      const hasLink = !!root.querySelector("a[href]");
      const hasButtons = root.querySelectorAll("a,button").length >= 3;

      // 태그/칩/뱃지 비슷한 짧은 텍스트가 여러 개 있으면 카드일 확률↑
      const shortTexts = Array.from(root.querySelectorAll("a,button,span,em,strong"))
        .map((x) => clean(x.textContent))
        .filter((t) => t && t.length >= 1 && t.length <= 10);

      const shortScore = Math.min(20, new Set(shortTexts).size);

      let score = 0;
      if (hasImg) score += 3;
      if (hasLink) score += 2;
      if (hasButtons) score += 2;
      score += shortScore;

      // “새소식/이벤트/설명회/개강/환급/할인” 같은 문구가 있으면 가산
      if (/[새소식|이벤트|설명회|개강|환급|할인|무료|상담]/.test(text)) score += 3;

      return score;
    };

    const findBestCardFrom = (badgeEl) => {
      let cur = badgeEl;
      let best = null;
      let bestScore = -1;

      // 위로 최대 10단계 올라가며 “카드 컨테이너” 후보 점수 매김
      for (let i = 0; i < 10 && cur; i++) {
        const s = scoreCard(cur);
        if (s > bestScore) {
          bestScore = s;
          best = cur;
        }
        cur = cur.parentElement;
      }

      return best;
    };

    const candidates = adBadges
      .map((badge) => findBestCardFrom(badge))
      .filter(Boolean);

    if (candidates.length === 0) return null;

    // 점수 가장 높은 카드 선택
    let best = candidates[0];
    let bestScore = scoreCard(best);
    for (const c of candidates.slice(1)) {
      const s = scoreCard(c);
      if (s > bestScore) {
        best = c;
        bestScore = s;
      }
    }

    const root = best;

    // ---- 광고주명(상단 왼쪽 “독한관리 에듀윌 편입” 같은 라인) 추정
    // 카드 안에서 “광고” 배지와 같은 행에 있는 텍스트가 보통 광고주명.
    // 가장 위쪽에 위치한 굵은 텍스트/링크 텍스트를 우선.
    const allAnchors = Array.from(root.querySelectorAll("a"))
      .map((a) => ({
        text: clean(a.textContent),
        href: a.href || null,
        rect: a.getBoundingClientRect(),
      }))
      .filter((x) => x.text && x.text !== "광고");

    // 상단에 가까운(작은 y) anchor 우선
    allAnchors.sort((a, b) => a.rect.top - b.rect.top);

    const advertiser =
      allAnchors.find((x) => x.text.length >= 2 && x.text.length <= 30)?.text ||
      null;

    // ---- 메인문구(카드 상단의 “새소식 …” 라인 또는 큰 제목) 추정
    // root 내부에서 줄 단위 텍스트를 뽑아 "광고주명"과 중복/너무 짧은 것 제외하고 앞쪽 유의미한 문장 선택
    const lines = clean(root.innerText)
      .split("\n")
      .map((l) => clean(l))
      .filter(Boolean);

    // 필터링: “광고”, 광고주명과 동일, 너무 짧은 라인 제거
    const filtered = lines.filter((l) => {
      if (!l) return false;
      if (l === "광고") return false;
      if (advertiser && l === advertiser) return false;
      if (l.length < 2) return false;
      return true;
    });

    // 메인문구: 보통 “새소식 …” 또는 첫 유의미한 문장
    const headline =
      filtered.find((l) => l.includes("새소식")) ||
      filtered.find((l) => /설명회|개강|환급|이벤트|상담|특강/.test(l)) ||
      filtered[0] ||
      null;

    // ---- 일정(“1/22(목) …” 같은 날짜/요일 패턴)
    const schedule =
      filtered.find((l) => /\d{1,2}\/\d{1,2}\s*\(.{1,2}\)/.test(l)) ||
      filtered.find((l) => /\d{1,2}\/\d{1,2}/.test(l)) ||
      null;

    // ---- 태그(칩): 짧은 텍스트(1~8자) 다수 중 “광고/더보기/예약하기” 같은 버튼성 제외
    const chipTexts = Array.from(root.querySelectorAll("a,button,span,em,strong"))
      .map((el) => clean(el.textContent))
      .filter((t) => t && t.length >= 1 && t.length <= 8);

    const deny = new Set([
      "광고",
      "더보기",
      "바로가기",
      "예약하기",
      "신청하기",
      "자세히",
      "안내",
      "NAVER",
      "검색",
      "메뉴",
      "본문",
    ]);

    const tags = Array.from(new Set(chipTexts)).filter((t) => !deny.has(t));

    // ---- 이벤트 뱃지(하단 컬러 박스/배지류): 보통 6~20자 정도의 강한 문구
    // 너무 긴 본문은 제외하고, 특수 패턴(%, 개강, 환급, 이벤트 등) 위주로 수집
    const badgeCandidates = Array.from(root.querySelectorAll("a,button,span,em,strong"))
      .map((el) => clean(el.textContent))
      .filter((t) => t && t.length >= 3 && t.length <= 20);

    const badgeKeywords = /(개강|환급|이벤트|설명회|무료|할인|%|특강|올패스|상담|체험)/;

    const badges = Array.from(new Set(badgeCandidates)).filter((t) => badgeKeywords.test(t));

    // ---- 대표 이미지(좌측 큰 이미지)
    const img =
      root.querySelector("img")?.getAttribute("src") ||
      root.querySelector("img")?.getAttribute("data-src") ||
      null;

    // ---- 클릭 링크(가능하면 “adcr / ad.search” 계열 우선)
    const adLink =
      allAnchors.find((x) => /adcr\.naver\.com|ad\.search\.naver\.com|ad\.naver\.com/.test(x.href || ""))
        ?.href ||
      allAnchors[0]?.href ||
      null;

    return {
      advertiser,
      headline,
      schedule,
      tags,
      badges,
      img,
      link: adLink,
    };
  });

  if (!ad) return null;

  // evaluate 결과 후처리(빈 값 제거/중복 제거)
  return {
    advertiser: cleanText(ad.advertiser) || null,
    headline: cleanText(ad.headline) || null,
    schedule: cleanText(ad.schedule) || null,
    tags: uniq(ad.tags),
    badges: uniq(ad.badges),
    img: cleanText(ad.img) || null,
    link: cleanText(ad.link) || null,
  };
}

// ==============================
// 라우트
// ==============================

/** 루트: 배포 확인용 */
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "crawler-service",
    endpoints: ["/health", "/crawl", "/crawl-multi"],
  });
});

/** 헬스체크 */
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

/**
 * 단일 크롤링
 * GET /crawl?keyword=에듀윌 편입 강남
 */
app.get("/crawl", async (req, res) => {
  const keyword = cleanText(req.query.keyword);
  if (!keyword) return res.status(400).json({ success: false, error: "keyword is required" });

  let browser;
  const startedAt = Date.now();

  try {
    browser = await chromium.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
      viewport: { width: 1365, height: 900 },
    });

    const url = `https://search.naver.com/search.naver?query=${encodeURIComponent(keyword)}`;

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    // 카드 광고가 JS로 늦게 뜨는 경우가 있어 조금 더 기다림
    await page.waitForTimeout(1200);

    const ad = await extractTopAdCard(page);

    res.json({
      success: true,
      keyword,
      url,
      ad, // 없으면 null
      crawledAt: new Date().toISOString(),
      ms: Date.now() - startedAt,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      keyword,
      error: err?.message || String(err),
      crawledAt: new Date().toISOString(),
      ms: Date.now() - startedAt,
    });
  } finally {
    if (browser) await browser.close();
  }
});

/**
 * 멀티 크롤링(A안 핵심)
 * - 베이스(편입 강남) + academies(김영,에듀윌,해커스) => 각각 “{학원} {base}”로 검색해서 카드 광고 추출
 *
 * GET /crawl-multi?base=편입 강남
 * (옵션) /crawl-multi?base=편입 강남&academies=김영,에듀윌,해커스
 */
app.get("/crawl-multi", async (req, res) => {
  const base = cleanText(req.query.base || "편입 강남");

  const academiesRaw = cleanText(req.query.academies || "김영,에듀윌,해커스");
  const academies = academiesRaw
    .split(",")
    .map((x) => cleanText(x))
    .filter(Boolean);

  let browser;
  const startedAt = Date.now();

  try {
    browser = await chromium.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
      viewport: { width: 1365, height: 900 },
    });

    const results = {};

    for (const academy of academies) {
      const keyword = cleanText(`${academy} ${base}`);
      const page = await context.newPage();

      const url = `https://search.naver.com/search.naver?query=${encodeURIComponent(keyword)}`;
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
        await page.waitForTimeout(1200);
        const ad = await extractTopAdCard(page);

        results[academy] = {
          academy,
          keyword,
          url,
          ad, // 카드 광고 없으면 null
        };
      } catch (e) {
        results[academy] = {
          academy,
          keyword,
          url,
          ad: null,
          error: e?.message || String(e),
        };
      } finally {
        await page.close();
      }
    }

    res.json({
      success: true,
      base,
      academies,
      results,
      crawledAt: new Date().toISOString(),
      ms: Date.now() - startedAt,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      base,
      error: err?.message || String(err),
      crawledAt: new Date().toISOString(),
      ms: Date.now() - startedAt,
    });
  } finally {
    if (browser) await browser.close();
  }
});

app.listen(PORT, () => {
  console.log(`crawler-service listening on ${PORT}`);
});
