import { SyncNoticeManager } from '../src/sync/SyncNoticeManager'
import { Notice } from 'obsidian'

describe('SyncNoticeManager', () => {
  describe('progress bar calculation', () => {
    it('starts with 5 blocks, first block filled', () => {
      const manager = new SyncNoticeManager()
      manager.startSync()
      // Access internal state for testing
      expect(manager['totalBlocks']).toBe(5)
      expect(manager['filledBlocks']).toBe(1)
    })

    it('keeps minimum 5 blocks for small article counts', () => {
      const manager = new SyncNoticeManager()
      manager.startSync()
      manager.onBatchProcessed(3, false)
      // ceil(3/5) = 1, max(1, 5) = 5
      expect(manager['totalBlocks']).toBe(5)
    })

    it('expands blocks when articles exceed 25', () => {
      const manager = new SyncNoticeManager()
      manager.startSync()
      manager.onBatchProcessed(15, true)
      // ceil(15/5) = 3, max(3, 5) = 5
      expect(manager['totalBlocks']).toBe(5)

      manager.onBatchProcessed(15, true)
      // ceil(30/5) = 6, max(6, 5) = 6
      expect(manager['totalBlocks']).toBe(6)
    })

    it('caps at 10 blocks', () => {
      const manager = new SyncNoticeManager()
      manager.startSync()
      manager.onBatchProcessed(15, true)
      manager.onBatchProcessed(15, true)
      manager.onBatchProcessed(15, true)
      manager.onBatchProcessed(15, false)
      // ceil(60/5) = 12, min(12, 10) = 10
      expect(manager['totalBlocks']).toBe(10)
    })

    it('reserves 1 block when hasNextPage is true', () => {
      const manager = new SyncNoticeManager()
      manager.startSync()
      manager.onBatchProcessed(15, true)
      // totalBlocks=5, should fill at most 4 (reserve 1)
      expect(manager['filledBlocks']).toBeLessThanOrEqual(4)
    })

    it('fills all blocks when hasNextPage is false', () => {
      const manager = new SyncNoticeManager()
      manager.startSync()
      manager.onBatchProcessed(10, false)
      expect(manager['filledBlocks']).toBe(manager['totalBlocks'])
    })
  })

  describe('renderProgressBar', () => {
    it('renders correct block pattern', () => {
      const manager = new SyncNoticeManager()
      manager.startSync()
      const bar = manager['renderProgressBar']('拉取数据...')
      // 1 filled, 4 empty
      expect(bar).toBe('■ □ □ □ □  拉取数据...')
    })

    it('renders mid-progress correctly', () => {
      const manager = new SyncNoticeManager()
      manager['totalBlocks'] = 5
      manager['filledBlocks'] = 3
      const bar = manager['renderProgressBar']('处理文章 15...')
      expect(bar).toBe('■ ■ ■ □ □  处理文章 15...')
    })

    it('renders all filled', () => {
      const manager = new SyncNoticeManager()
      manager['totalBlocks'] = 5
      manager['filledBlocks'] = 5
      const bar = manager['renderProgressBar']('同步完成！')
      expect(bar).toBe('■ ■ ■ ■ ■  同步完成！')
    })
  })

  describe('showError', () => {
    it('shows API key message for 401 status', () => {
      const manager = new SyncNoticeManager()
      manager.startSync()
      const error = { status: 401, message: 'Unauthorized' }
      manager.showError(error)
      // mainNotice should be cleaned up
      expect(manager['mainNotice']).toBeNull()
    })

    it('shows network error for errors without status', () => {
      const manager = new SyncNoticeManager()
      const error = new Error('fetch failed')
      // Should not throw
      expect(() => manager.showError(error)).not.toThrow()
    })

    it('shows generic message for other status codes', () => {
      const manager = new SyncNoticeManager()
      const error = { status: 500, message: 'Server error' }
      expect(() => manager.showError(error)).not.toThrow()
    })
  })

  describe('edge cases', () => {
    it('handles 0 articles — showNoArticles', () => {
      const manager = new SyncNoticeManager()
      manager.startSync()
      manager.showNoArticles()
      expect(manager['mainNotice']).toBeNull()
    })

    it('handles 1 article, last page', () => {
      const manager = new SyncNoticeManager()
      manager.startSync()
      manager.onBatchProcessed(1, false)
      // Should fill all 5 blocks
      expect(manager['totalBlocks']).toBe(5)
      expect(manager['filledBlocks']).toBe(5)
    })

    it('handles exactly 25 articles (boundary for 5 blocks)', () => {
      const manager = new SyncNoticeManager()
      manager.startSync()
      manager.onBatchProcessed(15, true)
      manager.onBatchProcessed(10, false)
      // ceil(25/5) = 5, max(5, 5) = 5
      expect(manager['totalBlocks']).toBe(5)
      expect(manager['filledBlocks']).toBe(5)
    })

    it('handles exactly 50 articles (boundary for 10 blocks)', () => {
      const manager = new SyncNoticeManager()
      manager.startSync()
      manager.onBatchProcessed(15, true)
      manager.onBatchProcessed(15, true)
      manager.onBatchProcessed(15, true)
      manager.onBatchProcessed(5, false)
      // ceil(50/5) = 10
      expect(manager['totalBlocks']).toBe(10)
      expect(manager['filledBlocks']).toBe(10)
    })
  })

  describe('phase notices', () => {
    it('completePhase hides and nulls phaseNotice', () => {
      const manager = new SyncNoticeManager()
      manager.showPhaseNotice('处理图片中...')
      expect(manager['phaseNotice']).not.toBeNull()
      manager.completePhase()
      expect(manager['phaseNotice']).toBeNull()
    })

    it('failPhase replaces message and nulls phaseNotice', () => {
      const manager = new SyncNoticeManager()
      manager.showPhaseNotice('处理图片中...')
      manager.failPhase('图片处理失败，文章内容不受影响')
      expect(manager['phaseNotice']).toBeNull()
    })
  })
})
