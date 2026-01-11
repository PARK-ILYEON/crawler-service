async function extractBrandAd(page) {
  return await page.evaluate(() => {
    const root = document.querySelector(".brand_block");
    if (!root) return null;

    // 광고 링크 (중계 링크)
    const linkEl = root.querySelector("a[href*='ad.search.naver.com'], a[href*='adcr.naver.com']");
    const link = linkEl?.href ?? null;

    // 광고주명
    const advertiser =
      root.querySelector(".title_area strong, .brand_name, .logo_area span")?.innerText?.trim()
      ?? null;

    // 메인 문구 (큰 파란 제목)
    const headline =
      root.querySelector("a strong, a h3, .title_area a")?.innerText?.trim()
      ?? null;

    // 서브 설명 문구
    const description =
      root.querySelector(".desc, .sub_text, .detail_text")?.innerText?.trim()
      ?? null;

    // 일정 (날짜/시간)
    const schedule =
      root.innerText.match(/\d{1,2}\/\d{1,2}|\d{1,2}월\s?\d{1,2}일/)?.[0]
      ?? null;

    // 태그 pill (강남, 설명회 등)
    const tags = Array.from(
      root.querySelectorAll(".tag_area span, .keyword span")
    )
      .map(el => el.innerText.trim())
      .filter(Boolean);

    // 이벤트/혜택 버튼
    const badges = Array.from(
      root.querySelectorAll("button, .badge, .benefit")
    )
      .map(el => el.innerText.trim())
      .filter(t => t.length <= 20);

    return {
      advertiser,
      headline,
      description,
      schedule,
      tags,
      badges,
      link
    };
  });
}
