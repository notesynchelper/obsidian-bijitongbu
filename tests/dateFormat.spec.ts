/**
 * Test: formatDate with Chinese locale
 *
 * Covers:
 * - Basic date formatting (yyyy-MM-dd)
 * - Chinese short weekday names via ccc token (e.g. 周一)
 * - Chinese full weekday names via cccc token (e.g. 星期一)
 * - Multiple weekdays for correctness
 * - Invalid date throws error
 */
import { formatDate } from '../src/util'

describe('formatDate', () => {
  it('formats basic date correctly', () => {
    expect(formatDate('2024-01-15T12:00:00.000Z', 'yyyy-MM-dd')).toBe('2024-01-15')
  })

  it('formats ccc token as Chinese short weekday (Monday = 周一)', () => {
    // 2024-01-15 is Monday in UTC; using noon UTC to avoid timezone ambiguity
    const result = formatDate('2024-01-15T12:00:00.000Z', 'yyyy-MM-dd-ccc')
    expect(result).toBe('2024-01-15-周一')
  })

  it('formats cccc token as Chinese full weekday (Monday = 星期一)', () => {
    const result = formatDate('2024-01-15T12:00:00.000Z', 'yyyy-MM-dd-cccc')
    expect(result).toBe('2024-01-15-星期一')
  })

  it('formats Sunday correctly (ccc = 周日)', () => {
    // 2024-01-14 is Sunday
    const result = formatDate('2024-01-14T12:00:00.000Z', 'ccc')
    expect(result).toBe('周日')
  })

  it('formats Wednesday correctly (ccc = 周三)', () => {
    // 2024-01-17 is Wednesday
    const result = formatDate('2024-01-17T12:00:00.000Z', 'ccc')
    expect(result).toBe('周三')
  })

  it('formats Saturday correctly (ccc = 周六)', () => {
    // 2024-01-20 is Saturday
    const result = formatDate('2024-01-20T12:00:00.000Z', 'ccc')
    expect(result).toBe('周六')
  })

  it('formats EEE token as Chinese short weekday', () => {
    const result = formatDate('2024-01-15T12:00:00.000Z', 'EEE')
    expect(result).toBe('周一')
  })

  it('formats EEEE token as Chinese full weekday', () => {
    const result = formatDate('2024-01-15T12:00:00.000Z', 'EEEE')
    expect(result).toBe('星期一')
  })

  it('throws error for invalid date', () => {
    expect(() => formatDate('not-a-date', 'yyyy-MM-dd')).toThrow('Invalid date: not-a-date')
  })
})
