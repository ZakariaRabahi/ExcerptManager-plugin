import {TFile, Notice} from 'obsidian';
import ExcerptManagerPlugin from '../main';

export class PdfNavigator {
	private plugin: ExcerptManagerPlugin;

	constructor(plugin: ExcerptManagerPlugin) {
		this.plugin = plugin;
	}

	async navigateToSource(pdfPath: string, page: number, selectionRange?: string): Promise<void> {
		const file = this.plugin.app.vault.getAbstractFileByPath(pdfPath);
		if (!(file instanceof TFile)) { new Notice(`PDF not found: ${pdfPath}`); return; }

		const subpath = selectionRange
			? `#page=${page}&selection=${selectionRange}`
			: `#page=${page}`;

		// If the PDF is already open in a leaf, openLinkText only focuses it
		// without re-applying the subpath. Call setEphemeralState directly instead —
		// that is the same internal call Obsidian makes when processing a link click.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const existing = this.plugin.app.workspace.getLeavesOfType('pdf')
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			.find(l => (l.view as any)?.file?.path === pdfPath);

		if (existing) {
			this.plugin.app.workspace.setActiveLeaf(existing, {focus: true});
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(existing.view as any).setEphemeralState?.({subpath});
		} else {
			// PDF not yet open — openLinkText opens it fresh and applies the subpath
			await this.plugin.app.workspace.openLinkText(pdfPath + subpath, '', false);
		}
	}

	async navigateFromExcerpt(excerptId: string): Promise<void> {
		const {excerptFolder} = this.plugin.settings;
		const excerptFile = this.plugin.app.vault.getAbstractFileByPath(
			`${excerptFolder}/${excerptId}.md`
		);
		if (!(excerptFile instanceof TFile)) {
			new Notice(`Excerpt not found: ${excerptId}`);
			return;
		}

		const cache = this.plugin.app.metadataCache.getFileCache(excerptFile);
		const fm = cache?.frontmatter;
		if (!fm || fm['type'] !== 'excerpt') {
			new Notice('Not an excerpt note.');
			return;
		}

		const page = Number(fm['page'] ?? 1);

		// source is stored as "[[papers/some-note]]" — strip the wikilink brackets
		const rawSource  = String(fm['source'] ?? '');
		const paperPath  = rawSource.replace(/^\[\[/, '').replace(/\]\]$/, '');
		if (!paperPath) {
			new Notice('Excerpt has no source.');
			return;
		}

		// Find the paper note (try with and without .md extension)
		const paperFile  =
			this.plugin.app.vault.getAbstractFileByPath(paperPath + '.md') ??
			this.plugin.app.vault.getAbstractFileByPath(paperPath);
		if (!(paperFile instanceof TFile)) {
			new Notice(`Paper note not found: ${paperPath}`);
			return;
		}

		const paper = this.plugin.paperStore.readPaper(paperFile);
		if (paper?.pdfPath) {
			const selectionRange = fm['selectionRange'] ? String(fm['selectionRange']) : undefined;
			await this.navigateToSource(paper.pdfPath, page, selectionRange);
		} else {
			// Source is not a paper with a PDF — open the source note directly
			await this.plugin.app.workspace.openLinkText(paperPath, '', false);
		}
	}
}
