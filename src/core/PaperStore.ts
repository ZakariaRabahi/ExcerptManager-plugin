import {TFile, Vault, MetadataCache} from 'obsidian';
import {Paper} from './types';
import ExcerptManagerPlugin from '../main';

export class PaperStore {
	private vault: Vault;
	private metadataCache: MetadataCache;
	private plugin: ExcerptManagerPlugin;

	constructor(plugin: ExcerptManagerPlugin) {
		this.plugin = plugin;
		this.vault = plugin.app.vault;
		this.metadataCache = plugin.app.metadataCache;
	}

	async ensureFolder(): Promise<void> {
		const {paperFolder} = this.plugin.settings;
		if (!this.vault.getAbstractFileByPath(paperFolder)) {
			await this.vault.createFolder(paperFolder);
		}
	}

	async findOrCreatePaper(pdfPath: string): Promise<Paper> {
		// Check if a paper note already exists for this PDF path
		const existing = this.listPapers().find(p => p.pdfPath === pdfPath);
		if (existing) return existing;

		await this.ensureFolder();

		const title = this.titleFromPath(pdfPath);
		const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
		const filename = `${slug}.md`;
		const filePath = `${this.plugin.settings.paperFolder}/${filename}`;
		const id = slug;

		const content = this.buildNote({id, title, authors: [], pdfPath});
		await this.vault.create(filePath, content);

		return {id, title, authors: [], pdfPath};
	}

	readPaper(file: TFile): Paper | null {
		const cache = this.metadataCache.getFileCache(file);
		const fm = cache?.frontmatter;
		if (!fm || fm['type'] !== 'paper') return null;

		return {
			id: file.basename,
			title: String(fm['title'] ?? ''),
			authors: Array.isArray(fm['authors']) ? (fm['authors'] as unknown[]).map(String) : [],
			...(fm['year']            !== undefined && fm['year'] !== null ? {year:          Number(fm['year'])}             : {}),
			...(fm['rsl_resource_id'] !== undefined                        ? {rslResourceId: Number(fm['rsl_resource_id'])} : {}),
			pdfPath: String(fm['pdf_path'] ?? ''),
		};
	}

	listPapers(): Paper[] {
		const {paperFolder} = this.plugin.settings;
		return this.vault.getMarkdownFiles()
			.filter(f => f.path.startsWith(paperFolder + '/'))
			.map(f => this.readPaper(f))
			.filter((p): p is Paper => p !== null);
	}

	async updateRslResourceId(paperId: string, rslResourceId: number): Promise<void> {
		const {paperFolder} = this.plugin.settings;
		const file = this.vault.getAbstractFileByPath(`${paperFolder}/${paperId}.md`);
		if (!(file instanceof TFile)) throw new Error(`Paper not found: ${paperId}`);
		const paper = this.readPaper(file);
		if (!paper) throw new Error(`Could not read paper: ${paperId}`);
		const raw  = await this.vault.read(file);
		// Inject or replace rsl_resource_id in the frontmatter block
		const updated = raw.includes('rsl_resource_id:')
			? raw.replace(/rsl_resource_id:.*/, `rsl_resource_id: ${rslResourceId}`)
			: raw.replace(/^---\n/, `---\nrsl_resource_id: ${rslResourceId}\n`);
		await this.vault.modify(file, updated);
	}

	// --- private helpers ---

	private titleFromPath(pdfPath: string): string {
		const filename = pdfPath.split('/').pop() ?? pdfPath;
		return filename
			.replace(/\.pdf$/i, '')
			.replace(/[-_]+/g, ' ')
			.trim();
	}

	private buildNote(paper: Pick<Paper, 'id' | 'title' | 'authors' | 'pdfPath' | 'rslResourceId'> & {year?: number}): string {
		const authorsYaml = paper.authors.length > 0
			? paper.authors.map(a => `  - "${a}"`).join('\n')
			: '  []';

		const lines = [
			'---',
			'type: paper',
			`title: "${paper.title}"`,
			`authors:\n${authorsYaml}`,
			`year:${paper.year !== undefined ? ` ${paper.year}` : ''}`,
			`pdf_path: "${paper.pdfPath}"`,
		];
		if (paper.rslResourceId !== undefined) lines.push(`rsl_resource_id: ${paper.rslResourceId}`);
		lines.push('---');

		const frontmatter = lines.join('\n');

		const body = [
			`# ${paper.title}`,
			'',
			`**PDF**: [[${paper.pdfPath}]]`,
		].join('\n');

		return `${frontmatter}\n\n${body}`;
	}
}
