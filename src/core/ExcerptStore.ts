import {TFile, Vault, MetadataCache} from 'obsidian';
import {Excerpt, Relation} from './types';
import ExcerptManagerPlugin from '../main';

export class ExcerptStore {
	private vault: Vault;
	private metadataCache: MetadataCache;
	private plugin: ExcerptManagerPlugin;

	constructor(plugin: ExcerptManagerPlugin) {
		this.plugin = plugin;
		this.vault = plugin.app.vault;
		this.metadataCache = plugin.app.metadataCache;
	}

	async ensureFolders(): Promise<void> {
		const {excerptFolder, paperFolder} = this.plugin.settings;
		for (const folder of [excerptFolder, paperFolder]) {
			if (!this.vault.getAbstractFileByPath(folder)) {
				await this.vault.createFolder(folder);
			}
		}
	}

	generateFilename(label: string): string {
		const now = new Date();
		const date = now.toISOString().slice(0, 10).replace(/-/g, '');
		const time = now.toTimeString().slice(0, 8).replace(/:/g, '');
		const slug = label
			.toLowerCase()
			.split(/\s+/)
			.slice(0, 5)
			.join('-')
			.replace(/[^a-z0-9-]/g, '');
		return `excerpt-${date}-${time}-${slug}.md`;
	}

	async createExcerpt(data: Omit<Excerpt, 'id' | 'created'>, imageData?: string): Promise<Excerpt> {
		if (!data.label.trim()) throw new Error('Label is required');
		if (!data.selectionText.trim() && !imageData) throw new Error('Selection text is required');

		await this.ensureFolders();

		const created  = new Date().toISOString();
		const filename = this.generateFilename(data.label);
		const id       = filename.replace(/\.md$/, '');
		const {excerptFolder} = this.plugin.settings;

		// Save PNG for image excerpts
		let imagePath: string | undefined;
		if (imageData) {
			const imgFolder = `${excerptFolder}/images`;
			if (!this.vault.getAbstractFileByPath(imgFolder)) {
				await this.vault.createFolder(imgFolder);
			}
			const imgFilename = `img-${id}.png`;
			imagePath = `${imgFolder}/${imgFilename}`;
			const binary = this.base64ToArrayBuffer(imageData);
			await this.vault.createBinary(imagePath, binary);
		}

		const fullExcerpt: Excerpt = {...data, id, created, ...(imagePath ? {imagePath} : {})};
		const content = this.buildFrontmatter(fullExcerpt) + '\n' + this.buildBody(fullExcerpt);

		try {
			await this.vault.create(`${excerptFolder}/${filename}`, content);
		} catch (err) {
			throw new Error(`Failed to create excerpt file: ${String(err)}`);
		}

		return fullExcerpt;
	}

	private base64ToArrayBuffer(base64: string): ArrayBuffer {
		const binary = atob(base64);
		const buffer = new ArrayBuffer(binary.length);
		const view   = new Uint8Array(buffer);
		for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
		return buffer;
	}

	readExcerpt(file: TFile): Excerpt | null {
		const cache = this.metadataCache.getFileCache(file);
		const fm = cache?.frontmatter;
		if (!fm || fm['type'] !== 'excerpt') return null;

		const relations: Relation[] = Array.isArray(fm['relations'])
			? (fm['relations'] as Record<string, unknown>[]).map(r => ({
				type: String(r['type'] ?? ''),
				target: String(r['target'] ?? '').replace(/^\[\[/, '').replace(/\]\]$/, ''),
				...(r['note']         !== undefined ? {note:       String(r['note'])}          : {}),
				...(r['rsl_link_id']  !== undefined ? {rslLinkId:  Number(r['rsl_link_id'])}   : {}),
			}))
			: [];

		const selectionRects: number[][] | undefined = Array.isArray(fm['selectionRects'])
			? (fm['selectionRects'] as unknown[]).map(row =>
				Array.isArray(row) ? (row as unknown[]).map(Number) : []
			)
			: undefined;

		return {
			id: file.basename,
			label: String(fm['label'] ?? ''),
			source: String(fm['source'] ?? '').replace(/^\[\[/, '').replace(/\]\]$/, ''),
			page: Number(fm['page'] ?? 0),
			selectionText: String(fm['selectionText'] ?? ''),
			...(fm['selectionRange'] !== undefined ? {selectionRange: String(fm['selectionRange'])}         : {}),
			...(selectionRects       !== undefined ? {selectionRects}                                       : {}),
			...(fm['imagePath']      !== undefined ? {imagePath:      String(fm['imagePath'])}              : {}),
			...(fm['rsl_selector_id'] !== undefined ? {rslSelectorId: Number(fm['rsl_selector_id'])}        : {}),
			created: String(fm['created'] ?? ''),
			tags: Array.isArray(fm['tags']) ? (fm['tags'] as unknown[]).map(String) : [],
			relations,
		};
	}

	listExcerpts(): Excerpt[] {
		const {excerptFolder} = this.plugin.settings;
		return this.vault.getMarkdownFiles()
			.filter(f => f.path.startsWith(excerptFolder + '/'))
			.map(f => this.readExcerpt(f))
			.filter((e): e is Excerpt => e !== null)
			.sort((a, b) => b.created.localeCompare(a.created));
	}

	listExcerptsBySource(sourcePath: string): Excerpt[] {
		return this.listExcerpts().filter(e => e.source === sourcePath);
	}

	async updateRelations(excerptId: string, relations: Relation[]): Promise<void> {
		const file = this.getExcerptFile(excerptId);
		const excerpt = this.readExcerpt(file);
		if (!excerpt) throw new Error(`Could not read excerpt: ${excerptId}`);

		const updatedExcerpt: Excerpt = {...excerpt, relations};
		await this.writeExcerpt(file, updatedExcerpt);
	}

	async removeRelation(excerptId: string, relationIndex: number): Promise<void> {
		const file = this.getExcerptFile(excerptId);
		const excerpt = this.readExcerpt(file);
		if (!excerpt) throw new Error(`Could not read excerpt: ${excerptId}`);

		const newRelations = excerpt.relations.filter((_, i) => i !== relationIndex);
		const updatedExcerpt: Excerpt = {...excerpt, relations: newRelations};
		await this.writeExcerpt(file, updatedExcerpt);
	}

	async updateExcerptMeta(excerptId: string, label: string, tags: string[]): Promise<void> {
		const file = this.getExcerptFile(excerptId);
		const excerpt = this.readExcerpt(file);
		if (!excerpt) throw new Error(`Could not read excerpt: ${excerptId}`);

		const updatedExcerpt: Excerpt = {...excerpt, label, tags};
		await this.writeExcerpt(file, updatedExcerpt);
	}

	async updateExcerptSource(excerptId: string, selectionText: string, selectionRange?: string): Promise<void> {
		const file = this.getExcerptFile(excerptId);
		const excerpt = this.readExcerpt(file);
		if (!excerpt) throw new Error(`Could not read excerpt: ${excerptId}`);

		const updatedExcerpt: Excerpt = {
			...excerpt,
			selectionText,
			selectionRange,
		};
		await this.writeExcerpt(file, updatedExcerpt);
	}

	// --- private helpers ---

	async updateExcerpt(excerptId: string, updated: Excerpt): Promise<void> {
		const file = this.getExcerptFile(excerptId);
		await this.writeExcerpt(file, updated);
	}

	async updateRslSelectorId(excerptId: string, rslSelectorId: number): Promise<void> {
		const file    = this.getExcerptFile(excerptId);
		const excerpt = this.readExcerpt(file);
		if (!excerpt) throw new Error(`Could not read excerpt: ${excerptId}`);
		await this.writeExcerpt(file, {...excerpt, rslSelectorId});
	}

	async deleteExcerpt(excerptId: string): Promise<void> {
		const file = this.getExcerptFile(excerptId);
		await this.vault.trash(file, false);
	}

	private getExcerptFile(excerptId: string): TFile {
		const {excerptFolder} = this.plugin.settings;
		const file = this.vault.getAbstractFileByPath(`${excerptFolder}/${excerptId}.md`);
		if (!(file instanceof TFile)) throw new Error(`Excerpt not found: ${excerptId}`);
		return file;
	}

	private async writeExcerpt(file: TFile, excerpt: Excerpt): Promise<void> {
		const content = this.buildFrontmatter(excerpt) + '\n' + this.buildBody(excerpt);
		try {
			await this.vault.modify(file, content);
		} catch (err) {
			throw new Error(`Failed to write excerpt file: ${String(err)}`);
		}
	}

	private buildFrontmatter(excerpt: Excerpt): string {
		const relationsYaml = excerpt.relations.length > 0
			? excerpt.relations.map(r =>
				`  - type: ${r.type}\n    target: "[[${r.target}]]"` +
				(r.note       ? `\n    note: "${r.note}"`             : '') +
				(r.rslLinkId  !== undefined ? `\n    rsl_link_id: ${r.rslLinkId}` : '')
			).join('\n')
			: '  []';

		const tagsYaml = excerpt.tags.length > 0
			? excerpt.tags.map(t => `  - ${t}`).join('\n')
			: '  []';

		const rectsYaml = excerpt.selectionRects && excerpt.selectionRects.length > 0
			? 'selectionRects:\n' + excerpt.selectionRects.map(r => `  - [${r.join(', ')}]`).join('\n')
			: null;

		const optionalFields = [
			excerpt.selectionRange !== undefined ? `selectionRange: "${excerpt.selectionRange}"` : null,
			rectsYaml,
			excerpt.imagePath      !== undefined ? `imagePath: "${excerpt.imagePath}"`           : null,
			excerpt.rslSelectorId  !== undefined ? `rsl_selector_id: ${excerpt.rslSelectorId}`  : null,
		].filter(Boolean).join('\n');

		// Use YAML literal block scalar (|) for selectionText to safely handle
		// multi-line strings and special characters without quoting issues.
		const selectionTextYaml = 'selectionText: |\n' +
			excerpt.selectionText.split('\n').map(l => `  ${l}`).join('\n');

		return [
			'---',
			'type: excerpt',
			`id: ${excerpt.id}`,
			`label: "${excerpt.label.replace(/"/g, '\\"')}"`,
			`source: "[[${excerpt.source}]]"`,
			`page: ${excerpt.page}`,
			selectionTextYaml,
			optionalFields,
			`created: ${excerpt.created}`,
			`tags:\n${tagsYaml}`,
			`relations:\n${relationsYaml}`,
			'---',
		].filter(s => s !== '').join('\n');
	}

	private buildBody(excerpt: Excerpt): string {
		const lines: string[] = [];

		if (this.plugin.settings.autoGenerateBody) {
			if (excerpt.imagePath) {
				lines.push(`![[${excerpt.imagePath}]]`);
				lines.push('');
			} else if (excerpt.selectionText) {
				lines.push(`> ${excerpt.selectionText.replace(/\n/g, '\n> ')}`);
				lines.push('');
			}
		}

		lines.push(`— *[[${excerpt.source}]], p. ${excerpt.page}*`);

		if (excerpt.relations.length > 0) {
			lines.push('');
			lines.push('## Relations');
			for (const rel of excerpt.relations) {
				lines.push(`- **${rel.type}** → [[${rel.target}]]`);
			}
		}

		return lines.join('\n');
	}
}
