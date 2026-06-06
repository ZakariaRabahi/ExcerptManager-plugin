import {MarkdownView, Notice, Plugin} from 'obsidian';
import {DEFAULT_SETTINGS, ExcerptManagerSettings} from "./core/types";
import {ExcerptManagerSettingTab} from "./settings";
import {ExcerptStore} from "./core/ExcerptStore";
import {PaperStore} from "./core/PaperStore";
import {PdfAnnotator} from "./pdf/PdfAnnotator";
import {PdfNavigator} from "./pdf/PdfNavigator";
import {ExcerptModal} from "./views/ExcerptModal";
import {WorkspaceView, VIEW_TYPE_WORKSPACE} from "./views/WorkspaceView";
import {ClaimStore} from "./core/ClaimStore";
import {RslApiClient} from "./core/RslApiClient";
import {RslSyncService} from "./core/RslSyncService";

export default class ExcerptManagerPlugin extends Plugin {
	settings: ExcerptManagerSettings;
	store: ExcerptStore;
	paperStore: PaperStore;
	claimStore: ClaimStore;
	pdfAnnotator: PdfAnnotator;
	pdfNavigator: PdfNavigator;
	rslSync: RslSyncService;

	async onload() {
		console.log('Excerpt Manager loaded');
		await this.loadSettings();
		this.registerView(VIEW_TYPE_WORKSPACE, (leaf) => new WorkspaceView(leaf, this));

		// Register hover-link source so our hover-link triggers are accepted by Obsidian
		this.registerHoverLinkSource('excerpt-manager', {
			display: 'Excerpt Manager',
			defaultMod: false,
		});

		this.store        = new ExcerptStore(this);
		this.paperStore   = new PaperStore(this);
		this.claimStore   = new ClaimStore(this);
		this.pdfAnnotator = new PdfAnnotator(this);
		this.pdfAnnotator.onCreateExcerpt = (data) => new ExcerptModal(this, data).open();
		this.pdfAnnotator.enable();
		this.pdfNavigator = new PdfNavigator(this);

		// RSL sync
		const rslApi   = new RslApiClient(this.settings.rslBaseUrl);
		this.rslSync   = new RslSyncService(rslApi, this);

		this.addSettingTab(new ExcerptManagerSettingTab(this.app, this));
		this.addRibbonIcon('book-open', 'Excerpt Workspace', () => void this.openWorkspace());

		// ── Commands ────────────────────────────────────────────────────────────

		this.addCommand({
			id: 'excerpt-manager:open-workspace',
			name: 'Open workspace',
			callback: () => void this.openWorkspace(),
		});

		this.addCommand({
			id: 'excerpt-manager:hello',
			name: 'Hello',
			callback: () => { new Notice('Excerpt Manager is running!'); },
		});

		this.addCommand({
			id: 'excerpt-manager:create-test-excerpt',
			name: 'Create test excerpt',
			checkCallback: (checking: boolean) => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view) return false;
				if (checking) return true;
				const file = view.file;
				if (!file) return false;
				const source = file.path.replace(/\.md$/, '');
				(async () => {
					try {
						const excerpt = await this.store.createExcerpt({
							label: 'Test excerpt from notes',
							source,
							page: 1,
							selectionText: 'this is a test',
							tags: ['test'],
							relations: [],
						});
						new Notice(`Created: ${this.settings.excerptFolder}/${excerpt.id}.md`);
					} catch (err) {
						new Notice(`Failed to create excerpt: ${String(err)}`);
					}
				})();
				return true;
			},
		});

		this.addCommand({
			id: 'excerpt-manager:create-from-note',
			name: 'Create excerpt from note selection',
			checkCallback: (checking: boolean) => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view?.file) return false;
				const fm = this.app.metadataCache.getFileCache(view.file)?.frontmatter;
				// Only for regular notes — not excerpt/paper/claim notes
				const type = fm?.['type'];
				if (type === 'excerpt' || type === 'paper' || type === 'claim') return false;
				const selection = view.editor.getSelection();
				if (!selection.trim()) return false;
				if (checking) return true;
				const sourcePath = view.file.path.replace(/\.md$/, '');
				new ExcerptModal(this, {text: selection, page: 0, sourcePath, sourceType: 'note'}).open();
				return true;
			},
		});

		this.addCommand({
			id: 'excerpt-manager:back-to-source',
			name: 'Back to source PDF',
			checkCallback: (checking: boolean) => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view?.file) return false;
				const fm = this.app.metadataCache.getFileCache(view.file)?.frontmatter;
				if (fm?.['type'] !== 'excerpt') return false;
				if (checking) return true;
				void this.pdfNavigator.navigateFromExcerpt(view.file.basename);
				return true;
			},
		});

		this.addCommand({
			id: 'excerpt-manager:create-test-paper',
			name: 'Create test paper',
			callback: async () => {
				try {
					const paper = await this.paperStore.findOrCreatePaper('pdfs/test-paper.pdf');
					new Notice(`Paper: ${this.settings.paperFolder}/${paper.id}.md`);
				} catch (err) {
					new Notice(`Failed to create paper: ${String(err)}`);
				}
			},
		});

		// ── RSL Sync Commands ────────────────────────────────────────────────────

		this.addCommand({
			id: 'excerpt-manager:rsl-test-connection',
			name: 'RSL: Test connection',
			callback: async () => {
				try {
					// Update client baseUrl in case setting was changed since load
					this.rslSync.api.baseUrl = this.settings.rslBaseUrl.replace(/#.*$/, '').replace(/\/$/, '');
					const ok = await this.rslSync.api.testConnection();
					new Notice(ok ? 'RSL: Connected ✓' : 'RSL: Unexpected server response');
				} catch (e) {
					new Notice(`RSL: Connection failed — ${String(e)}`);
				}
			},
		});

		this.addCommand({
			id: 'excerpt-manager:rsl-push-all',
			name: 'RSL: Push all to server',
			callback: async () => {
				new Notice('RSL: Pushing…');
				try {
					this.rslSync.api.baseUrl = this.settings.rslBaseUrl.replace(/#.*$/, '').replace(/\/$/, '');
					const counts = await this.rslSync.pushAll();
					new Notice(`RSL: Pushed — ${counts.papers} papers, ${counts.claims} claims, ${counts.excerpts} excerpts, ${counts.links} links${counts.failed ? ` (${counts.failed} failed)` : ''}`);
				} catch (e) {
					new Notice(`RSL push failed: ${String(e)}`);
				}
			},
		});

		this.addCommand({
			id: 'excerpt-manager:rsl-pull-all',
			name: 'RSL: Pull all from server',
			callback: async () => {
				new Notice('RSL: Pulling…');
				try {
					this.rslSync.api.baseUrl = this.settings.rslBaseUrl.replace(/#.*$/, '').replace(/\/$/, '');
					const counts = await this.rslSync.pullAll();
					new Notice(`RSL: Pulled — ${counts.papers} papers, ${counts.claims} claims, ${counts.excerpts} excerpts, ${counts.links} links${counts.failed ? ` (${counts.failed} failed)` : ''}`);
				} catch (e) {
					new Notice(`RSL pull failed: ${String(e)}`);
				}
			},
		});

		this.addCommand({
			id: 'excerpt-manager:rsl-push-current',
			name: 'RSL: Push current excerpt/paper',
			checkCallback: (checking: boolean) => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view?.file) return false;
				const fm = this.app.metadataCache.getFileCache(view.file)?.frontmatter;
				if (fm?.['type'] !== 'excerpt' && fm?.['type'] !== 'paper') return false;
				if (checking) return true;
				(async () => {
					this.rslSync.api.baseUrl = this.settings.rslBaseUrl.replace(/#.*$/, '').replace(/\/$/, '');
					if (fm['type'] === 'excerpt') {
						const excerpt = this.store.readExcerpt(view.file!);
						if (excerpt) { await this.rslSync.pushExcerpt(excerpt); new Notice('RSL: Excerpt pushed'); }
					} else {
						const paper = this.paperStore.readPaper(view.file!);
						if (paper) { await this.rslSync.pushPaper(paper); new Notice('RSL: Paper pushed'); }
					}
				})();
				return true;
			},
		});
	}

	onunload() {
		this.pdfAnnotator.disable();
		console.log('Excerpt Manager unloaded');
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<ExcerptManagerSettings>);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async openWorkspace() {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_WORKSPACE);
		if (existing.length > 0 && existing[0]) {
			this.app.workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf(true);
		await leaf.setViewState({type: VIEW_TYPE_WORKSPACE, active: true});
		this.app.workspace.revealLeaf(leaf);
	}
}
