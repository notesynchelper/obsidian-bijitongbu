import { Item } from '@omnivore-app/api'
import { BurnDeleteTracker } from '../src/sync/BurnDeleteTracker'

const ID = '550e8400-e29b-41d4-a716-446655440010'

function makeItem(content = 'body'): Item {
	return {
		id: ID,
		title: 'Article',
		savedAt: '2026-06-04T10:00:00.000Z',
		updatedAt: '2026-06-04T10:00:00.000Z',
		content,
		url: 'https://example.com',
		slug: 's',
		labels: [],
		highlights: [],
	} as unknown as Item
}

type MockFile = { path: string; basename: string }

function makeCtx(
	{ existingByExactId, existingContent = '' }: { existingByExactId?: MockFile; existingContent?: string } = {},
) {
	const burnTracker = new BurnDeleteTracker()
	const created: string[] = []
	const modified: Array<[string, string]> = []
	return {
		burnTracker,
		imageLocalizer: null,
		attachmentLocalizer: null,
		settings: { burnAfterReading: true },
		successTracker: { recordSuccess: () => {} },
		diaryLinkProcessor: { addLink: () => {} },
		findFileByExactId: () => existingByExactId,
		findFileById: () => existingByExactId,
		findStandaloneFileById: () => existingByExactId,
		isMergeFilePath: () => false,   // 本 spec 里的目标都是普通单篇文件
		enqueueFileForImageLocalization: async () => {},
		enqueueFileForAttachmentLocalization: async () => {},
		addProcessedFile: () => {},
		app: {
			vault: {
				getAbstractFileByPath: () => null, // 主路径走 createNewFile
				read: async () => existingContent,
				create: async (p: string): Promise<MockFile> => { created.push(p); return { path: p, basename: 'Article' } },
				modify: async (f: MockFile, c: string) => { modified.push([f.path, c]) },
			},
		},
		_created: created,
		_modified: modified,
	}
}

describe('FileProcessor burn 模式：删除候选只认真实写入（codex P2 / design §5.2）', () => {
	it('新建文件（真实写入）→ 进删除集', async () => {
		const ctx = makeCtx({ existingByExactId: undefined });
		const { FileProcessor } = await import('../src/sync/FileProcessor');
		const p = new FileProcessor(ctx as never);
		await p.process(makeItem(), 'Synced/Article.md', 'body', 'Synced', 'Article');
		expect(ctx.burnTracker.hasDelete(ID)).toBe(true);
		expect(ctx.burnTracker.hasCursor(ID)).toBe(true);
	});

	it('exact-id 命中已存在文件、内容不变（no-op）→ 只进游标集，不进删除集（不误删云端）', async () => {
		const file = { path: 'Synced/Article.md', basename: 'Article' };
		// vault.read 返回与新内容相同 → updateFileIfNeeded 不 modify
		const ctx = makeCtx({ existingByExactId: file, existingContent: 'body' });
		const { FileProcessor } = await import('../src/sync/FileProcessor');
		const p = new FileProcessor(ctx as never);
		await p.process(makeItem('body'), 'Synced/Article.md', 'body', 'Synced', 'Article');
		expect(ctx.burnTracker.hasCursor(ID)).toBe(true);  // 游标推进
		expect(ctx.burnTracker.hasDelete(ID)).toBe(false); // 不删云端
		expect(ctx._modified.length).toBe(0);
	});

	it('exact-id 命中但内容有变（真实 modify）→ 进删除集', async () => {
		const file = { path: 'Synced/Article.md', basename: 'Article' };
		const ctx = makeCtx({ existingByExactId: file, existingContent: 'OLD body' });
		const { FileProcessor } = await import('../src/sync/FileProcessor');
		const p = new FileProcessor(ctx as never);
		await p.process(makeItem('NEW body'), 'Synced/Article.md', 'NEW body', 'Synced', 'Article');
		expect(ctx.burnTracker.hasDelete(ID)).toBe(true);
		expect(ctx._modified.length).toBe(1);
	});
})
