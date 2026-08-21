/**
 * 图床 relay 公共模块单测
 *
 * 覆盖：
 * - isAlwaysLocalizeDomain（含 relay-N pattern 前瞻）
 * - getFallbackUrls 双向路由（relay→源站；源站→relay 优先）
 * - 多 relay 节点顺序兜底（relay-1..4 默认 + relayHosts 参数模拟更多节点）
 */

import {
  RELAY_HOSTS,
  isAlwaysLocalizeDomain,
  isAlwaysLocalizeHost,
  isOriginHost,
  getFallbackUrls,
} from '../../src/common/imageRelay'

// ============================================================
// isAlwaysLocalizeDomain
// ============================================================
describe('isAlwaysLocalizeDomain', () => {
  test('hostname 白名单 → true', () => {
    expect(isAlwaysLocalizeDomain('https://sync.bijitongbu.site/abc')).toBe(true)
    expect(isAlwaysLocalizeDomain('http://sync.bijitongbu.site/wecom31/x')).toBe(true)
    expect(isAlwaysLocalizeDomain('https://media30d.clipfx.app/k')).toBe(true)
  })

  test('pic / media 源站不在白名单（避免非图误判）', () => {
    // pic 图片通常带后缀，由 IMAGE_PATTERN 自然识别；
    // media 是通用媒体，强制走图片管道会把 mp4 保存成 png
    expect(isAlwaysLocalizeDomain('https://pic.clipfx.app/k.png')).toBe(false)
    expect(isAlwaysLocalizeDomain('https://media.clipfx.app/k')).toBe(false)
  })

  test('relay-1：/p/ 和 /m30/ 前缀强制本地化；/m/ 不强制', () => {
    expect(isAlwaysLocalizeDomain('https://relay-1.bijitongbu.site/p/k')).toBe(true)
    expect(isAlwaysLocalizeDomain('https://relay-1.bijitongbu.site/m30/k')).toBe(true)
    // /m/ 是通用媒体（视频/音频/文件），不进强制列表
    expect(isAlwaysLocalizeDomain('https://relay-1.bijitongbu.site/m/k')).toBe(false)
  })

  test('未收录的 relay-N（前瞻 pattern）：路径决定', () => {
    // 未来上线的节点 pattern 也能识别；/p/ 和 /m30/ 触发强制，/m/ 不触发
    expect(isAlwaysLocalizeDomain('https://relay-2.bijitongbu.site/p/k')).toBe(true)
    expect(isAlwaysLocalizeDomain('https://relay-2.bijitongbu.site/m30/k')).toBe(true)
    expect(isAlwaysLocalizeDomain('https://relay-42.bijitongbu.site/m30/k')).toBe(true)
    expect(isAlwaysLocalizeDomain('https://relay-999.bijitongbu.site/p/k')).toBe(true)

    expect(isAlwaysLocalizeDomain('https://relay-2.bijitongbu.site/m/k')).toBe(false)
    expect(isAlwaysLocalizeDomain('https://relay-42.bijitongbu.site/m/k')).toBe(false)
  })

  test('relay 根路径 / 空 prefix → false', () => {
    expect(isAlwaysLocalizeDomain('https://relay-1.bijitongbu.site/')).toBe(false)
    expect(isAlwaysLocalizeDomain('https://relay-1.bijitongbu.site/m30')).toBe(false)
  })

  test('其他域名 → false', () => {
    expect(isAlwaysLocalizeDomain('https://example.com/img.jpg')).toBe(false)
    expect(isAlwaysLocalizeDomain('https://cdn.example.com/path')).toBe(false)
    // 相似但不是 relay-N pattern 的域名
    expect(isAlwaysLocalizeDomain('https://relay.bijitongbu.site/p/k')).toBe(false)
    expect(isAlwaysLocalizeDomain('https://relay-a.bijitongbu.site/p/k')).toBe(false)
    expect(isAlwaysLocalizeDomain('https://relay-1.example.com/p/k')).toBe(false)
  })

  test('无效 URL → false', () => {
    expect(isAlwaysLocalizeDomain('not-a-url')).toBe(false)
    expect(isAlwaysLocalizeDomain('')).toBe(false)
  })

  test('isAlwaysLocalizeHost：纯 hostname 白名单（不含 relay 路径判断）', () => {
    expect(isAlwaysLocalizeHost('sync.bijitongbu.site')).toBe(true)
    expect(isAlwaysLocalizeHost('media30d.clipfx.app')).toBe(true)
    // hostname 级接口不对 relay 做判断，统一返回 false（relay 必须结合 path）
    expect(isAlwaysLocalizeHost('relay-1.bijitongbu.site')).toBe(false)
    expect(isAlwaysLocalizeHost('pic.clipfx.app')).toBe(false)
    expect(isAlwaysLocalizeHost('media.clipfx.app')).toBe(false)
    expect(isAlwaysLocalizeHost('example.com')).toBe(false)
  })
})

// ============================================================
// isOriginHost（权威源站判定：NoSuchKey 直接信）
// ============================================================
describe('isOriginHost', () => {
  test('三类 clipfx 源站 → true', () => {
    expect(isOriginHost('pic.clipfx.app')).toBe(true)
    expect(isOriginHost('media.clipfx.app')).toBe(true)
    expect(isOriginHost('media30d.clipfx.app')).toBe(true)
  })

  test('已下线的旧镜像 → false（不再视为权威源站）', () => {
    expect(isOriginHost('clipfxpic.bijitongbu.site')).toBe(false)
    expect(isOriginHost('clipfxpic2.bijitongbu.site')).toBe(false)
  })

  test('sync 直链 → true', () => {
    expect(isOriginHost('sync.bijitongbu.site')).toBe(true)
  })

  test('relay-N → false（反向代理不是权威）', () => {
    expect(isOriginHost('relay-1.bijitongbu.site')).toBe(false)
    expect(isOriginHost('relay-42.bijitongbu.site')).toBe(false)
  })

  test('未知域名 → false', () => {
    expect(isOriginHost('example.com')).toBe(false)
    expect(isOriginHost('cdn.example.com')).toBe(false)
  })
})

// ============================================================
// getFallbackUrls：方向 1（relay → 源站）
// ============================================================
describe('getFallbackUrls: relay → 源站', () => {
  test('relay-1/p/<k> → relay-2/3/4 → 源站 pic（无镜像）', () => {
    expect(
      getFallbackUrls('https://relay-1.bijitongbu.site/p/abc123.png'),
    ).toEqual([
      'https://relay-2.bijitongbu.site/p/abc123.png',
      'https://relay-3.bijitongbu.site/p/abc123.png',
      'https://relay-4.bijitongbu.site/p/abc123.png',
      'https://pic.clipfx.app/abc123.png',
    ])
  })

  test('relay-1/m30/<k> → relay-2/3/4/m30 → 源站 media30d.clipfx.app', () => {
    expect(
      getFallbackUrls('https://relay-1.bijitongbu.site/m30/deadbeef'),
    ).toEqual([
      'https://relay-2.bijitongbu.site/m30/deadbeef',
      'https://relay-3.bijitongbu.site/m30/deadbeef',
      'https://relay-4.bijitongbu.site/m30/deadbeef',
      'https://media30d.clipfx.app/deadbeef',
    ])
  })

  test('relay-1/m/<k> → relay-2/3/4/m → 源站 media.clipfx.app', () => {
    expect(
      getFallbackUrls('https://relay-1.bijitongbu.site/m/xyz'),
    ).toEqual([
      'https://relay-2.bijitongbu.site/m/xyz',
      'https://relay-3.bijitongbu.site/m/xyz',
      'https://relay-4.bijitongbu.site/m/xyz',
      'https://media.clipfx.app/xyz',
    ])
  })

  test('relay URL 多级 path + query + hash 透传', () => {
    expect(
      getFallbackUrls(
        'https://relay-1.bijitongbu.site/p/a/b/c.jpg?x=1&y=2#frag',
      ),
    ).toEqual([
      'https://relay-2.bijitongbu.site/p/a/b/c.jpg?x=1&y=2#frag',
      'https://relay-3.bijitongbu.site/p/a/b/c.jpg?x=1&y=2#frag',
      'https://relay-4.bijitongbu.site/p/a/b/c.jpg?x=1&y=2#frag',
      'https://pic.clipfx.app/a/b/c.jpg?x=1&y=2#frag',
    ])
  })

  test('relay 路径缺 key（只到 /p/）→ []', () => {
    expect(getFallbackUrls('https://relay-1.bijitongbu.site/p/')).toEqual([])
    expect(getFallbackUrls('https://relay-1.bijitongbu.site/p')).toEqual([])
  })

  test('未知 path prefix（如 /xyz/）→ []', () => {
    expect(
      getFallbackUrls('https://relay-1.bijitongbu.site/xyz/k'),
    ).toEqual([])
  })
})

// ============================================================
// getFallbackUrls：方向 2（源站 → relay 优先）
// ============================================================
describe('getFallbackUrls: 源站 → relay 优先', () => {
  test('pic.clipfx.app/<k> → relay-1/2/3/4/p（无镜像）', () => {
    expect(
      getFallbackUrls('https://pic.clipfx.app/abc123.png'),
    ).toEqual([
      'https://relay-1.bijitongbu.site/p/abc123.png',
      'https://relay-2.bijitongbu.site/p/abc123.png',
      'https://relay-3.bijitongbu.site/p/abc123.png',
      'https://relay-4.bijitongbu.site/p/abc123.png',
    ])
  })

  test('media30d.clipfx.app/<k> → relay-1/2/3/4/m30（无镜像）', () => {
    expect(
      getFallbackUrls('https://media30d.clipfx.app/deadbeef'),
    ).toEqual([
      'https://relay-1.bijitongbu.site/m30/deadbeef',
      'https://relay-2.bijitongbu.site/m30/deadbeef',
      'https://relay-3.bijitongbu.site/m30/deadbeef',
      'https://relay-4.bijitongbu.site/m30/deadbeef',
    ])
  })

  test('media.clipfx.app/<k> → relay-1/2/3/4/m（无镜像）', () => {
    expect(
      getFallbackUrls('https://media.clipfx.app/xyz'),
    ).toEqual([
      'https://relay-1.bijitongbu.site/m/xyz',
      'https://relay-2.bijitongbu.site/m/xyz',
      'https://relay-3.bijitongbu.site/m/xyz',
      'https://relay-4.bijitongbu.site/m/xyz',
    ])
  })

  test('源站多级 path + query + hash 透传到 relay', () => {
    expect(
      getFallbackUrls('https://pic.clipfx.app/a/b/c.jpg?x=1#f'),
    ).toEqual([
      'https://relay-1.bijitongbu.site/p/a/b/c.jpg?x=1#f',
      'https://relay-2.bijitongbu.site/p/a/b/c.jpg?x=1#f',
      'https://relay-3.bijitongbu.site/p/a/b/c.jpg?x=1#f',
      'https://relay-4.bijitongbu.site/p/a/b/c.jpg?x=1#f',
    ])
  })

  test('源站根路径（无 key）→ []', () => {
    expect(getFallbackUrls('https://pic.clipfx.app/')).toEqual([])
  })
})

// ============================================================
// 未知 / 无效 URL
// ============================================================
describe('getFallbackUrls: 未知 / 无效', () => {
  test('非 relay 非源站 → []', () => {
    expect(getFallbackUrls('https://example.com/img.jpg')).toEqual([])
    expect(getFallbackUrls('https://cdn.example.com/x')).toEqual([])
  })

  test('sync.bijitongbu.site 不参与 fallback（直链）→ []', () => {
    expect(getFallbackUrls('https://sync.bijitongbu.site/wecom31/k')).toEqual(
      [],
    )
  })

  test('非法 URL → []（不抛异常）', () => {
    expect(getFallbackUrls('not-a-url')).toEqual([])
    expect(getFallbackUrls('')).toEqual([])
  })
})

// ============================================================
// 多 relay 节点顺序兜底（relay-2/-3 上线前瞻）
// ============================================================
describe('getFallbackUrls: 多 relay 节点（未来扩展）', () => {
  const MULTI = [
    'relay-1.bijitongbu.site',
    'relay-2.bijitongbu.site',
    'relay-3.bijitongbu.site',
  ] as const

  test('源站 → 按传入 relayHosts 顺序排列（pic 无镜像）', () => {
    expect(
      getFallbackUrls('https://pic.clipfx.app/k.png', MULTI),
    ).toEqual([
      'https://relay-1.bijitongbu.site/p/k.png',
      'https://relay-2.bijitongbu.site/p/k.png',
      'https://relay-3.bijitongbu.site/p/k.png',
    ])
  })

  test('relay-2 → 跳过自身，按顺序尝试其他 relay，再回源站', () => {
    expect(
      getFallbackUrls('https://relay-2.bijitongbu.site/p/k.png', MULTI),
    ).toEqual([
      'https://relay-1.bijitongbu.site/p/k.png',
      'https://relay-3.bijitongbu.site/p/k.png',
      'https://pic.clipfx.app/k.png',
    ])
  })

  test('media30d 源站在多 relay 下按顺序铺满', () => {
    expect(
      getFallbackUrls('https://media30d.clipfx.app/k', MULTI),
    ).toEqual([
      'https://relay-1.bijitongbu.site/m30/k',
      'https://relay-2.bijitongbu.site/m30/k',
      'https://relay-3.bijitongbu.site/m30/k',
    ])
  })
})

// ============================================================
// RELAY_HOSTS 导出的 sanity check（调用方依赖它时不会意外变成 undefined）
// ============================================================
describe('RELAY_HOSTS 导出', () => {
  test('包含 relay-1 ~ relay-4', () => {
    expect(RELAY_HOSTS).toContain('relay-1.bijitongbu.site')
    expect(RELAY_HOSTS).toContain('relay-2.bijitongbu.site')
    expect(RELAY_HOSTS).toContain('relay-3.bijitongbu.site')
    expect(RELAY_HOSTS).toContain('relay-4.bijitongbu.site')
  })

  test('所有条目都匹配 relay-N.bijitongbu.site 形式', () => {
    for (const host of RELAY_HOSTS) {
      expect(host).toMatch(/^relay-\d+\.bijitongbu\.site$/)
    }
  })
})
