import { DEFAULT_SETTINGS } from '../src/settings'

describe('阅后即焚 settings 默认值 + 合并策略', () => {
	it('默认关闭，enabledAt 空，pending 空', () => {
		expect(DEFAULT_SETTINGS.burnAfterReading).toBe(false)
		expect(DEFAULT_SETTINGS.burnAfterReadingEnabledAt).toBe('')
		expect(DEFAULT_SETTINGS.pendingBurnDeletes).toEqual([])
	})

	it('Object.assign 合并策略：已有用户值不被默认覆盖；缺失字段补默认', () => {
		const saved = { burnAfterReading: true, burnAfterReadingEnabledAt: '2026-06-04T00:00:00Z' }
		const merged = Object.assign({}, DEFAULT_SETTINGS, saved)
		expect(merged.burnAfterReading).toBe(true) // 不被默认 false 覆盖
		expect(merged.burnAfterReadingEnabledAt).toBe('2026-06-04T00:00:00Z')
		expect(merged.pendingBurnDeletes).toEqual([]) // 缺失补默认
	})
})
