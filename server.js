import express from "express";
import { chromium } from "playwright";

const app = express();
const PORT = process.env.PORT || 8080;

const DEFAULT_TIMEOUT = 60000;

// 네이버 UI 잡다한 텍스트 제거용
const STOP_PHRASES = new Set([
  "메뉴 영역으로 바로가기",
  "본문 영역으로 바로가기",
  "NAVER",
  "검색",
  "한글 입력기",
  "입력도구",
  "자동완성 레이어",
  "검색 레이어",
  "전체삭제",
  "도움말",
  "이 정보가 표시된 이유",
  "정보확인 레이어 닫기",
  "바로가기",
  "더보기",
  "광고",
]);

function uniq(arr) {
  return [...new Set(arr.filter(Boolean))];
}

function cleanText(s) {
  if (!s) return null;
  const t = String(s).replace(/\s+/g, " ").trim();
  if (!t) return null;
  if (STOP_PHRASES.has(t)) return null;
  return t;
}

function looksLikeDateOrSchedule(t) {
  if (!t) return false;
  // 1/22(목), 1/5 개강, 2026.01.11 등
  return (
    /(\d{1,2}\s*\/\s*\d{1,2}\s*\([^)]+\))/.test(t) ||
    /(\d{1,2}\s*\/\s*\d{1,2})/.test(t) ||
    /(\d{4}\.\d{1,2}\.\d{1,2})/.test(t) ||
    /(\d{1,2}월\s*\d{1,2}일)/.test(t) ||
    /(개강|설명회|상담|마감|오픈|시작)/.test(t)
  );
}

/**
 * "상단 큰 광고 카드" 전용 추출
 * - 페이지에서 '광고' 라벨이 포함된 컨테이너 후보를 찾고
 * - 상단(y가 가장 작은) + 큰 카드(area 큰) 우선
 * - 해당 카드 내부에서만 필드 추출
 */
async function extractTopAdCard(page) {
  return await page.evaluate(() => {
    const STOP = new Set([
      "메뉴 영역으로 바로가기",
      "본문 영역으로 바로가기",
      "NAVER",
      "검색",
      "한글 입력기",
      "입력도구",
      "자동완성 레이어",
      "검색 레이어",
      "전체삭제",
      "도움말",
      "이 정보가 표시된 이유",
      "정보확인 레이어 닫기",
      "바로가기",
      "더보기",
      "광고",
    ]);

    const clean = (s) => {
      if (!s) return null;
      const t = String(s).replace(/\s+/g, " ").trim();
      if (!t) return null;
      if (STOP.has(t)) return null;
      return t;
    };

    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 50 || r.height < 30) return false;
      const style = window.getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") return false;
      return true;
    };

    // 1) "광고" 라벨을 가진 요소들을 찾는다 (상단 카드 광고에 항상 존재)
    const adBadges = Array.from(document.querySelectorAll("*"))
      .filter((el) => {
        const t = clean(el.textContent);
        return t === "광고";
      })
      .slice(0, 200); // 방어적으로 제한

    // 2) 배지 주변에서 "카드 컨테이너" 후보를 만든다
    const candidates = [];
    for (const badge of adBadges) {
      // 너무 바깥(div body 등)으로 올라가지 않도록, 6단계까지만 상승
      let cur = badge;
      for (let i = 0; i < 6 && cur; i++) {
        cur = cur.parentElement;
        if (!cur) break;
        if (!isVisible(cur)) continue;

        const rect = cur.getBoundingClientRect();
        const area = rect.width * rect.height;

        // 큰 카드 광고는 대체로 이미지 포함
        const img = cur.querySelector("img");
        // 링크(광고 클릭 링크) 포함 가능성이 높음
        const link = cur.querySelector("a[href*='adcr.naver.com'], a[href*='ad.search.naver.com'], a[href*='ad.naver.com']");

        // "큰 카드" 느낌 최소 조건
        if (area > 40000 && img) {
          candidates.push({ el: cur, y: rect.y, area, hasLink: !!link });
        }
      }
    }

    if (candidates.length === 0) return null;

    // 3) 가장 상단(y가 작은) + 큰(area 큰) 후보를 고른다
    candidates.sort((a, b) => {
      if (Math.abs(a.y - b.y) > 20) return a.y - b.y; // 상단 우선
      if (a.hasLink !== b.hasLink) return a.hasLink ? -1 : 1; // 링크 있으면 우선
      return b.area - a.area; // 크면 우선
    });

    const card = candidates[0].el;
    const cardRect = card.getBoundingClientRect();

    // 4) 카드 내부 텍스트를 "위치 기반"으로 분리
    //    - 상단(브랜드/광고주명) / 중단(메인문구) / 하단(태그/뱃지)
    const texts = [];
    const nodes = card.querySelectorAll("a, span, strong, em, div, p, h1, h2, h3, h4, button");
    for (const n of nodes) {
      if (!isVisible(n)) continue;
      const t = clean(n.textContent);
      if (!t) continue;

      const r = n.getBoundingClientRect();
      // 카드 밖에 걸친 것 제거
      const inside =
        r.x >= cardRect.x - 2 &&
        r.y >= cardRect.y - 2 &&
        r.right <= cardRect.right + 2 &&
        r.bottom <= cardRect.bottom + 2;

      if (!inside) continue;

      texts.push({
        t,
        y: r.y,
        x: r.x,
        w: r.width,
        h: r.height,
        area: r.width * r.height,
      });
    }

    // 정렬(위에서 아래로)
    texts.sort((a, b) => (a.y - b.y) || (a.x - b.x));

    // 후보에서 중복/과다 제거 (동일 텍스트가 여러 요소에 반복되는 경우)
    const seen = new Set();
    const lines = [];
    for (const item of texts) {
      if (seen.has(item.t)) continue;
      seen.add(item.t);
      lines.push(item);
      if (lines.length > 120) break;
    }

    // 광고 링크(클릭 URL): 카드 안에서 광고 링크를 우선
    const adAnchor =
      card.querySelector("a[href*='adcr.naver.com']") ||
      card.querySelector("a[href*='ad.search.naver.com']") ||
      card.querySelector("a[href*='ad.naver.com']");

    // 이미지
    const imgEl = card.querySelector("img");
    const img = imgEl?.getAttribute("src") || imgEl?.getAttribute("data-src") || null;

    // 메인문구: 면적 큰 텍스트(너무 긴 설명문 제외), 보통 카드 가운데 파란 제목
    const headlineCand = lines
      .filter((x) => x.t.length >= 6 && x.t.length <= 60)
      .filter((x) => !x.t.includes("바로가기"))
      .filter((x) => !/http(s)?:\/\//.test(x.t))
      .sort((a, b) => b.area - a.area)[0]?.t || null;

    // 일정: 날짜/요일/개강/설명회 키워드 포함 텍스트 중 상단 제목 아래쪽
    const scheduleCand = lines
      .map((x) => x.t)
      .find((t) => {
        return (
          /(\d{1,2}\s*\/\s*\d{1,2}\s*\([^)]+\))/.test(t) ||
          /(\d{1,2}\s*\/\s*\d{1,2})/.test(t) ||
          /(\d{4}\.\d{1,2}\.\d{1,2})/.test(t) ||
          /(\d{1,2}월\s*\d{1,2}일)/.test(t) ||
          /(개강|설명회|상담|마감|오픈|시작)/.test(t)
        );
      }) || null;

    // 광고주명: 카드 상단에 위치한 짧은 텍스트(브랜드 라인)
    // - headline과 같거나 포함되면 제외
    const advertiserCand =
      lines
        .filter((x) => x.t.length >= 2 && x.t.length <= 25)
        .filter((x) => x.y < cardRect.y + cardRect.height * 0.35) // 상단 35%
        .filter((x) => !headlineCand || (x.t !== headlineCand && !headlineCand.includes(x.t)))
        .sort((a, b) => (a.y - b.y) || (a.x - b.x))[0]?.t || null;

    // 태그: 짧고(1~10자) 반복되는 지역/카테고리 느낌의 토큰
    // - headline/advertiser/schedule 제외
    const exclude = new Set([headlineCand, advertiserCand, scheduleCand].filter(Boolean));
    const tagCands = lines
      .map((x) => x.t)
      .filter((t) => t && t.length >= 1 && t.length <= 10)
      .filter((t) => !exclude.has(t))
      .filter((t) => !/^\d+$/.test(t))
      .filter((t) => !/(원|%|할인|환급)/.test(t)) // 뱃지쪽 숫자 제거
      .filter((t) => !STOP.has(t));

    // 이벤트 뱃지: 비교적 짧은 홍보 문구(4~30자), 할인/환급/올패스/이벤트/개강 등 포함
    const badgeCands = lines
      .filter((x) => x.y > cardRect.y + cardRect.height * 0.45) // 하단 위주
      .map((x) => x.t)
      .filter((t) => t && t.length >= 4 && t.length <= 30)
      .filter((t) => !exclude.has(t))
      .filter((t) => /(이벤트|특가|할인|환급|올패스|설명회|상담|개강|무료|지원|합격|인강|장학|쿠폰|혜택)/.test(t));

    return {
      advertiser: advertiserCand || null,
      headline: headlineCand || null,
      schedule: scheduleCand || null,
      tags: Array.from(new Set(tagCands)).slice(0, 12),
      badges: Array.from(new Set(badgeCands)).slice(0, 8),
      link: adAnchor?.href || null,
      img,
    };
  });
}

/** 헬스체크 */
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

/**
 * 단일 키워드 크롤
 * GET /crawl?keyword=에듀윌 편입 강남
 */
app.get("/crawl", async (req, res) => {
  const keyword = req.query.keyword;
  if (!keyword) return res.status(400).json({ error: "keyword is required" });

  const query = String(keyword).trim();
  const url = `https://search.naver.com/search.naver?query=${encodeURIComponent(query)}`;

  let browser;
  try {
    browser = await chromium.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT });
    await page.waitForTimeout(1200); // 렌더 안정화(너무 길게 X)

    const ad = await extractTopAdCard(page);

    res.json({
      success: true,
      keyword: query,
      url,
      ad,
      crawledAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      keyword: String(keyword),
      error: err?.message || String(err),
    });
  } finally {
    if (browser) await browser.close();
  }
});

/**
 * 멀티 크롤 (학원 3개)
 * GET /crawl-multi?base=편입 강남
 * - 내부에서 [김영, 에듀윌, 해커스] + base를 붙여 각각 상단 카드 광고를 가져옴
 *
 * 옵션:
 * - academies=김영,에듀윌,해커스 처럼 콤마로 override 가능
 */
app.get("/crawl-multi", async (req, res) => {
  const base = req.query.base;
  if (!base) return res.status(400).json({ error: "base is required" });

  const baseQ = String(base).trim();
  const academiesParam = req.query.academies ? String(req.query.academies) : null;

  const academies = academiesParam
    ? academiesParam.split(",").map((s) => s.trim()).filter(Boolean)
    : ["김영", "에듀윌", "해커스"];

  let browser;
  try {
    browser = await chromium.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const results = {};
    for (const academy of academies) {
      const keyword = `${academy} ${baseQ}`.trim();
      const url = `https://search.naver.com/search.naver?query=${encodeURIComponent(keyword)}`;

      const page = await browser.newPage();
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT });
        await page.waitForTimeout(1200);

        const ad = await extractTopAdCard(page);

        results[academy] = {
          academy,
          keyword,
          url,
          ad,
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
        await page.close().catch(() => {});
      }
    }

    res.json({
      success: true,
      base: baseQ,
      results,
      crawledAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      base: String(base),
      error: err?.message || String(err),
    });
  } finally {
    if (browser) await browser.close();
  }
});

app.listen(PORT, () => {
  console.log(`crawler-service listening on ${PORT}`);
});
